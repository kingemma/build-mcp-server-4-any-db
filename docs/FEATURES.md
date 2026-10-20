# 功能进度

> 更新于 2026-10-18。新增/完成功能时同步本表；实现细节见 `Plan.md` 与
> `docs/graphjin-3.21.14-baseline.md`。

## 已完成

### 桌面端与分发

| 能力 | 说明 |
|:--|:--|
| Electron 外壳 | 主进程起后端、注入端口、外链走系统浏览器、退出前先停 GraphJin |
| Windows 安装包 | `npm run dist:win` → `release-final/`（NSIS，可选安装目录） |
| macOS 打包配置 | `npm run dist:mac` → dmg + zip；GitHub Actions 在 macOS 13 / 14 上产出 |
| Linux 打包配置 | `npm run dist:linux` → AppImage + deb；GitHub Actions 在 ubuntu-latest 上产出 |
| CI / CD | `.github/workflows/build.yml`：单测 + Web 构建 → 四平台矩阵打包并上传产物 |
| 二进制随包分发 | `extraResources` 打包 `binaries/graphjin-*` |
| 二进制管理 | `fetch:binaries` 下载 + sha256 校验，`prepare:binaries` 解压改名 |
| 二进制冒烟 | `smoke:binaries` 真实执行 `graphjin version` 并核对版本，CI 三平台各跑一次 |

### 后端

| 能力 | 说明 |
|:--|:--|
| JSON-RPC 服务 | HTTP `POST /rpc` + stdio 双传输，同一份方法表 |
| GraphJin 进程编排 | 绝对路径校验、端口探活、崩溃自动重启、状态查询 |
| MCP 客户端 | Streamable HTTP、会话管理、**会话失效自动重连**、请求串行队列 |
| Schema 发现 | `query_catalog` 分页（table / column / relationship），支持按库过滤 |
| 权限编排 | source 模式：数据源级 `access`（读/写/删 + owner 列）+ 角色级 `grants`（列白名单 / 行过滤） |
| 权限快照 / 回滚 | 每次写入前把 `roles` 与 `sources[].access` 落盘；回滚先恢复 access 再删本次新增角色（admin 受保护） |
| 策略读取 | `get_current_config` 的 `sources[].access.grants` 解析成可对比结构 |
| admin 角色保障 | 启动与每次写入前自动补齐 `admin`，避免 `roles 'admin' not defined` |
| block 列管控保护 | 表列清单缺失时拒绝展开补集，避免把全部列静默放行 |
| 驱动能力校验 | `driverVerified=false` 的类型在测试/启动前直接返回明确错误，不再拉起进程 |
| 用户 / 组织 | SQLite 存储；角色可同步到 GraphJin；组织有成员时拒绝删除，成员资料可改 |
| 连接本地存储 | SQLite + AES-256-GCM；`name + project_dir` 唯一；摘要字段独立明文列 |
| 连接自检 | 服务未运行时临时起单库实例跑 `validate_config`，用完即停；缺必填字段的配置前置拦截，不起进程 |
| dev.yml 增量合并 | 只改 `databases:` 段；支持块/单行 flow/引号键，兼容本项目 2 空格与 GraphJin 回写的 4 空格缩进；anchors / aliases / merge keys 显式拒绝 |
| 测试 | `node:test` 共 133 项 |

### 前端

