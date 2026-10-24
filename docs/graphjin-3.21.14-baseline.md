# GraphJin v3.21.14 事实基线

> 本文所有结论均由本机实测得出（Windows x64，2026-10-16），不是推测。
> 复现脚本见 `.probe/`（`mcp.ps1`、`probe-config.ps1`、`probe-grants.ps1`）。
> 用途：作为 Plan.md 修订与阶段 1/2 编码的事实依据。

## 1. 上游与发布产物

| 项 | 实测结果 |
|:---|:---|
| 仓库 | `dosco/graphjin`，未归档，默认分支 `master`，Apache-2.0，3213 stars |
| 最新 release | **v3.21.14**（2026-10-15T14:09:01Z），commit `67d9ce9c`，Go 1.25.5 |
| 发布节奏 | v3.21.10→v3.21.14 在 5 天内连发，迭代很快 |
| 产物命名 | `graphjin_<ver>_<os>_<arch>.tar.gz` / `.deb` / `.rpm` |
| 平台覆盖 | `os ∈ {darwin, linux, windows}` × `arch ∈ {amd64, arm64}` |

**与 Plan.md 的冲突**：Plan 假设产物名是 Rust 目标三元组（`graphjin-x86_64-pc-windows-msvc.exe`）。
官方**不按三元组发布**，三元组命名只在 Tauri sidecar 侧需要。因此
`prepare-binaries.js` 的 `TRIPLE_MAP` 只能用于**重命名**，不能用于**下载**；
`graphjin_updater.rs` 里 `graphjin_{ver}_{triple}.tar.gz` 的拼法取不到文件。

每个 release 都带 `checksums.txt` 与 `checksums.txt.sig`，实测 SHA256 校验通过。

**二进制体积（重要）**：Windows `tar.gz` 47.67 MB，**解压后 `graphjin.exe` = 166,345,216 B（约 158.6 MiB）**。
Plan 未考虑这一点：全平台入库 + 打进安装包会造成体积失控，见 §9。

## 2. CLI 命令面

```
graphjin [--path <dir>] <command>
  serve    Run the GraphJin service         (子命令 new / db / test；flag --demo)
  mcp      MCP stdio 服务器                 (子命令 setup / info / add)
  cli      对运行中的服务发 MCP HTTP/JSON-RPC 命令
  config   离线读写本地配置文件             (get/set/unset/explain/validate/schema/docs)
  eval / env / version / completion
```

关键能力：

- `graphjin config schema` 直接输出**配置 JSON Schema**（74 KB，`$defs` 覆盖全部配置项）——
  这是前端表单与后端校验可以复用的权威来源，不必手写。
- `graphjin config docs dev|prod|agentic` 输出带注释的示例配置。
- `graphjin config set/get/unset` 直接编辑 `<path>/<env>.yml`，**保留注释**；
  `<env>` 由 `GO_ENV` 决定（dev / prod / agentic，默认 dev）。
- `graphjin serve --demo` 起内置 SQLite 示例（saas-ops），**无需容器**。

## 3. 运行时端点

实测 `graphjin serve --demo` 启动横幅：

```
GraphJin started app-name=SaaS Ops Demo env=agentic host-port=0.0.0.0:8083
                mcp-mode=enabled production=false version=3.21.14

  Web UI:   http://localhost:8083/
  GraphQL:  http://localhost:8083/api/v1/graphql
  REST API: http://localhost:8083/api/v1/rest/<name>
  MCP:      http://localhost:8083/api/v1/mcp
```

**端口不是固定的 8080**（demo 实测 8083）。平台不能硬编码端口，必须解析启动横幅/日志。

## 4. MCP 传输（平台必须自己实现）

