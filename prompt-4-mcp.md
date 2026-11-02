# 项目创建提示词汇总（prompt-4-mcp）

> 本文汇总「创建 `build-mcp-server-4-any-db` 这个项目」的原始需求与关键决策提示词。
> 来源为仓库内的 `Plan.md`、`docs/*-baseline.md`、`docs/graphjin-source-migration.md`，
> 以及项目 memory（`project_mcp_builder.md`）。这些是**根据计划书与决策记录还原的提示词口径**，
> 并非逐字聊天记录；用以复现项目初衷与约束红线。

---

## 0. 一句话总纲（原始愿景）

> 基于 GraphJin CLI 做一个跨平台桌面应用，让不懂 GraphJin 配置格式的人也能把**任意数据库变成 MCP Server**——
> 可视化录入连接和权限，应用自动生成配置、自动拉起 GraphJin、自动暴露 MCP 端点，并一键产出客户端配置。

英文等价（见 `README.md`）：

> **Configure GraphJin visually and turn any database into an MCP server.**
> Enter a database connection; the app starts GraphJin, discovers the schema, and writes your
> permissions into GraphJin's `sources` config. The result is an HTTP endpoint (`/api/v1/mcp`)
> that Claude, Cursor and other MCP clients can connect to directly — no hand-written YAML.

---

## 1. 产品形态提示词

- 做成**桌面端安装包**（Windows / macOS / Linux），不是纯网页。
- 用户录入数据库连接 → 应用拉起 GraphJin → 自动发现 schema → 把权限写进 GraphJin 配置 → 暴露 `/api/v1/mcp` 端点。
- 不让用户手写 YAML、不让用户学 GraphJin 配置格式。
- 提供「一键生成客户端配置」：直接产出 Claude Desktop / Cursor 等可粘贴的连接配置。
- 带本地测试数据库（Docker）说明与快速入门向导，降低上手成本。

---

## 2. 技术栈决策提示词

- **底层引擎**：GraphJin CLI（sidecar 进程），负责 schema 发现、GraphQL 编译、RBAC 执行、MCP 协议暴露。
- **前端**：Vue 3 + Vite（配合 Pinia + Element Plus + vue-i18n），浅色工作台主题。
- **后端**：Node.js；**进程内运行**——Electron 主进程直接 `require` 后端（`createBackend()` 返回可编程启停实例），不再用 `pkg` 打包成独立二进制。
- **桌面框架：Electron**（原计划 **Tauri 2 + Rust**，因本机缺 MSVC 工具链 / C++ 组件、且 UAC 在自动化环境无法确认，于 2026-10-19 改为 Electron 44.7.0，`src-tauri/` 整体移除）。
- GraphJin 二进制作为第二个 sidecar，由后端的 `supervisor.js` 拉起并从启动横幅解析端口。

---

## 3. GraphJin 二进制管理提示词

- **只做构建期本地预置，不做运行时在线更新**：应用运行时绝不访问 GitHub Releases、不下载替换二进制。
- 仓库只保存压缩态 `*.tar.gz`（各 42–48 MB），**不提交解压后近 158 MiB 的产物**；构建时解压并按目标三元组重命名到 `binaries/`。
- 升级 GraphJin = **发新版桌面端**（改 `graphjin-binaries/version.json` 版本号，跑 fetch 脚本重新拉取校验，用户升级应用即获得新版本）。
- 设置页只展示内置 GraphJin 版本（解析 `graphjin version` 输出），提供「复制版本信息」，**不做「检查更新」**。

---

## 4. 权限模型提示词（核心业务）

- 目标：把「角色 × 表 × query/insert/update/delete」的权限做成**可视化矩阵**编辑。
- **决策演变**：
  - 早期方案 B（legacy）：`databases:` + `roles[].tables`，可拿到四项独立开关。
  - **2026-10-20 改为 source 模式（官方推荐路径）**：接受降级——写/删降到**数据源级档位**，表级可见性只剩「公开 / 仅 admin / 全局屏蔽」；旧 `databases:` 项目在启动前自动改写成 `sources:` 并保留 `.bak`，迁移失败自动回滚。
- 平台始终只输出 `databases:` map，**绝不写 `sources`** 之外的形态（source 模式下由迁移逻辑处理）。
- **写入前二次确认**：展示 `from → to` 的 diff 对话框再写入；写入前自动保存 `roles` 快照以支持回滚。

---

## 5. 通信与 API 提示词（实测红线）

