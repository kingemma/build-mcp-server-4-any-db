# GraphJin source 模式迁移

> 阶段 0 事实基线：本机实测（Windows x64，GraphJin v3.21.14，2026-10-20）。
> 复现脚本全部在 `.probe/`，命令见文末。

## 1. 阶段划分

| 阶段 | 内容 | 状态 |
|:---|:---|:---|
| 0 | 事实基线：source 模式能表达什么、不能表达什么 | 已完成 |
| 1 | 配置生成 source 化：`project.js` 模板、`graphjin.js` 读写通道、旧项目迁移 | 已完成 |
| 2 | 权限模型映射：`permissions.js` 由 `roles[].tables` 改为 `sources[].access` + `grants` | 已完成（决策 A） |
| 3 | 写侧兜底：表级写开关在 source 模式下无对应结构 | 决策 A：不做兜底，写/删降级为 source 级 |
| 4 | 前端适配：权限矩阵改版、源级访问面板、降级提示 | 已完成 |
| 5 | 端到端回归：`verify:e2e` / `verify:migration` / `npm run build` | 已完成（24 + 9 项） |

## 2. 实测结论

### 2.1 身份与读权限：source 模式可完全替代 legacy

`X-User-Role` + `header_variables`（`X-User-Code` → `$user_code`）在 source 模式下照常工作，
不需要 JWT / agentic 也能拿到角色与行级过滤。

```
PASS  X-User-Role + $user_code 过滤生效  — 3 行
PASS  无身份被拒  — unauthorized: table orders is blocked for role anon
PASS  admin 看到全部 4 行
```

JWT 通道同样可用（`mode: agentic` + `auth.type: jwt`）：JWT 的 `roles` claim 解析为角色、
`sub` 可喂给 `access.owner_column` / `grants[].filter`，MCP `execute_graphql` 也带身份。

```
PASS  source 模式：user-a 只看到自己的 3 行
PASS  source 模式：列白名单生效  — db column blocked: internal_note (role: 'customer')
PASS  source 模式：MCP 也按 JWT 身份过滤（网关可去掉）
```

> 注意：无身份时 HTTP 仍是 200，拦截体现在 `errors[0].message`，探针不能只看状态码。

### 2.2 写权限：三个缺口

配置：`access.read/write/delete: owner` + `owner_column: owner_code` + `grants[].columns` 白名单。
实测 9 项，3 项失败：

| 用例 | 结果 |
|:---|:---|
| 改自己的行 | PASS |
| 改别人的行 | PASS（0 行，静默不报错） |
| 插入自己的行 | PASS |
| **插入别人的行** | **FAIL：成功写入 `owner_code=user-b` 的行** |
| 删别人的行 | PASS（0 行） |
| 删自己的行 | PASS |
| **插入未授权列** | **FAIL：`internal_note` 不在 grants 里，仍写入成功** |
| **更新未授权列** | **FAIL：同样成功** |
| MCP 写入受 owner 约束 | PASS |

结论：`grants[].columns` **只约束读**；`access.write: owner` 只负责「行归属过滤」和
「insert 未填 owner 时自动填当前身份」，**不校验客户端显式传入的 owner 值**。

### 2.2b 读侧表级语义：grants 是加法，不是白名单

这是最容易踩错的一条，直接影响权限矩阵的映射：

| 写法 | 实测行为 |
|:---|:---|
| `access.read: authenticated` + 某角色有 grants | 只对 grants 里的表加列白名单 / 行过滤 |
| grants 未列出的表 | **完全可读**（全部列、无过滤），不是「不可读」 |
| `grants[].columns: []` | 配置直接被拒：`columns is required` |
| `grants[].filter` 恒假 | 数据返回 0 行，但表结构/列仍可见 |
| `blocked_tables` | 该表对**所有人**（含 admin）不可读：`table blocked` |
| `admin_tables` | 该表仅 admin 可读，其他角色报 `blocked for role xxx` |
| `access.read: blocked` | 整个 source 不加载：`GraphJin not initialized - no database configured` |

结论：source 模式**没有「角色 × 表」的可见性**，只有三档：
公开（任何已认证角色）、仅 admin、全局屏蔽。角色之间只能靠列白名单和行过滤区分。

### 2.3 `sources` 与 legacy 结构互斥，且是启动级致命错误

```
FATAL  roles["customer"].tables is legacy table access config and is not supported when
       sources is configured; use sources[].access;
       next_action: query_catalog(search: "migrate legacy roles tables to source access")
```