| 约束 | 实测行为 |
|:---|:---|
| Accept 头 | 必须同时含 `application/json` 与 `text/event-stream`，否则 HTTP 400 |
| 响应格式 | 恒为 SSE（`Content-Type: text/event-stream`），需解析 `data: ` 帧 |
| 会话 | `initialize` 响应头下发 `Mcp-Session-Id`，后续请求必须回传 |
| 握手顺序 | `initialize` → `notifications/initialized` → 其它方法 |
| 漏掉会话 | 报 `method "xxx" is invalid during session initialization` |
| 协议版本 | `2025-06-18`，`serverInfo: graphjin/3.21.14` |
| 能力 | `resources{listChanged,subscribe}`、`tools{listChanged}` |

## 5. 身份、角色与权限门禁

- MCP HTTP 端点认 **`X-User-Role: admin`** 请求头（dev / `auth.development: true` 下生效）。
- GraphQL HTTP 端点**不认**该头：实测仍为 anon，
  `{"errors":[{"message":"unauthorized: Query blocked: gj_config (role: anon)"}]}`。
  想走 GraphQL root 需要真正的 JWT（`identity.role_claims: ["roles"]`）。
- 配置类能力受双重开关控制：
  - `system.root_access.gj_config: admin`
  - `system.capabilities.config.write: true`
- `mcp.allow_config_updates: true` 才会注册配置工具。

### 工具面随开关/角色变化（实测 `tools/list`）

| 条件 | 可用工具 |
|:---|:---|
| 默认（匿名） | `ask_graphjin_agent, execute_graphql, execute_saved_query, graphql_help, query_catalog, validate_where_clause` |
| `+ mcp.allow_config_updates: true` | 追加 `validate_config` |
| `+ X-User-Role: admin` | 追加 `get_current_config, update_current_config` |
| `--demo` 模式 | **即使 admin 也不出现配置类工具**（demo 强制策略） |

> 结论：平台必须用 `serve --path <项目目录>` 自建项目，不能用 `--demo` 做配置编排。

`cli` 文档里提到的 `list_tables / describe_table / explore_relationships / find_path /
audit_role_permissions` 在 v3.21.14 实测**未出现在 tools/list**（启用条件待查）。

## 6. 配置模型（对 Plan 的关键修正）

### 6.1 `sources[].access`

```yaml
sources:
  - name: app
    kind: database
    access:
      read: authenticated        # public | authenticated | account | blocked
      write: blocked
      delete: blocked
      namespace_column: account_id
      owner_column: user_id
      missing_namespace_column: block   # block | allow
      public_tables: []
      admin_tables: []
      blocked_tables: []
      grants:
        - role: analyst
          tables:
            - name: accounts
              columns: [id, name]
              filter: '{ id: { _gt: 0 } }'
```

### 6.2 `roles[].tables[]`（细粒度，但在 source mode 下被拒）

`RoleTable` 支持 `query / insert / update / upsert / delete`，各有 `filters / columns /
presets / block / limit`。**这才是能表达「每表四项操作开关」的结构。**

但配置了 `sources` 之后实测被拒，错误原文：

```
roles["analyst"].tables is legacy table access config and is not supported
when sources is configured; use sources[].access;
next_action: query_catalog(search: "migrate legacy roles tables to source access")
```

✅ **Plan 的这条论断是对的**（“source mode 拒绝手写的 `roles[].tables`”）。

### 6.3 由此产生的最大设计风险

`grants` 的每一项只有 `role → tables[] → {columns, filter}`，
**没有 query / insert / update / delete 的操作级开关**。

也就是说：Plan 承诺的「**角色 × 表 × 只读/读写/更新/删除 四项开关**」权限矩阵，
在 v3.21.14 的 source mode 下**无法直接表达**。可行粒度只有：

- 源级：`read/write/delete` ∈ {public, authenticated, account, blocked}
- 表级：`public_tables` / `admin_tables` / `blocked_tables`
- 角色×表级：`columns` 白名单 + `filter` 行过滤

### 6.4 方案 B 已实测通过（2026-10-16 决策采用）

选择**放弃 `sources`、改用 `databases` + `roles[].tables`**，实测端到端跑通：