- **一律走 MCP HTTP 端点 `/api/v1/mcp`**，不要直接调 GraphQL 的 `gj_*` root（需真 JWT、dev 头在 GraphQL 端点不生效）。
- MCP 传输约束（违反即 400 / 会话错误）：
  - 请求头 `Accept` 必须同时含 `application/json` 与 `text/event-stream`；
  - 响应恒为 SSE（`Content-Type: text/event-stream`），需解析 `data: ` 帧；
  - `initialize` 响应头下发的 `Mcp-Session-Id` 后续必须回传；
  - 握手顺序固定：`initialize` → `notifications/initialized` → 其它方法。
- 后端统一封装 MCP 客户端，**禁止各处裸 `fetch`**。
- 后端与渲染进程通过本地 HTTP `/rpc` 通信，端口动态分配，经 `additionalArguments` + preload 注入，渲染进程不必等 IPC。

---

## 6. 界面清单提示词（Vue 视图）

- `ConnectionsView`：数据库连接管理（类型/主机/端口/认证、连接测试、连接列表），只输出 `databases` map。
- `SchemaView`：树形 Schema 浏览器（库 → 表 → 列 + 关系）。
- `PermissionsView`：权限矩阵（核心），角色选择器 + 表格，每表一行，列为 Query/Insert/Update/Delete 开关；行过滤与列管控按操作独立编辑。
- `PolicyView`：安全策略预览 + 变更 diff（策略真相来源为 `get_current_config`，而非不可达的 `gj_security`）。
- `StatusView`：MCP 监控（运行状态、端点、工具列表、一键复制客户端配置）。
- `SettingsView`：内置 GraphJin 版本展示、复制版本信息；不做在线更新。
- `UsersView`：组织与成员管理，成员角色即 GraphJin 角色名，一键同步进 GraphJin。
- 路由 **hash 模式**，`vite.config.js` 必须 `base: './'`（否则 `file://` 下资源 404、路由空白）。

---

## 7. 后续扩展提示词（在原始骨架之上追加）

> 以下为项目成型后陆续加入的需求，不属于最初「创建」提示词，但已固化进产品。

- **AI Demo 面板**（`AiDemoPanel.vue` + `mcp-demo.js` + 后端 `mcp.demoTools` / `mcp.demoCall`）：
  - 在设置页增加面板，逐个调用所有 MCP 工具，每个目录内工具带可自动跑的测试数据。
  - 测试不通过时**读报错自动改参数重试**（最多 N 次），修正后的参数回写表单可见。
  - 参数编辑**按 `inputSchema` 生成表单字段**（每个参数一个输入框，带类型/枚举/默认值），替代 JSON 文本框；提供「参数」入口、折叠预览、恢复默认。
- **titlebar 品牌同源**：窗口标题/启动屏显示 brand name + tagline。
- **打包脚本修复**：配置文件 `electron-builder.js` 因与 CLI 同名在 Windows 下被误执行（cmd 先查当前目录 + `.JS` 在 PATHEXT），重命名为 `electron-builder.config.js` 并显式 `--config` 传入。

---

## 8. 关键约束 / 红线清单（改动前必读）

| 主题 | 红线 |
|:---|:---|
| GraphJin 形态 | 后端只输出 `databases:` map；单数 `database:` 会让服务端 `panic` 退出进程 |
| 角色表规则 | 必须带 `database: <库名>`，否则规则挂到内部库 `__gj_internal_artifacts` |
| legacy 模式 | 无 preview/apply，写入立即生效；平台侧自算 diff + 二次确认 |
| RBAC 角色 | 必须显式创建 `admin` 角色才能以它执行 GraphQL（`admin` 未定义也会报 `not defined`） |
| 查询拦截 | query 被拦**不报错**，`data.<root>` 为 `null`，判拦截要看 `data === null` |
| `query.limit` | 只是默认值，非强制上限；显式 `limit` 会覆盖，UI 不能宣传「最多 N 行」 |
| secret | 带 `password` / `connection_string` 的库需 `GJ_SECRETS_KEYSTORE_KEY`（32 字节 base64），否则写入被拒 |
| 传输 | 见 §5 MCP 约束，禁止裸 `fetch` |
| 打包 | 进程内后端需 `build.files` 含 `sidecar-backend/package.json`，否则打包后 ENOENT |

---

## 9. 验证门禁提示词

每次改动后必须跑、并**给出真实验证输出**才算完成：

- `npm run build`（前端构建通过）
- `npm test`（后端单测 + 前端单测）
- `npm run verify:ui`（UI 冒烟，本机 Windows 实测）
- `scripts/verify-e2e.js` / `verify:e2e`（端到端：建库 → 发现 → 配权限 → 起 GraphJin → 真实 MCP 会话 → 快照回滚）
- 跨平台：`scripts/smoke-binaries.js` 在 CI 矩阵跑 `graphjin version`；完整 UI 冒烟仅 Windows 实测
- 打包：`electron-builder --win nsis` 产出 `release/MCP Server Build Setup 0.1.0.exe`