`databases:` 也不能与 `sources:` 并存：

```
FATAL  databases is legacy database-only config; move SQL/CodeSQL providers to sources
```

不是「写入时被拒」，而是**进程起不来**。所以 `project.js` 里那套 569 行的
`databases:` 文本合并器必须改造，没有「先共存再切换」的过渡路径；迁移只能原子完成。

### 2.4 source 模式的配置写入没有真正的 preview

`update_current_config`（MCP）与 `gj_config`（GraphQL）传 `mode: "preview"` 都会立即落盘：

```
preview → {"success":true,"message":"Configuration updated and reloaded successfully",
           "changes":[... "configuration saved to disk"],"scope":"core","reload_mode":"hot"}
preview 未落盘 = FAIL（1 条 source 已生效）
```

工具 schema 与官方 recipe 都声称 source 模式支持 preview/apply + `preview_id`，
但 3.21.14 的 `sources` 属 core scope，改动即时生效；`preview_id` 始终为 `null`。
更矛盾的是：`mode: "apply"` 缺 `preview_id` 时会被拒——
`source-mode config apply requires preview_id`，而 preview 又永远不返回它。
官方 recipe 的 `preview_required` 描述与实测不符。

**影响**：迁移后仍要沿用现在的「平台侧自算 diff + 二次确认 + 写入前快照」，
不能指望 GraphJin 的两阶段保护；`permissions.apply` 只能继续用不带 `mode` 的裸写入。

### 2.4b 配置写入的五个坑（阶段 1 实测）

1. `source_patches` 只更新 `read/write/delete/owner_column` 等标量，**`access.grants` 被静默忽略**；
   要改 grants 只能整份替换 `sources`。
2. 整份 `sources` 替换时 `access` 是**合并**写入：不显式传 `grants: []`，旧 grants 不会被清掉，
   删角色时会报 `role "xxx" is not defined in roles`。
3. 回滚顺序必须是「先写 sources（清 grants）→ 再 remove_roles」。
4. 写 `sources` 时 GraphJin 会把 `databases` 从文件里删掉，但内存里仍保留旧库，
   此时 `remove_databases` 会 reload 失败（`database app not found`）。
5. source 模式下 `get_current_config` 会派生出一个 `databases` 字段，不能用它判断
   「文件里还有 legacy databases」——否则正常项目会被误判。

### 2.5 官方 recipe 的迁移口径

`query_catalog(search: "migrate legacy roles tables to source access")` 返回
`recipe.config.migrate_legacy_roles_tables`，要点：

- 迁移目标：source 级 `access` 默认值 + `public_tables / admin_tables / blocked_tables` 分类 + `grants`。
- 明令禁止：source 模式下继续使用 `roles[].tables` 的 filters / presets / columns / block 规则。
- 停止条件之一：`legacy role table rule cannot be expressed by source access defaults or classifications`。

即官方也承认存在表达不了的情况。当前产品的「角色 × 表 × 四项开关」正属于这一类。

## 3. 能力对照

| 能力 | legacy（现状） | source |
|:---|:---|:---|
| 连接配置 | `databases:` map | `sources:` 数组 |
| 表级 query 开关（按角色） | `roles[].tables[].query.block` | **无**：只有公开 / 仅 admin / 全局屏蔽三档 |
| 表级 insert/update/delete 开关 | 四项独立 | **无**，只有 source 级 `write` / `delete` |
| 读列白名单 | `query.columns` | `grants[].columns`（生效） |
| 写列白名单 | `update.columns` 等 | **不生效**（实测） |
| 行级过滤 | `filters`（`$user_code`） | `grants[].filter` + `access.owner_column` |
| 角色来源 | `X-User-Role` | `X-User-Role` 或 JWT claim |
| 配置写入 | 立即生效 | 立即生效（无 preview） |
| 官方风险评级 | `risk_level: high`（未来可能移除） | 推荐路径 |

## 4. 迁移映射（草案）

| legacy | source |
|:---|:---|
| `databases.<name>` | `sources[{ name, kind: database, type, ... }]`（整体替换，须带全连接字段） |
| `RoleTable.query.block = true`（某角色） | **无对应**；只能降级成恒假 filter（数据结构仍可见），或全表 `admin_tables` / `blocked_tables` |
| `RoleTable.query.columns` | `sources[].access.grants[].columns` |
| `RoleTable.query.filters` | `grants[].filter`（`$user_code` 继续可用） |
| `RoleTable.insert/update/delete.block` | **无对应**：升到 source 级 `write` / `delete` |
| `RoleTable.query.limit` | **无对应**，需平台侧提示或丢弃 |