```yaml
databases:
  app:
    type: sqlite
    path: app.db
    default: true
roles:
  - name: analyst
    tables:
      - name: accounts
        database: app          # 缺这个字段会落到 __gj_internal_artifacts
        query:
          limit: 10
          filters: ['{ id: { _gt: 0 } }']
          block: false
        insert: { block: true }
        update: { block: true }
        delete: { block: true }
```

调用 `update_current_config` 后返回 `success: true` 且完整落盘，四项开关写入正确。

**三条硬约束（踩坑记录）**：

1. **必须用 `databases:` map，不能用单数 `database:`** ——
   单数形式下调用 `update_current_config` 触发服务端
   `panic: assignment to entry in nil map`（`serv/mcp_config.go:3287`），**进程直接退出**。
   补 `artifacts:` 块不能解决。
2. **`RoleTable.database` 必须填库名** ——
   否则规则挂到内部库 `__gj_internal_artifacts` 上，报
   `add roles failed: table not found: main.<table>`。
3. **legacy 模式没有 preview/apply 两阶段** ——
   即使传 `mode: "preview"` 也**立即生效并返回 success**，不返回 `preview_id`。
   平台侧必须自行算 diff 与二次确认，并保留写入前快照用于回滚。

### 6.5 方案 B 的运行时行为（16 项断言全部通过）

验证脚本 `sidecar-backend/scripts/verify-plan-b.js` 自建双库 SQLite 项目、
拉起真实 GraphJin、写入角色权限后以不同角色执行查询与变更。实测结果：

| 场景 | 实际行为 |
|:---|:---|
| insert / update / delete 被拦 | 返回 `errors`，文案 `Insert blocked: <table> (role: <role>)`（`Update`/`Delete` 同构） |
| **query 被拦** | **不报错**，`next.state_code` 仍是 `graphql_execution_success`，只是 `data.<root>` 为 `null` |
| 行过滤 `filters` | 生效，只返回满足条件的行 |
| **`query.limit`** | **只是默认值，不是强制上限** —— 查询显式写 `limit: 50` 时会覆盖角色的 `limit: 2` |
| 角色未在 `roles` 中定义 | 报错 `roles '<role>' not defined in c.gj.config`（**包括 `admin`**） |
| 多库 | `RoleTable.database` 正确把规则路由到指定库 |

> **平台影响**：
> - 前端不能把角色的 `limit` 宣传成「最多返回 N 行」，它只是不带 limit 时的默认值；
> - 判断查询是否被拦截要看 `data.<root> === null`，不能只看 `errors`；
> - 平台若要以 `admin` 角色执行 GraphQL，必须在 `roles` 里显式定义 `admin`。

### 6.5.1 「没写 grant」不等于拒绝（2026-10-24 实测）

source 模式下 `sources[].access.read: authenticated` 的含义是**任何已认证角色都能读**。
`grants` 只给被点名的角色加 `columns` 白名单与 `filter`；**没被点名的角色不是被挡，而是
拿不到任何限制** —— 权限比点名角色更大。实测（双库演示项目）：

| 查询 | 结果 |
|:---|:---|
| `finance_analyst` 查本库 `vouchers`（grant + `owner_code` 行过滤） | 14 行（admin 40 行） |
| `inventory_viewer` 查财务库 `vouchers`（财务库 grants 里没有它） | **5 行全给**，无过滤 |
| 给它补一份 `filter: '{ owner_code: { _eq: "__not_granted__" } }'` 的 grant | **0 行** |

> **平台影响**：
> - 这条与 `permissions.js` 里已有的判断一致（`grants` 是加法不是白名单），本次补的是
>   **跨库 / 跨角色**的实测后果：没点名的角色在别的库同样不受限制；
> - 不能用「不给某角色写 grant」表达「该角色看不到这个库」，效果正好相反；
> - 表达拒绝只有两条路：源级 `read: blocked`（对所有人生效），或给该角色一份**恒不成立
>   的 filter**（按角色生效，返回 0 行而不是报错）——演示项目用的就是后者。

