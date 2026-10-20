# MCP Server Build

**可视化配置 GraphJin，把任意数据库变成 MCP Server。**

[English](./README.en.md) · [功能进度](./docs/FEATURES.md)

MCP Server Build 是一个桌面端工具：填好数据库连接，它会启动 GraphJin、发现表结构，并把
「角色 × 表 × 操作」的权限写成 GraphJin 配置。最终产出的是一个可直接接入 Claude、
Cursor 等 MCP 客户端的 HTTP 端点（`/api/v1/mcp`），不需要手写 YAML，也不需要理解
GraphJin 的配置细节。

![数据库连接页](./docs/screenshots/zh-CN/connections.png)

## 目录

- [架构](#架构)
- [功能](#功能)
- [环境要求](#环境要求)
- [本地启动](#本地启动)
- [本地测试数据库（Docker）](#本地测试数据库docker)
- [GraphJin 二进制](#graphjin-二进制)
- [数据与安全](#数据与安全)
- [验证](#验证)
- [项目结构](#项目结构)
- [已知限制](#已知限制)

## 架构

```
┌───────────────────────────── Electron ─────────────────────────────┐
│  Vue 3 渲染进程（Pinia + Element Plus + vue-i18n）                  │
│         │ JSON-RPC over HTTP /rpc                                   │
│  Node 后端（sidecar-backend）                                        │
│    ├── GraphJinSupervisor  进程编排、崩溃重启                        │
│    ├── McpClient           MCP Streamable HTTP 客户端                │
│    ├── UserStore           用户 / 组织 / 连接记录（SQLite）           │
│    └── 权限编排            角色 → 表 → 操作，写 update_current_config │
│         │ MCP tools                       │ 子进程                    │
└─────────┼─────────────────────────────────┼─────────────────────────┘
          ▼                                 ▼
   GraphJin /api/v1/mcp              GraphJin（graphjin serve）
          │                                 │
          └─────────── 业务数据库（PostgreSQL / MySQL / SQLite …）──────┘
```

- **为什么走 MCP**：基线实测发现 v3.21.14 的内置 stdio proxy 有缺陷，因此客户端配置
  直接写 HTTP 传输，指向 `/api/v1/mcp`。
- **权限方案**：本地角色名即 GraphJin 角色名，不需要额外的映射表；写入后立刻生效。

## 功能

### 运行状态

查看 GraphJin 进程、端点、项目目录与崩溃重启次数，探活、停止、复制 MCP 客户端配置。

![运行状态](./docs/screenshots/zh-CN/status.png)

### 数据库连接

- 内置驱动 + 自定义别名模板（TiDB / CockroachDB 这类兼容库以 postgres / mysql 协议接入）；
- 三种录入方式：文件路径、连接字段、连接串；
- **测试通过或启动成功后自动保存到本地**，下方列表可回填表单、一键启动、删除；
- 连接凭据用 keystore key 加密后写入 SQLite，列表只显示非敏感摘要；
- 未启动服务也能测试连接：后端会临时拉起一个用完即停的 GraphJin 实例；
- 白名单里 `driverVerified=false` 的类型（ClickHouse / Redshift / BigQuery 等）在当前
  GraphJin 版本连接层未实现，测试与启动按钮会直接禁用，并提示改用 postgres / mysql 协议。

### Schema 浏览器

顶部列出运行中实例实际加载的数据库，切换后按库加载表、列与外键关系（`query_catalog`
带 `database_name` 过滤，多库数据不会串）。

![Schema 浏览器](./docs/screenshots/zh-CN/schema.png)

### 权限矩阵

角色 × 表 × 四项操作（Query / Insert / Update / Delete）开关，额外支持：

- 行过滤条件（GraphJin DSL）；
- 列管控：白名单，或「阻止列表」自动转成补集白名单（GraphJin 的 `columns` 只接受数组）；
- 查询默认 `limit`。

启动后自动用生效策略回填矩阵（只补空格子，不覆盖本地改动）；也可以点「从生效策略导入」
用生效策略覆盖本地未提交的改动。写入前展示逐项 diff 并二次确认。

角色标签上的 `×` 可移除本地角色；角色已写进生效策略时会先确认，并说明 GraphJin 里的
规则要回收得走「写入历史」回滚。

「验证权限」按所选角色真跑一条 GraphQL（`graphql.execute`）：query 被拦时 GraphJin 是
静默的（返回 `null`、不报错），写操作被拦才返回 `errors`，面板会把这两种情况分开提示。

每次写入前会自动保存一份策略快照（`mcp-builder.db` 的 `policy_snapshots` 表），
点「写入历史」可查看并按时间恢复；回滚前会再存一份，所以回滚本身也能撤销。
`admin` 是平台保留角色，不进入矩阵，平台也不会为它写限制规则；它不会被回滚删除。

![权限矩阵](./docs/screenshots/zh-CN/permissions.png)

### 用户与组织

本地维护组织与成员（SQLite，不依赖 GraphJin 是否在跑）：

- 成员角色直接就是 GraphJin 角色名，改角色即时写回本地库；
- 「同步角色到 GraphJin」把成员用到的角色补进 `roles` —— 方案 B 下角色不存在时
  `roles[].tables` 规则会被拒；
- 角色下拉支持直接输入新角色名（allow-create），不用先去权限矩阵建角色；
- 成员可改姓名 / 邮箱；组织标签上的 `×` 可删除组织，组织下还有成员时后端会拒绝删除。

![用户与组织](./docs/screenshots/zh-CN/users.png)

### 策略预览

从 `get_current_config` 读取当前生效的角色策略，和待写入的矩阵做 diff。顶部库选择决定
看哪个库；直接打开本页会自动加载 Schema，不依赖先逛一遍权限矩阵。

![策略预览](./docs/screenshots/zh-CN/policy.png)

### 设置

后端端口、内置 GraphJin 版本与缓存平台、版本信息复制。界面支持 **中文 / English**
切换（右上角），选择会持久化到本地。

![设置](./docs/screenshots/zh-CN/settings.png)

英文界面：

![Settings](./docs/screenshots/en-US/settings.png)

## 环境要求

| 依赖 | 版本 / 说明 |
|:--|:--|
| Node.js | **>= 22.5**（后端使用 `node:sqlite`） |
| npm | 随 Node 分发 |
| GraphJin 二进制 | 仓库内带 `v3.21.14` 压缩包，构建期解压；见「本地启动」第 3 步 |
| 浏览器（可选） | `verify:ui` 需要本机 Edge / Chrome |
| Docker（可选） | 只想连 SQLite 或已有数据库可不装；跑本地测试库需要 Docker + compose v2 |

## 本地启动

### 0. 完整启动命令（推荐）

先进入 `package.json` 所在的项目根目录，然后按顺序执行：

```bash
# Windows PowerShell 示例；macOS / Linux 换成实际路径
cd D:\Code\GitHubs\build-mcp-server-4-any-db

# 1. 安装依赖（只需第一次）
npm install

# 2. 准备并验证 GraphJin 二进制（只需第一次；缺压缩包时先 fetch）
npm run prepare:binaries
npm run smoke:binaries

# 3. 可选：手头没有数据库时，创建一个演示 SQLite 库
npm run demo:db

# 4. 一键启动：Vite + Electron + Node 后端
npm start
```

`npm start` 实际做了四件事：

1. 启动 Vite 开发服务器（`127.0.0.1:1420`）；
2. 等 Vite 就绪后启动 Electron；
3. Electron 主进程在进程内启动 Node 后端，并把动态端口注入页面；
4. 关闭窗口（Windows / Linux）、按 `Cmd+Q`（macOS）或 `Ctrl+C` 时，把 Electron、
   Node 后端和 Vite 一起清理。

进程关系：`npm start` → Vite（1420）→ Electron → Node 后端；GraphJin 在界面点「启动」后
由后端拉起。

启动成功后，还需要在界面里启动 GraphJin。GraphJin 是**按你填写的数据库连接**启动的，
不能由命令行预先写死：

1. 打开「数据库连接」，填连接信息。
   - 没有现成数据库时，先跑 `npm run demo:db`，然后选类型 **SQLite**、
     文件路径 `projects/quickstart/demo.db`、项目目录 `projects/quickstart`；
   - 已有数据库：SQLite 直接填 `.db` 文件，MySQL / PostgreSQL 等填主机、端口、库名、用户、密码；
   - 「项目目录」填 `projects/demo` 这类目录；
2. 点「测试连接」，再点「启动」；
3. 到「Schema 浏览器」确认表结构，到「权限矩阵」配置权限。

### 订单演示数据（含多用户隔离）

```bash
npm run demo:orders                     # 写入开发数据目录 sidecar-backend/data
npm run demo:orders -- --db <路径>      # 指定 Electron 用的 mcp-builder.db
```

脚本会建 `projects/demo-orders/demo.db`、组织 `demo-shop`、两个用户，并写入权限矩阵，
最后用真实查询跑 9 项断言（失败会以非零码退出）：

| 用户 | 角色 | 行过滤 | 列 | 写操作 |
|:--|:--|:--|:--|:--|
| `user-a@demo.local` | `customer` | `owner_code = $user_code` | 白名单 6 列，看不到 `internal_note` | 全阻止 |
| `user-b@demo.local` | `ops` | 无（看全部） | 不限 | 允许更新、删除 |

**多用户身份走「平台网关 + JWT」**，不用 GraphJin 原生 JWT——实测 v3.21.14 的 legacy
`roles[].tables` 模式不解析 token 里的 `roles`/`role`，`roles_query` 也查不到表
（见 `sidecar-backend/scripts/verify-identity.js`）。链路是：

```
外部客户端 → http://127.0.0.1:<后端端口>/api/v1/mcp
             Authorization: Bearer <JWT>
           → 平台网关验签
           → 注入 X-User-Role / X-User-Code（仅回环）
           → GraphJin（只监听 127.0.0.1，auth.type: none）
```

令牌用 `auth.token` RPC 按用户签发（默认 12 小时），客户端配置由 `mcp.clientConfig`
带 `gatewayUrl` + `token` 生成。

> **已知限制**：MCP 的 `execute_graphql` 不透传自定义请求头，`$user_code` 因此解析为空，
> 行过滤会退化成 0 行。所以**行级隔离只在平台内的 HTTP GraphQL 路径生效**
>（验证面板、`graphql.execute`）；外部 MCP 客户端能用角色与列白名单，但拿不到按人过滤的行。
> 彻底解决需要在网关里把 `execute_graphql` 改写成 GraphQL 请求，尚未实现。

如果不想用一键脚本，等价的**手动分终端**方式是：

```bash
# 终端 1
npm run dev

# 终端 2（等终端 1 打印 Local 后再执行）
npm run electron:dev
```

两种方式只需要选一种；`npm start` 只是把这两步串起来。

启动相关命令一览：

| 命令 | 作用 |
|:--|:--|
| `npm start` | Vite + Electron + Node 后端（推荐） |
| `npm run dev` | 只启动 Vite（`127.0.0.1:1420`） |
| `npm run electron:dev` | 只启动 Electron + 后端；要求 Vite 已在运行 |
| `npm run backend` | 只启动 Node 后端（供纯浏览器模式使用） |
| `npm run demo:db` | 创建演示 SQLite 库 |
| `npm run prepare:binaries` | 解压当前平台的 GraphJin |
| `npm run smoke:binaries` | 真实执行 GraphJin `version` 做冒烟 |
| `npm run dist:win` / `dist:mac` / `dist:linux` | 打包对应平台安装包 |

下面是每一步的详细说明、纯浏览器模式和常见问题。

### 1. 准备环境

| 依赖 | 要求 |
|:--|:--|
| Node.js | **>= 22.5**，推荐 24.x（后端使用内置 `node:sqlite`） |
| npm | 随 Node 分发 |
| GraphJin 二进制 | 构建期从 `graphjin-binaries/` 解压，见第 3 步 |
| 可用端口 | Vite 固定使用 `127.0.0.1:1420`；后端与 GraphJin 端口动态分配 |
| Docker（可选） | 只有跑本地测试数据库时需要 |

先确认版本：

```bash
node -v    # 应 >= v22.5.0
npm -v
```

### 2. 安装依赖

在项目根目录执行：

```bash
npm install
```

> Electron 首次安装会下载约 100 MB 的运行时。如果下载慢或被代理拦截，可以设置镜像后重试：
>
> ```bash
> # Windows PowerShell
> $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
> npm install
> ```
>
> 也可以设置 `HTTPS_PROXY` / `HTTP_PROXY` 走本地代理。

### 3. 准备 GraphJin 二进制

仓库内已带 `graphjin-binaries/v3.21.14/*.tar.gz` 时，直接解压当前平台的二进制：

```bash
npm run prepare:binaries
```

如果缺少压缩包，先下载当前平台的发布包，再解压：

```bash
# 平台可选：windows-amd64 / windows-arm64 / linux-amd64 /
#           linux-arm64 / darwin-amd64 / darwin-arm64
# 其他平台把 windows-amd64 换成自己的 key
npm run fetch:binaries -- --only windows-amd64
npm run prepare:binaries
```

验证二进制能真实启动：

```bash
npm run smoke:binaries
# 期望输出：PASS  windows-amd64  ...  GraphJin 3.21.14
```

解压后的文件位于 `binaries/graphjin-<target-triple>[.exe]`。
如需使用自定义路径，可设置环境变量 `GRAPHJIN_BIN`。

### 4. 启动桌面端（手动分终端）

需要两个终端，**先起 Vite，再起 Electron**。也可以直接用第 0 步的 `npm start`
一次拉起两者。

终端 1：

```bash
npm run dev
```

等到出现 `Local: http://127.0.0.1:1420` 后再继续。

终端 2：

```bash
npm run electron:dev
```

Electron 会：

1. 在进程内启动 Node 后端（动态端口）；
2. 把后端端口通过启动参数注入渲染进程；
3. 打开桌面窗口并加载 Vite 页面。

看到窗口即启动成功。Windows / Linux 关闭窗口会先停止 GraphJin 和后端再退出；
macOS 关闭窗口只隐藏窗口，退出请用 `Cmd+Q`。开发态数据落在 Electron 的
`userData/data`（Windows 通常是 `%APPDATA%\mcp-builder\data`）。

### 5. 纯浏览器调试（可选）

不想开 Electron 时，可以用两个终端手动起前后端：

终端 1：

```bash
npm run backend
```

它会打印一行 ready JSON，记下其中的端口：

```json
{"jsonrpc":"2.0","method":"ready","params":{"port":50123,"pid":12345}}
```

终端 2：

```bash
npm run dev
```

浏览器打开 <http://127.0.0.1:1420>，进入「设置」页，填入上一步的 `port`，
点「保存并连接」。右上角出现「后端在线」即接通。

纯浏览器模式的数据目录是 `sidecar-backend/data`。`npm run backend` 的进程必须
保持运行；停止后前端会显示后端离线。

### 6. 首次配置流程

1. **数据库连接页**：填写连接名、类型和连接信息。
   - 没有数据库时先执行 `npm run demo:db`，然后选 SQLite、文件路径
     `projects/quickstart/demo.db`、项目目录 `projects/quickstart`；
   - SQLite：录入方式选「文件路径」，填已有的 `.db` 文件；
   - MySQL / PostgreSQL 等：填主机、端口、库名、用户、密码；
   - 「项目目录」填 `projects/demo` 之类的目录（开发时相对仓库根目录，
     打包后建议填绝对路径），GraphJin 的 `dev.yml` 会写在这里。
2. 点「测试连接」。测试通过后连接会自动保存到本地列表。
3. 点「启动」。后端会创建/合并 `dev.yml` 并拉起 GraphJin。
4. 到 **Schema 浏览器** 确认表、列和关系已经发现。
5. 到 **权限矩阵** 添加角色、配置四项操作、行过滤和列管控；
   点「应用到 GraphJin」后按 diff 确认，写入前会自动保存快照。
6. 到 **运行状态** 页查看端点、探活、复制 MCP 客户端配置。

> `admin` 是平台保留角色：不进入矩阵，平台不会为它写限制规则，也不会在回滚时删除它。

### 7. 停止

- 桌面端：Windows / Linux 关闭窗口即可，主进程会先停 GraphJin 再退出；
  macOS 关闭窗口只隐藏窗口，请用 `Cmd+Q` 退出应用。
- 浏览器模式：先在「运行状态」点「停止」，再在终端 `Ctrl+C` 结束后端。
- 如果终端被强制关闭，检查是否还有 `graphjin` 进程占用端口。

### 8. 常见问题

| 现象 | 处理 |
|:--|:--|
| `npm run dev` 报 `EADDRINUSE` / 1420 被占用 | 关掉旧的 Vite 进程，或用 `netstat -ano \| findstr :1420`（Windows）找到 PID 后结束 |
| Electron 窗口空白 | 确认终端 1 的 Vite 已经打印 `Local: ...`；必要时设置 `MCP_BUILDER_DEV_URL=http://127.0.0.1:1420` 再启动 |
| 右上角显示后端离线 | 浏览器模式下端口填错或 `npm run backend` 没在运行；访问 `http://127.0.0.1:<port>/health` 应返回 `{"ok":true,...}` |
| 提示找不到 GraphJin 二进制 | 执行 `npm run prepare:binaries` 和 `npm run smoke:binaries`，或设置 `GRAPHJIN_BIN` 指向可执行文件 |
| `electron:dev` 报 `Cannot read properties of undefined (reading 'isPackaged')` | 环境里设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 被当成 Node 运行；取消该变量后重试 |
| GraphJin 启动后立刻退出 | 查看「运行状态」里的日志和项目目录下 `dev.yml`；常见原因是端口冲突、数据库连不上或连接字段缺失 |
| `node:sqlite` 相关报错 | Node 版本低于 22.5，升级 Node 后重新 `npm install` |
| 带密码的连接保存失败 | 确认数据目录下的 `keystore.key` 存在且可读；丢失后旧连接需要重新录入密码 |
| `fetch:binaries` 失败 | 确认本机有 `curl` 且能访问 GitHub；也可以手动把官方压缩包放进 `graphjin-binaries/<version>/` |

### 9. 本地验证（可选）

```bash
npm test                 # 前端策略单测 + 后端单测
npm run smoke:binaries   # GraphJin 二进制冒烟
npm run build            # 前端生产构建
npm run verify:ui        # 真实后端 + Edge headless（21 项）
```

完整的端到端验证（会真实拉起 GraphJin、建库、写权限并回滚）：

```bash
cd sidecar-backend
npm run verify:e2e       # 24 项
```

### 构建安装包

```bash
npm run dist:win    # Windows NSIS
npm run dist:mac    # macOS dmg + zip（需在 macOS 上执行）
npm run dist:linux  # Linux AppImage + deb（需在 Linux 上执行）
```

产物都在 `release-final/`。跨平台打包由 `.github/workflows/build.yml` 的矩阵在
Windows / macOS 13 / macOS 14 / Ubuntu 上完成；CI 没有签名证书，产物未签名。

需要签名时在对应平台设置 electron-builder 的标准环境变量后再执行构建：

```bash
# macOS：证书 + 公证
CSC_LINK=/path/to/dev-id.p12 CSC_KEY_PASSWORD=... \
APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... \
npm run dist:mac

# Windows：代码签名证书
WIN_CSC_LINK=C:/path/to/cert.pfx WIN_CSC_KEY_PASSWORD=... npm run dist:win
```

### 本地测试数据库（Docker）

仓库自带 [`docs/docker-compose-4-test-db-connection.yml`](./docs/docker-compose-4-test-db-connection.yml)，
一键拉起四种免费版数据库，用来验证「数据库连接」页的各类驱动（Oracle 默认注释掉，镜像偏大）。

```bash
docker compose -f docs/docker-compose-4-test-db-connection.yml up -d
docker compose -f docs/docker-compose-4-test-db-connection.yml ps
docker compose -f docs/docker-compose-4-test-db-connection.yml down
```

| 数据库 | 端口 | 用户 | 默认库 |
|:--|:--|:--|:--|
| MySQL 8.0 | 3306 | root | testdb |
| PostgreSQL 16 | 5432 | test | testdb |
| MongoDB 7.0 | 27017 | test | — |
| SQL Server 2022 | 1433 | sa | — |
| Oracle 23 Free（默认注释） | 1521 | test | FREE |

密码不在这里复制，统一以 yml 里 `environment` 的取值为准（`MYSQL_ROOT_PASSWORD`、
`POSTGRES_PASSWORD`、`MONGO_INITDB_ROOT_PASSWORD`、`SA_PASSWORD`、`ORACLE_PASSWORD`）。
连接页选对应类型，主机填 `127.0.0.1`，端口 / 用户 / 密码与 yml 保持一致，点「测试连接」即可；
要换密码直接改 yml 后重启容器。
要用 Oracle 就打开 yml 里的注释块（`gvenzl/oracle-free:23.4-slim`），内存建议留 4 GB 以上。

> 这组容器只用于本地测试：凭据明文写在文件里、不挂数据卷（`restart: no`），
> 停止后数据即丢弃。刚起来的库是空的，Schema 浏览器要先建表才有内容。

## GraphJin 二进制

构建期从 `graphjin-binaries/<version>/*.tar.gz` 解压，按 `graphjin-<target-triple>` 命名
放进 `binaries/`（打包时随 `extraResources` 落到 `resources/binaries/`）。

```bash
# 下载官方发布包并校验 sha256（需要网络与 curl）
npm run fetch:binaries -- --only windows-amd64

# 解压并重命名当前平台的二进制
npm run prepare:binaries

# 真实执行 graphjin version，核对版本号（CI 三平台各跑一次）
npm run smoke:binaries
```

版本与校验信息见 `graphjin-binaries/version.json`，GraphJin 的实测行为记录在
[`docs/graphjin-3.21.14-baseline.md`](./docs/graphjin-3.21.14-baseline.md)。

## 数据与安全

| 内容 | 位置 |
|:--|:--|
| 数据目录 | 打包后 `userData/data`；`npm run backend` 时是 `sidecar-backend/data` |
| 用户库 / 连接记录 / 策略快照 | 数据目录下 `mcp-builder.db`（可用 `MCP_BUILDER_DB` 覆盖） |
| 加密密钥 | 数据目录下 `keystore.key`（可用 `MCP_BUILDER_DATA_DIR` 改目录） |
| 连接模板 | 数据目录下 `db-templates.json` |
| GraphJin 项目 | 连接页里填写的「项目目录」，例如 `projects/app/dev.yml` |

- 连接记录里的 `payload` 整段用 AES-256-GCM 加密（密钥复用 GraphJin keystore key），
  密码与连接串不落明文；列表只返回 host / port / dbname / user / path 等摘要。
- `keystore.key` 丢失后旧记录无法解密，界面会标记「需重新录入」，可回填非敏感字段后重测。
- 策略快照明文保存角色与表规则（不含数据库凭据），每个项目保留最近 30 份；
  写入前自动保存，可在权限矩阵的「写入历史」里回滚。

## 验证

```bash
cd sidecar-backend
npm test                 # 后端单测（133 项）

npm run verify:e2e       # 真机全链路：启动 → 发现 → 权限写入 → 快照回滚（24 项）

cd ..
npm run test:frontend    # 前端策略归一化 / diff（8 项）
npm run smoke:binaries   # GraphJin 二进制真实执行 version
npm run build
npm run verify:ui        # 真实后端 + Edge headless：中英文切换、建组织/成员、权限写入/验证/回滚（21 项）
npm run verify:ui -- --shots=docs/screenshots   # 逐页产出中英文截图
```

`verify:ui` 会自己起后端、建两个 SQLite 库（`app` / `analytics`），不依赖手工准备环境。

## 项目结构

```
electron/              Electron 主进程、preload（注入后端端口）
src/                   Vue 3 前端
  views/               6 个页面（路由懒加载）
  locales/             zh-CN / en-US 文案
  stores/app.js        Pinia：服务状态、Schema、权限矩阵、写入快照
sidecar-backend/       Node 后端
  src/                 JSON-RPC、GraphJin 客户端、权限编排、快照、连接存储
  test/                node:test 单测
  scripts/             真机验证脚本
scripts/               本地启动、演示库、二进制准备 / 冒烟、UI 冒烟
.github/workflows/     四平台打包 CI
docs/                  基线文档、功能矩阵、UI 截图
binaries/              GraphJin 二进制（构建期解压）
```

## 已知限制

- 安装包签名 / 公证未接入：CI 产出未签名包，macOS 首次打开需手动放行；
- `gj_security` 需要 admin JWT，策略真相来源是 MCP 的 `get_current_config`；
- `dev.yml` 合并覆盖项目生成格式、flow map、引号键与 GraphJin 回写格式，
  但不是通用 YAML 解析器：`databases:` 段一旦出现 anchors / aliases / merge keys
  会明确报错并拒绝合并，不会悄悄改坏文件；
- 非 Windows 平台目前只有 CI 的二进制 `version` 冒烟，完整 UI 冒烟仍是 Windows 本地脚本。

完整的「已完成 / 未完成」清单见 [docs/FEATURES.md](./docs/FEATURES.md)。

# 常见问题
## 策略预览中显示GraphJin未运行
以win11为例：进入build-mcp-server-4-any-db\binaries目录，执行cmd.exe
运行
``` bash
npm run prepare:binaries
graphjin-x86_64-pc-windows-msvc.exe serve

```