## 5. 阶段 1 实施记录（已完成）

| 文件 | 改动 |
|:---|:---|
| `src/project.js` | 模板改 `sources:`；`renderSource` / `mergeSourceBlock`（按条目原地改连接字段、保留 access）；`readSourceConnections` 读回真实密码；删除 `databases:` 相关的 flow-map 解析器 |
| `src/migrate.js`（新增） | `isLegacyConfig` / `readLegacyDatabases` / `normalizeRole` / `migrateLegacyProject`：三次配置 API 调用完成迁移，失败时用 `.bak` 回滚 |
| `src/permissions.js` | 新增 `buildSourceAccessConfig` / `summarizeSourceAccess` / `migrateLegacyRoleTables`；legacy 生成器仅保留给迁移读取 |
| `src/graphjin.js` | `assertLegacyMode` → `assertSourceMode`；`updateConfig` 按模式自动走 preview/apply；`readCatalogRevision` 走 GraphQL |
| `src/snapshots.js` | 快照增加 `source_access_json` / `source_count`（旧库自动加列）；回滚补丁支持 `source_patches` |
| `src/index.js` | `permissions.*` 改 source 形态；`graphjin.databases` 读 sources；`permissions.apply` 整份替换 sources（`source_patches` 会丢 grants） |
| `src/supervisor.js` | legacy 项目先起临时实例迁移，再按新配置重启；失败回滚 `.bak` |
| `scripts/verify-source-migration.js`（新增） | 迁移全链路验证（9 项） |
| `scripts/verify-e2e.js` | 断言改为 source 语义（24 项） |

已删除：`scripts/verify-plan-b.js`、`scripts/verify-columns.js`（被 e2e 覆盖）。
`scripts/verify-identity.js` 仍是 legacy 夹具，未迁移。

**前端（阶段 4）**

- `src/utils/policy.js`：`OPERATIONS` 只剩 `query`；新增 `normalizeSourceAccesses` /
  `emptySourceAccess` / `toAccessPayload`，`normalizeCurrentRoles` 改读 `sources[].access.grants`。
- `src/stores/app.js`：新增 `sourceAccess` / `currentSourceAccess` / `configRoles`；
  `permissions.apply` 同时提交矩阵与源级 access。
- `src/views/PermissionsView.vue`：新增「数据源访问」面板（读/写/删档位、owner 列、
  仅管理员/全局屏蔽表）；矩阵只剩「读取」，编辑器移除 limit（grants 无此字段）。
- 降级提示：面板内注明「写入/删除为数据源级」「未列入规则的表对已认证角色完全可读」。

## 6. 决策记录

- **D1 = A（2026-10-20）**：接受降级。写/删只到 source 级；表级可见性只剩
  公开 / 仅 admin / 全局屏蔽；角色差异靠列白名单与行过滤。因此表级写开关与
  「按角色屏蔽表」从产品里移除。
- **D2 = 自动改写 + 快照回滚（2026-10-20）**：`dev.yml` 原文件备份为
  `dev.yml.legacy-<时间戳>.bak`，迁移失败自动还原。

## 7. 复现命令

```bash
node .probe/verify-source-mode.js            # 读权限 + JWT/Header 身份
GJ_MODE=dev node .probe/verify-source-mode.js # 同上的 dev 模式变体
node .probe/verify-source-write.js           # source 模式写粒度（9 项）
node .probe/verify-source-header-identity.js # header 身份是否可替代 JWT
node .probe/verify-source-config-write.js    # MCP 配置写入（preview 实测无效）
node .probe/verify-source-gj-config.js       # GraphQL gj_config 写入
node .probe/verify-write-mode.js             # sources + roles[].tables 共存 → FATAL（刻意非零退出）
node .probe/probe-source-migration.js        # 拉取官方 recipe 到 source-migration-recipe.json
node .probe/verify-source-coexist.js         # databases + sources 共存 → FATAL（刻意非零退出）
```

Windows PowerShell 设置环境变量用 `$env:GJ_MODE='dev'`。
除 `verify-write-mode.js`（用于复现 FATAL）外，上述脚本失败项为 0。