### 6.6 列管控 `columns` 的真实语义（5 项断言全部通过）

验证脚本 `sidecar-backend/scripts/verify-columns.js`（单库 SQLite，真实拉起进程）：

| 场景 | 实际行为 |
|:---|:---|
| `columns: ["id","name"]`（数组） | 接受，语义是**白名单**，只有列出的列可查 |
| 查询白名单之外的列 | **报错**（不是静默）：`db column blocked: plan (role: 'col_allow')`，`next.state_code = graphql_execution_error` |
| `columns: { allow: [...] }` | **被拒**：`.../query/properties/columns: type: map[allow:[id name]] has type "object", want "array"` |
| `columns: { block: [...] }` | **被拒**，同上（`want "array"`） |
| 阻止列表的等价写法 | 只能写**补集白名单**（全部列减去要屏蔽的列），实测屏蔽 `mrr_cents` 后查询报 `db column blocked: mrr_cents` |

> **平台影响**：
> - UI 的「阻止列表」必须在写入前展开成补集白名单，且依赖 Schema 已发现的列清单；
> - 列被屏蔽时客户端会收到错误而不是空值，前端提示文案要照实写。

**`get_current_config` 的形态（2.7 策略预览依据）**：

- 顶层键：`active_database / databases / mcp / metadata / next / roles / system / workflows`，
  **没有 `gj_security`** —— 该 root 走 `/api/v1/graphql` 且需 admin JWT，实测不可达，
  所以「当前生效策略」的真相来源是 `get_current_config` 的 `roles`。
- `roles[]` 是 **Go 结构体直出**，键大小写不统一：
  `tables[].Name` / `Query{ Block, Columns, Filters, Limit, disable_functions }` /
  `Insert` / `Update` / `Delete` / `Upsert` 为大写，而 `database` / `read_only` 是小写。
  归一化必须做大小写不敏感取值。

**代价**：GraphJin 官方把这条路径标为 `risk_level: high`
（catalog 中存在 `recipe.config.migrate_legacy_roles_tables`，
摘要为「用 source-level access 取代 legacy roles[].tables」），未来版本可能移除。

## 7. 配置读写 API（端到端实测通过）

### 7.1 `get_current_config`

- 入参 `section`：`sources / system / workflows / databases / relationships / metadata /
  tables / roles / blocklist / functions / resolvers / mcp / all`
- 返回脱敏 JSON（密码等为 `[REDACTED]`），顶层含
  `active_database, databases, mcp, metadata, next, roles, sources, system, workflows`
- `next` 字段会给出下一步建议工具与 `args_template`，可用于驱动 UI 引导

### 7.2 `update_current_config`

参数全集：`blocklist, create_if_not_exists, databases, expected_catalog_revision,
functions, mode, preview_id, remove_*(6 个), resolvers, roles, serv, source_patches,
sources, system, tables, update_saved_queries, update_sources, workflows`

### 7.3 preview → apply 三步流程（已跑通）

1. **取 revision**：不带 `expected_catalog_revision` 调 preview，
   错误响应里直接返回 `catalog_revision`。
2. **preview**：带 revision 重发 → 返回
   `preview_id`（前缀 `cfgprev_`）、`expires_at`（10 分钟）、`changes`、`findings_json`。
3. **apply**：**完全相同的 payload** + `expected_catalog_revision` + `preview_id`
   → `"applied": true`，`configuration saved to disk`，热重载成功。

实测成功样例：

```
preview: {"success": true, "preview_id": "cfgprev_e409f7072b9d13dc9b16a0f2258c2f9d",
          "changes": ["updated sources"]}
apply:   {"success": true, "message": "Configuration updated and reloaded successfully",
          "changes": [... "configuration saved to disk"], "applied": true}
```

### 7.4 踩过的四个坑（平台实现必须处理）