| 页面 / 能力 | 说明 |
|:--|:--|
| 运行状态 | 进程、端点、项目目录、重启次数、探活、停止、MCP 客户端配置复制 |
| 数据库连接 | 内置类型 + 自定义模板；三种录入方式；测试 / 启动 / 存模板；驱动未验证类型自动禁用测试与启动 |
| 已保存连接 | 测试或启动成功后自动落盘；回填表单、一键启动、删除 |
| Schema 浏览器 | 顶部库选择，按库加载表 / 列 / 关系；结构与关系隔离 |
| 权限矩阵 | 角色 × 表的读规则（行过滤、列白名单 / 黑名单）；数据源级读/写/删档位、owner 列、仅管理员/全局屏蔽表；按库隔离（表身份 `database::table`）；可移除本地角色 |
| 策略回填 / 导入 | 加载时用生效策略补空格子（不覆盖本地改动）；「从生效策略导入」二次确认后覆盖 |
| 写入历史 / 回滚 | 列出每份快照（时间、角色数、库、原因），可恢复到任意一份；回滚前自动再快照 |
| 用户与组织 | 组织 / 成员增删改；成员角色即 GraphJin 角色名，一键把成员角色同步进 GraphJin；组织有成员时拒绝删除 |
| 权限验证 | 以任意角色真跑一条 GraphQL（`graphql.execute`），区分「静默返回 null」与「返回 errors」 |
| 策略预览 | 生效策略 vs 待写入矩阵的逐项 diff；自带库选择，可直接打开使用 |
| 设置 | 后端端口、内置 GraphJin 版本、缓存平台、版本信息复制 |
| 国际化 | `vue-i18n`，中文 / English，跟随系统 + 本地持久化；Element Plus 语言包同步 |
| 视觉主题 | 深色侧栏 + 浅色内容区；提高正文 / 表格字号与对比度；统一 Element Plus 输入、按钮、弹窗、下拉与滚动条样式 |
| 前端拆包 | 六个页面路由懒加载 + `element-plus` / `vue` vendor chunk；首页 JS 从 1.17 MB 降到约 39 kB |
| 空状态与错误提示 | 未运行 / 无库 / 无表 / 解密失败均有明确文案 |

### 文档与验证

| 内容 | 位置 / 命令 |
|:--|:--|
| 中英文 README（介绍、截图、部署运行） | `README.md` / `README.en.md` |
| 功能进度（本文件） | `docs/FEATURES.md` |
| GraphJin 实测基线 | `docs/graphjin-3.21.14-baseline.md` |
| 本地测试数据库 | `docs/docker-compose-4-test-db-connection.yml`：MySQL / PostgreSQL / MongoDB / SQL Server，Oracle 注释可选 |
| 后端单测 | `cd sidecar-backend && npm test`（133 项） |
| 前端策略单测 | `npm run test:frontend`（8 项） |
| 真机全链路 | `cd sidecar-backend && npm run verify:e2e`（24 项，含快照回滚） |
| 二进制冒烟 | `npm run smoke:binaries` |
| UI 冒烟 + 截图 | `npm run build && npm run verify:ui`（21 项：语言切换、组织/成员与资料编辑、权限写入 / 验证 / 回滚、本地角色删除） |

## 未完成

### 需要外部条件

| 项 | 状态 | 备注 |
|:--|:--|:--|
| macOS / Linux 实机安装验证 | CI 已能打包，本机未运行 | 本机是 Windows；CI 产物为未签名包 |
| 代码签名 / 公证 | 未开始 | 需要 Apple Developer 证书与 Windows 代码签名证书；CI 目前显式跳过签名发现 |
| `gj_security` 策略读取 | 未实现 | 走 `/api/v1/graphql` 且需 admin JWT；策略真相来源已改为 MCP `get_current_config` |
| 非 Windows 全链路 UI 冒烟 | 未做 | CI 只做二进制 `version` 冒烟；`verify:ui` 依赖 Windows Edge |

### 功能缺口

| 项 | 影响 | 备注 |
|:--|:--|:--|
| 连接测试多一次进程启停 | 未启动服务时约多 1–2s | 服务在跑时复用现成实例；缺必填字段的配置已前置拦截，真正需要连库的才起临时实例 |
| dev.yml 合并不是通用 YAML 解析器 | 手写 anchors / merge keys 无法合并 | 已覆盖项目生成格式、flow map、引号键与 GraphJin 回写格式；不支持的构造会明确报错并拒绝合并，不会改坏文件 |
| 一个后端只托管一个实例 | 切换连接要停旧实例 | 设计取舍；避免多实例端口与 keystore 冲突 |

## 已知边界（非缺陷）

- 一个后端进程只托管一个 GraphJin 实例；切换连接会先停止再启动。
- source 模式下 `source_patches` 会忽略 `access.grants`，平台改为整份替换 `sources`；
  替换前先从 dev.yml 读回真实连接串（配置 API 返回 `[REDACTED]`）。
- 删除角色必须在清空引用它的 grants 之后，否则 `update_current_config` 会 reload 失败。
- 连接凭据依赖 `keystore.key`；该文件丢失后旧记录只能重新录入密码。
- 权限快照存在同一个 `mcp-builder.db`，只保留每个项目最近 30 份。
- `admin` 是保留角色：平台不为它写限制规则、默认不进入矩阵，任何回滚都不会删除它。
