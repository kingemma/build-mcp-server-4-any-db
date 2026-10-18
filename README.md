# MCP Builder

**可视化配置 GraphJin，把任意数据库变成 MCP Server。**

[English](./README.en.md) · [功能进度](./docs/FEATURES.md)

MCP Builder 是一个桌面端工具：填好数据库连接，它会启动 GraphJin、发现表结构，并把
「角色 × 表 × 操作」的权限写成 GraphJin 配置。最终产出的是一个可直接接入 Claude、
Cursor 等 MCP 客户端的 HTTP 端点（`/api/v1/mcp`），不需要手写 YAML，也不需要理解
GraphJin 的配置细节。

![数据库连接页](./docs/screenshots/zh-CN/connections.png)

## 目录

- [架构](#架构)
- [功能](#功能)
- [环境要求](#环境要求)
- [安装与运行](#安装与运行)
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
- 未启动服务也能测试连接：后端会临时拉起一个用完即停的 GraphJin 实例。

### Schema 浏览器

顶部列出运行中实例实际加载的数据库，切换后按库加载表、列与外键关系（`query_catalog`
带 `database_name` 过滤，多库数据不会串）。

![Schema 浏览器](./docs/screenshots/zh-CN/schema.png)

### 权限矩阵

角色 × 表 × 四项操作（Query / Insert / Update / Delete）开关，额外支持：

- 行过滤条件（GraphJin DSL）；
- 列管控：白名单，或「阻止列表」自动转成补集白名单（GraphJin 的 `columns` 只接受数组）；
- 查询默认 `limit`。

写入前展示逐项 diff 并二次确认。

![权限矩阵](./docs/screenshots/zh-CN/permissions.png)

### 策略预览

从 `get_current_config` 读取当前生效的角色策略，和待写入的矩阵做 diff。

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
| GraphJin 二进制 | 需要自行准备（见下节），仓库不提交二进制 |
| 浏览器（可选） | `verify:ui` 需要本机 Edge / Chrome |

## 安装与运行

```bash
npm install
```

### 桌面端开发

```bash
# 终端 1：Vite 开发服务器（127.0.0.1:1420）
npm run dev

# 终端 2：Electron 载入开发服务器，并在进程内启动后端
npm run electron:dev
```

### 纯浏览器调试

```bash
npm run backend     # 打印 ready JSON，其中 port 即后端端口
npm run dev         # 浏览器打开 http://127.0.0.1:1420
```

打开「设置」页填入后端端口，点「保存并连接」即可。

### 构建 Windows 安装包

```bash
npm run dist:win    # 产物：release-final/
```

## GraphJin 二进制

构建期从 `graphjin-binaries/<version>/*.tar.gz` 解压，按 `graphjin-<target-triple>` 命名
放进 `src-tauri/binaries/`（打包时随 `extraResources` 落到 `resources/binaries/`）。

```bash
# 下载官方发布包并校验 sha256（需要网络与 curl）
npm run fetch:binaries -- --only windows-amd64

# 解压并重命名当前平台的二进制
npm run prepare:binaries
```

版本与校验信息见 `graphjin-binaries/version.json`，GraphJin 的实测行为记录在
[`docs/graphjin-3.21.14-baseline.md`](./docs/graphjin-3.21.14-baseline.md)。

## 数据与安全

| 内容 | 位置 |
|:--|:--|
| 数据目录 | 打包后 `userData/data`；`npm run backend` 时是 `sidecar-backend/data` |
| 用户库 / 连接记录 | 数据目录下 `mcp-builder.db`（可用 `MCP_BUILDER_DB` 覆盖） |
| 加密密钥 | 数据目录下 `keystore.key`（可用 `MCP_BUILDER_DATA_DIR` 改目录） |
| 连接模板 | 数据目录下 `db-templates.json` |
| GraphJin 项目 | 连接页里填写的「项目目录」，例如 `projects/app/dev.yml` |

- 连接记录里的 `payload` 整段用 AES-256-GCM 加密（密钥复用 GraphJin keystore key），
  密码与连接串不落明文；列表只返回 host / port / dbname / user / path 等摘要。
- `keystore.key` 丢失后旧记录无法解密，界面会标记「需重新录入」，可回填非敏感字段后重测。
- 策略写入没有回滚快照：legacy 模式下 `update_current_config` 立即生效。

## 验证

```bash
cd sidecar-backend
npm test                 # 后端单测（104 项）

npm run verify:e2e       # 真机全链路：启动 → 发现 → 权限写入（17 项）

cd ..
npm run build
npm run verify:ui        # 真实后端 + Edge headless，含中英文切换（10 项）
npm run verify:ui -- --shots=docs/screenshots   # 逐页产出中英文截图
```

`verify:ui` 会自己起后端、建两个 SQLite 库（`app` / `analytics`），不依赖手工准备环境。

## 项目结构

```
electron/              Electron 主进程、preload（注入后端端口）
src/                   Vue 3 前端
  views/               6 个页面
  locales/             zh-CN / en-US 文案
  stores/app.js        Pinia：服务状态、Schema、权限矩阵
sidecar-backend/       Node 后端
  src/                 JSON-RPC、GraphJin 客户端、权限编排、连接存储
  test/                node:test 单测
  scripts/             真机验证脚本
scripts/               二进制准备、UI 冒烟
docs/                  基线文档、功能矩阵、UI 截图
src-tauri/binaries/    GraphJin 二进制（构建期解压）
```

## 已知限制

- 权限矩阵的表清单来自全部已发现表，尚未按选中库过滤；
- macOS / Linux 安装包、代码签名与 CI 尚未接入；
- `gj_security` 需要 admin JWT，策略真相来源是 MCP 的 `get_current_config`；
- `dev.yml` 合并是文本级操作，只识别本项目生成的缩进格式。

完整的「已完成 / 未完成」清单见 [docs/FEATURES.md](./docs/FEATURES.md)。