1. `sources[]` 是**整体替换**，补丁必须带完整连接字段
   （`name / kind / type / path / default`），否则报 `database connection failed`。
2. `grants` 引用的 role 必须**先已存在**：校验针对的是当前已生效的 roles，
   与「新建角色」同批提交会被拒（需两步：先建角色，再挂 grants）。
3. grants 授予读权限前，`access.read` 必须允许该表，否则
   `role "analyst" cannot read table "accounts": read access is blocked for this table`。
4. apply 成功后 GraphJin 会把**规范化后的完整配置写回** `<env>.yml`
   （展开全部默认值、键名小写化、补 `roles[].tables: []` 等）。
   平台若自己写 YAML，要预期文件被重写。

## 8. 已确认的 CLI 缺陷（直接影响平台实现）

1. 启动横幅给的 Claude Desktop 配置是
   `"args": ["mcp", "--server", "http://localhost:8083"]`，
   但 v3.21.14 的 `graphjin mcp` **没有 `--server` flag**（`unknown flag: --server`）。
   → 平台不能照抄横幅，应自己生成客户端配置。
2. `graphjin mcp` 的 proxy 模式 POST 到旧版 SSE 路径 `/api/v1/mcp/message`
   且未带正确 Accept → 400 →
   `graphjin cli` 的**全部**子命令失败
   （`method "tools/call" is invalid during session initialization`）。
   → **不要依赖内置 `cli` / `mcp` proxy**，平台自己直连 `/api/v1/mcp` 实现 MCP 客户端。

## 9. 对 Plan.md 的修订要求

| Plan 原文 | 修订 |
|:---|:---|
| 内置版本 `v3.20.74` | `v3.21.14` |
| 产物按 Rust 三元组命名 | 官方按 `<os>_<arch>`；三元组仅用于 sidecar 重命名 |
| `graphjin-binaries/` 存 5 个平台二进制 | 单平台解压后 158.6 MiB，全平台近 800 MB；见下 |
| `buildSourceAccessConfig()` 生成 `{role, resource, access[], filters, columns:{allow,block}}` | 实际应为 `grants: [{role, tables:[{name, columns, filter}]}]` |
| 权限矩阵四项操作开关 | 已决策采用**方案 B**（§6.4）：不配 `sources`，走 `databases` + `roles[].tables` |
| Node 后端用 HTTP 调 `/api/v1/graphql` 的 `gj_config` | 改用 MCP `get_current_config / update_current_config`（GraphQL root 需 JWT，dev 头不生效） |
| `graphjin mcp info` 生成客户端配置 | 该子命令仍可用，但横幅里的 `--server` 参数是错的 |

**二进制入库策略**（用户已确认按 Plan 原样入库）：建议仓库内只保存**压缩态**
`*.tar.gz`（各 42–48 MB，全平台约 230 MB），构建时解压重命名，
避免把 800 MB 的解压产物提交进 git。

## 10. 仍未验证（阶段 0/1 需补）

### 11. catalog（query_catalog）实测形态

入参：`where`（支持 `eq/neq/in/nin/like/ilike/regex/iregex/contains/is_null/and/or/not`，字段
`kind / title / database_name / table_name / created_at / updated_at`）、`search`、
`limit`（默认 100，上限 500）、`offset`、`order_by`、`id`/`ids`（取详情）、
以及 `kind`/`database`/`schema`/`table`/`column` 这些**兼容简写**（官方建议新调用方直接用 `where`）。

返回：`{ generated_at, revision, count, limit, truncated, cards: [...] }`。
`truncated` 为 true 时必须按 `offset` 翻页。

三类卡片：

| kind | 关键字段 |
|:---|:---|
| `table` | `evidence_json`：`{DatabaseName, SchemaName, TableName, PrimaryKey, ColumnCount, Comment}`；`details_json[].data_json.columns` 含**完整列定义** |
| `column` | `evidence_json`：`{TableName, ColumnName, Type, Array, NotNull, PrimaryKey, UniqueKey, Indexed, Ordinal, DefaultValue, Comment}` |
| `relationship` | `evidence_json`：`{FromDatabaseName, FromSchemaName, FromTableName, FromColumnName, ToDatabaseName, ToSchemaName, ToTableName, ToColumnName, RelType, IsCrossDatabase, Source}` |

注意：column / relationship 卡片的 `details_json` 为 `null`，只有 table 卡片带列清单。

### 未验证

- `audit_role_permissions`、`list_tables` 等 dev tools 的启用条件
- `gj_security` / `gj_catalog` 的 GraphQL 查询语法（需 admin JWT 才能绕过 anon 拦截）
- 非 Windows 平台的二进制可用性
- Tauri 2 的 sidecar shell 权限写法（`shell:allow-execute` 是否已废弃）

## 12. 支持的数据库类型（真机实测）

实测手段：对同一个运行中的实例调 MCP 工具 `validate_config`，逐个喂
`databases.<name>.type`，读错误原文（`.probe/db-types.js` / `db-types2.js`）。

### 12.1 配置白名单（13 种）

喂一个不存在的类型，错误原文给出完整清单：

```
unsupported database type "zzz": supported types are
postgres, mysql, mariadb, sqlite, oracle, mongodb, mssql,
snowflake, bigquery, redshift, nanodb, cassandra, clickhouse
```

不在清单内的写法会被直接拒绝（`postgresql` / `pgsql` / `sqlserver` / `sqlite3` /
`redis` / `duckdb` / `db2` / `cockroachdb` / `tidb` 全部实测被拒）。
所以「兼容 CockroachDB / TiDB」只能走 `postgres` 或 `mysql` 协议，不能写它自己的名字。

### 12.2 白名单 ≠ 驱动已实现

连接层另有自己的实现判断，这几类**通过了 schema 校验但连不上**：

| type | 连接层行为 |
|:---|:---|
| `clickhouse` | `connection failed: unsupported database type: clickhouse` |
| `redshift` | `connection failed: unsupported database type: redshift` |
| `bigquery` | `connection failed: unsupported database type: bigquery` |
| `nanodb` / `cassandra` | 未实机验证，按同类现象推定 |

已确认能走通到「尝试建立连接」的：`postgres` / `mysql` / `mariadb` / `mssql` /
`oracle` / `mongodb` / `sqlite`（失败原因都只是目标地址不可达，说明驱动存在）。

### 12.3 各类型的必填字段

| type | 约束（错误原文） |
|:---|:---|
| `sqlite` | `sqlite requires a connection string or path` |
| `snowflake` | `snowflake requires connection_string` |

### 12.4 密码与连接串是 secret，必须先配 keystore

只要出现 `password` 或 `connection_string`，写入就被拒：

```
secrets.keystore.key must be set before setting secret config values or reading
encrypted secret refs (databases.probe_db.password); set secrets.keystore.key,
for example with GJ_SECRETS_KEYSTORE_KEY, and retry
```

**key 的编码是 base64，且解码后必须正好 32 字节**：

```
secrets.keystore.key must decode to 32 bytes for AES-256-GCM, got 48 bytes
```

传 64 字符的 hex 时会报 `got 48`（64 个 base64 字符解出 48 字节），反推出它按 base64 解码。
所以正确写法是 `crypto.randomBytes(32).toString('base64')`，且 key 必须持久化 ——
换 key 会让已写入的加密 secret 解不开。

**平台影响（硬约束）**：后端拉起 GraphJin 时必须注入 `GJ_SECRETS_KEYSTORE_KEY`，
否则任何带密码 / 连接串的数据库连接都配不进去。

### 12.5 validate_config 会真的去连数据库

`mode: "validate"` 下配置合法时仍会做连接测试
（`Database connection test failed — config changes not applied`），
所以「测试连接」可以直接复用这个工具，不必自己实现 ping。
