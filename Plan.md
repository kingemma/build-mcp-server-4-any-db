# MCP Server 可视化构建平台 — 最终开发方案

> **配套文档**：`docs/graphjin-3.21.14-baseline.md` —— GraphJin v3.21.14 实测事实基线（本机真机验证，非推测）。
> 本文涉及 GraphJin API 与配置形态的描述均已按基线修订，标注「**实测修正**」的位置即原假设被推翻之处。

## 一、方案概述

基于 GraphJin CLI 构建跨平台（Windows/macOS/Linux）的 MCP Server 可视化配置平台，采用 **Tauri 2 + Vue 3 + Node.js** 技术栈。核心设计围绕两个关键能力展开：**GraphJin 二进制的双模式管理**（本地预置 + 安装时可选在线更新）和**表级 RBAC 权限的可视化配置**（只读/读写/更新/删除）。


**核心架构决策**：

| 层次 | 技术选型 | 职责 |
|:---|:---|:---|
| 桌面框架 | Tauri 2 (Rust) | 窗口管理、sidecar 进程生命周期、文件系统访问、IPC |
| 前端 | Vue 3 + Vite + TypeScript | 可视化界面：数据库管理、权限矩阵、MCP 监控 |
| 后端服务 | Node.js (pkg 编译为二进制) | GraphJin API 封装、配置编排、用户/组织管理 |
| 底层引擎 | GraphJin CLI (sidecar) | Schema 发现、GraphQL 编译、RBAC 执行、MCP 协议暴露 |

Tauri 应用有两个进程：核心进程（Rust 后端）和 WebView 进程（Vue 前端），Node.js 后端服务作为 sidecar 运行，GraphJin CLI 则作为另一个 sidecar 由 Node.js 后端服务或 Rust 核心直接管理。


## 二、GraphJin 二进制管理（仅本地预置）

开始前先下载最新的版本， 并自动更新目录版本号
https://github.com/dosco/graphjin/tree/wasm/v3.2.0

### 2.1 本地预置策略

在项目仓库中维护一个 `graphjin-binaries/` 目录，存放从 GraphJin 官方 Releases 下载的各平台最新稳定版二进制。GraphJin 官方发布了覆盖所有主流平台的构建产物，包括 `graphjin_<version>_windows_amd64.tar.gz`、`graphjin_<version>_linux_amd64.deb`、`graphjin_<version>_darwin_arm64.tar.gz` 等。


**预置目录结构**：
```
graphjin-binaries/
├── v3.21.14/
│   ├── graphjin-x86_64-pc-windows-msvc.exe
│   ├── graphjin-x86_64-unknown-linux-gnu
│   ├── graphjin-aarch64-unknown-linux-gnu
│   ├── graphjin-x86_64-apple-darwin
│   └── graphjin-aarch64-apple-darwin
├── checksums.txt
└── version.json
```

**构建时复制脚本**（`scripts/prepare-binaries.js`）：

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = 'v3.21.14';
const SOURCE_DIR = path.join(__dirname, '..', 'graphjin-binaries', VERSION);
const TARGET_DIR = path.join(__dirname, '..', 'src-tauri', 'binaries');

// 目标三元组映射
const TRIPLE_MAP = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

const triple = TRIPLE_MAP[`${os.platform()}-${os.arch()}`];
const ext = os.platform() === 'win32' ? '.exe' : '';
const srcFile = path.join(SOURCE_DIR, `graphjin-${triple}${ext}`);
const dstFile = path.join(TARGET_DIR, `graphjin-${triple}${ext}`);

// 复制并保持文件名包含目标三元组
fs.copyFileSync(srcFile, dstFile);
console.log(`Copied ${srcFile} → ${dstFile}`);
```

Tauri 要求 sidecar 二进制文件以 `-$TARGET_TRIPLE` 后缀命名，例如 `graphjin-x86_64-unknown-linux-gnu`。此脚本确保构建时自动将对应平台的 GraphJin 二进制复制到 `src-tauri/binaries/` 目录并重命名。

> **实测修正（v3.21.14）**：官方产物名是 `graphjin_<ver>_<os>_<arch>.tar.gz`（`os ∈ darwin/linux/windows`，`arch ∈ amd64/arm64`），
> **不按 Rust 三元组发布**。因此三元组只用于「下载后重命名」，不用于拼下载地址。
> 另外单平台 `graphjin.exe` 解压后为 **158.6 MiB**：仓库内建议只保存压缩态 `*.tar.gz`（各 42–48 MB），
> 构建时再解压重命名，避免把近 800 MB 的解压产物提交进 git。详见 `docs/graphjin-3.21.14-baseline.md` §1。

**不做运行时在线更新**：GraphJin 二进制只在构建期预置、随安装包分发。应用运行时
不访问 GitHub Releases、不下载替换二进制。这样省掉 `graphjin_updater.rs`（reqwest 依赖、
下载/校验/原子替换逻辑），消除「升级时 sidecar 文件被占用导致替换失败」的风险，
同时保证离线可用与版本号可复现。

升级路径是**发新版桌面端**：维护者改 `graphjin-binaries/version.json` 里的版本号，
跑 `scripts/fetch-binaries.js` 重新拉取并校验，用户升级应用即获得新 GraphJin。
设置页只展示内置版本（解析 `graphjin version` 输出），提供「复制版本信息」而非「检查更新」。

### 2.2 Tauri Sidecar 配置

在 `tauri.conf.json` 中声明 GraphJin 和 Node.js 后端两个 sidecar：

```json
{
  "bundle": {
    "externalBin": [
      "binaries/graphjin",
      "binaries/backend"
    ]
  }
}
```

在 `src-tauri/capabilities/default.json` 中授予执行权限：

```json
{
  "permissions": [
    "shell:allow-spawn",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "binaries/graphjin",
          "sidecar": true,
          "args": true
        },
        {
          "name": "binaries/backend",
          "sidecar": true,
          "args": true
        }
      ]
    }
  ]
}
```


## 三、Node.js 后端服务

### 3.1 打包方式

Node.js 后端使用 `@yao-pkg/pkg`（维护版 `pkg`）编译为自包含二进制文件，作为 Tauri sidecar 运行，终端用户无需安装 Node.js。

```
sidecar-backend/
├── src/
│   ├── index.js          # 入口，启动 HTTP 服务
│   ├── graphjin.js       # GraphJin API 封装
│   ├── permissions.js    # 权限配置编排
│   └── users.js          # 用户/组织管理
├── package.json
└── build.js              # pkg 编译 + 重命名脚本
```

`package.json` 中的编译脚本：

```json
{
  "scripts": {
    "build:sidecar": "pkg src/index.js --targets node18 --output dist/backend && node rename.js"
  }
}
```

### 3.2 GraphJin API 封装

Node.js 后端通过 **MCP HTTP 端点 `/api/v1/mcp`** 管理配置，而不是 GraphQL 端点。

> **实测修正（v3.21.14）**：GraphQL 端点 `/api/v1/graphql` 的 `gj_*` root 受角色门禁控制，
> dev 模式的 `X-User-Role` 头在 GraphQL 上**不生效**（实测仍为 `anon`，返回
> `unauthorized: Query blocked: gj_config (role: anon)`），需要真正的 JWT。
> 而 MCP 端点认 `X-User-Role`，且把配置读写封装成了工具。改走 MCP。

**传输约束（必须遵守，否则 400 / 会话错误）**：

- 请求头 `Accept` 必须同时含 `application/json` 与 `text/event-stream`
- 响应恒为 SSE（`Content-Type: text/event-stream`），需解析 `data: ` 帧
- `initialize` 响应头下发 `Mcp-Session-Id`，后续请求必须回传
- 握手顺序：`initialize` → `notifications/initialized` → 其它方法

**可用工具**（随开关与角色变化）：

| 条件 | 工具 |
|:---|:---|
| `mcp.allow_config_updates: true` | `validate_config` |
| 再叠加 `X-User-Role: admin` | `get_current_config`、`update_current_config` |
| `system.capabilities.config.write: true` | 配置写能力的第二道开关 |
| 始终存在 | `query_catalog`、`execute_graphql`、`execute_saved_query`、`validate_where_clause`、`graphql_help`、`ask_graphjin_agent` |

> `--demo` 模式下即使带 admin 头也**不**注册配置类工具，平台须用 `serve --path <项目目录>` 自建项目。

关键 API 封装：

```javascript
// graphjin-mcp.js
// 一次 MCP 会话：initialize -> notifications/initialized -> 业务调用
async function mcpSession(toolName, args, role = 'admin') {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'X-User-Role': role,
  };
  const init = await post('/api/v1/mcp', {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-builder', version: '0.1' } },
  }, headers);
  const sessionId = init.headers.get('Mcp-Session-Id');
  headers['Mcp-Session-Id'] = sessionId;

  await post('/api/v1/mcp', { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, headers);
  return post('/api/v1/mcp', {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: toolName, arguments: args },
  }, headers);
}

// 不带 revision 调一次，错误响应里会返回当前 catalog_revision
async function readCatalogRevision() {
  const res = await mcpSession('update_current_config', { mode: 'preview' });
  return res.catalog_revision;
}

async function previewConfig(patch) {
  return mcpSession('update_current_config', {
    ...patch,
    mode: 'preview',
    expected_catalog_revision: await readCatalogRevision(),
  });
}

// apply 必须复用与 preview 完全相同的 payload
async function applyConfig(patch, revision, previewId) {
  return mcpSession('update_current_config', {
    ...patch,
    mode: 'apply',
    expected_catalog_revision: revision,
    preview_id: previewId,
  });
}
```

> `preview_id` 前缀 `cfgprev_`，**10 分钟过期**，且要求 payload 与 preview 完全一致。

### 3.3 权限配置编排

这是平台的核心业务逻辑。**决策：采用方案 B —— 不使用 `sources`，走 legacy 的
`databases` + `roles[].tables`**，以拿到「角色 × 表 × query/insert/update/delete 四项独立开关」的完整粒度。

> **实测结论（v3.21.14，已端到端跑通）**
> - 配置 `sources` 时 `roles[].tables` 会被拒：
>   `roles["analyst"].tables is legacy table access config and is not supported when sources is configured`。
> - 改用 `databases:`（map）且不配 `sources` 后，`roles[].tables[].query/insert/update/delete`
>   全部通过校验并正确落盘（`block: true`、`filters`、`limit` 均完整写入 YAML）。
> - 代价：这是 GraphJin 官方标为 `risk_level: high` 的路径
>   （catalog 中存在 `recipe.config.migrate_legacy_roles_tables`），需接受未来版本可能移除的风险，
>   并在设置页对用户明示。

**方案 B 的三条硬约束（实测踩坑，实现必须遵守）**：

1. **必须用 `databases:` map，不能用单数 `database:`**。
   实测单数形式下调用 `update_current_config` 会**服务端 panic**
   （`panic: assignment to entry in nil map`，进程直接退出）。
2. **角色表规则必须带 `database: <库名>`**。
   否则规则会挂到内部库 `__gj_internal_artifacts` 上，报 `table not found: main.<table>`。
3. **legacy 模式没有 preview/apply 两阶段**。
   传 `mode: "preview"` 也会**立即生效并返回 success**，不返回 `preview_id`；
   因此平台侧必须自行做 diff 与二次确认，再调用写入。

平台后端负责把 UI 中的权限矩阵转换为如下配置：

```javascript
// permissions.js

/**
 * 将平台内部权限矩阵转换为 GraphJin legacy 模式配置（方案 B）
 * @param {string} database - 目标库名；缺省会让规则落到 __gj_internal_artifacts
 * @param {Object} matrix - { roleName: { tableName: { query, insert, update, delete } } }
 *                          每项形如 { enabled, filters: string[], columns: string[], limit?: number }
 * @returns {Object} 可直接作为 update_current_config 的 roles 参数
 */
function buildRoleTableConfig(database, matrix) {
  const roles = [];

  for (const [role, tables] of Object.entries(matrix)) {
    const roleTables = [];

    for (const [table, ops] of Object.entries(tables)) {
      roleTables.push({
        name: table,
        database: database,
        query: buildOperation(ops.query, { withLimit: true }),
        insert: buildOperation(ops.insert),
        update: buildOperation(ops.update),
        delete: buildOperation(ops.delete),
      });
    }

    roles.push({ name: role, tables: roleTables });
  }

  return { roles: roles };
}

/**
 * 单项操作配置；关闭时统一写 block: true
 * @param {{enabled?: boolean, filters?: string[], columns?: string[], limit?: number}} op
 * @param {{withLimit?: boolean}} [options] - 仅 query 支持 limit
 */
function buildOperation(op, { withLimit = false } = {}) {
  if (!op || op.enabled === false) {
    return { block: true };
  }

  const result = { block: false };
  if (Array.isArray(op.filters) && op.filters.length > 0) result.filters = op.filters;
  if (Array.isArray(op.columns) && op.columns.length > 0) result.columns = op.columns;
  if (withLimit && typeof op.limit === 'number') result.limit = op.limit;
  return result;
}
```

**权限模型**：平台内部维护 `用户/组织 → 角色 → 表 → 操作` 的映射。每张表对每个角色有
**query（只读）、insert（写入）、update（更新）、delete（删除）** 四项独立开关，每项可再挂
**行过滤器**（GraphJin DSL，如 `{ org_id: { _eq: $user.org_id } }`）与**列白名单**；
关闭的项统一写成 `block: true`。

**运行时行为（实测，16 项断言全通过，脚本 `sidecar-backend/scripts/verify-plan-b.js`）**：

| 行为 | 实测结果 | 对前端的影响 |
|:---|:---|:---|
| insert/update/delete 被拦 | 返回 `errors`：`Insert blocked: <table> (role: <role>)` | 可直接展示错误文案 |
| query 被拦 | **不报错**，`data.<root>` 为 `null`，`state_code` 仍是 success | 判断拦截要看 `data === null`，不能只看 `errors` |
| 行过滤 `filters` | 生效 | — |
| `query.limit` | **只是默认值，不是强制上限**；查询显式带 `limit` 会覆盖它 | UI 不能宣传为「最多返回 N 行」 |
| 角色未定义 | `roles '<role>' not defined in c.gj.config`（**含 `admin`**） | 平台必须显式创建 `admin` 角色才能以它执行 GraphQL |

### 3.4 通信方式

Node.js 后端与 Tauri 核心进程之间使用 **stdin/stdout JSON-RPC** 通信。后端启动时监听 stdin 上的 JSON 行，处理后通过 stdout 返回结果。同时后端也启动一个本地 HTTP 服务（动态分配端口，避免硬编码冲突），供 Vue 前端通过 Tauri IPC 获取端口号后直接调用。


## 四、Vue 3 前端界面

### 4.1 项目结构

```
src/
├── App.vue
├── main.ts
├── views/
│   ├── DatabaseManager.vue    # 数据库连接管理
│   ├── SchemaBrowser.vue      # Schema 浏览器
│   ├── PermissionMatrix.vue   # 表级权限矩阵（核心）
│   ├── SecurityPreview.vue    # 安全策略预览
│   ├── McpMonitor.vue         # MCP Server 监控
│   └── Settings.vue           # 设置（GraphJin 版本管理）
├── components/
│   ├── PermissionTable.vue    # 权限矩阵表格组件
│   ├── RowFilterEditor.vue    # 行过滤器编辑器
│   └── ColumnSelector.vue     # 列允许/阻止选择器
├── stores/                    # Pinia 状态管理
│   ├── databases.ts
│   ├── permissions.ts
│   └── graphjin.ts
└── api/                       # 后端 API 调用封装
    ├── databases.ts
    └── permissions.ts
```

### 4.2 核心界面：表级权限矩阵

权限矩阵是平台的核心交互界面，以表格形式展示所有数据库表与角色的权限对应关系：

| 表名 | 角色 | 只读 (Query) | 读写 (Insert) | 更新 (Update) | 删除 (Delete) | 行过滤 | 列管控 |
|:---|:---|:---|:---|:---|:---|:---|:---|
| users | admin | ✅ | ✅ | ✅ | ✅ | — | — |
| users | viewer | ✅ | ❌ | ❌ | ❌ | `org_id = $user.org_id` | block: [email] |
| orders | admin | ✅ | ✅ | ✅ | ✅ | — | — |
| orders | staff | ✅ | ✅ | ✅ | ❌ | `region = $user.region` | — |

**交互流程**：
1. 用户选择角色和组织
2. 系统从 GraphJin 获取该数据源的所有表
3. 用户通过勾选框配置每张表的四项权限
4. 点击“应用”时先在平台侧计算逐项 diff，并展示二次确认（legacy 模式没有 GraphJin preview）
5. 确认前自动把当前 `roles` 保存为快照；确认后调用 `update_current_config` 写入
6. 应用成功后重载生效策略；需要时可在“写入历史”里回滚到任意快照

### 4.3 MCP Server 监控

展示 GraphJin 的运行状态、MCP 端点地址和可用工具列表，提供一键生成客户端配置的功能。GraphJin 的 `mcp info` 命令可输出 Claude Desktop 等客户端的配置 JSON。


## 五、开发任务计划

### 阶段 0：基础设施搭建（1.5 周）

| 任务 | 内容 |
|:---|:---|
| 0.1 | 下载 GraphJin **v3.21.14** 全平台 `*.tar.gz`（各 42–48 MB）与 `checksums.txt`，建立 `graphjin-binaries/v3.21.14/`，写 `version.json` 记录版本与 SHA256（已完成：`scripts/fetch-binaries.js`，6 个平台全部校验通过） |
| 0.2 | 初始化桌面外壳 + Vue 3 + Vite 项目（**已改为 Electron 44.7.0**：`electron/main.js` + `electron/preload.js`，渲染进程复用现有 Vue 构建产物） |
| 0.3 | Node.js 后端（**不再需要 pkg 打包**：Electron 主进程直接 `require` 后端，`createBackend()` 返回可编程启停的实例。Electron 44 内置 Node 24.21.0，`node:sqlite` 可用） |
| 0.4 | 编写 `scripts/prepare-binaries.js`（下载走 `scripts/fetch-binaries.js`），构建时把当前平台的 GraphJin 二进制复制/解压到 `src-tauri/binaries/` 并按目标三元组命名（已完成；注意 `os.platform()` 返回 `win32`，需映射成 `windows`） |
| 0.5 | 配置打包资源：`build.files` 含 `dist / electron / sidecar-backend/src / sidecar-backend/package.json / scripts/platforms.js`，`extraResources` 把 `src-tauri/binaries/graphjin-*` 放到 `resources/binaries/`；`electronDist` 复用已解压的 Electron，避免重复下载 |
| 0.6 | 验证：`electron-builder --win nsis` 产出 `release-win/MCP Builder Setup 0.1.0.exe`（150 MB），打包产物实测可启动（进程内后端 :65339、数据落 `%APPDATA%\mcp-builder\data`） |

> **Windows 构建环境（2026-10-17 实测）**
>
> - `rustup` 已装好（rustc/cargo 1.99.1，`x86_64-pc-windows-msvc` 含 rust-std）。
> - **本机必须走系统代理**：`HTTPS_PROXY=http://127.0.0.1:7897`，否则 `rustup` / `cargo` 直连
>   `static.rust-lang.org`、`crates.io` 全部 `tls handshake eof`；curl 走 WinHTTP 代理所以看着是通的。
> - **缺 C++ 工具链**：VS 2026 Community 已装但 `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`
>   不存在，`Windows Kits\10\Lib` 也不存在 → `cargo build` 报 `linker link.exe not found`。
>   补装需要提权，自动化环境里 UAC 无法确认，需手工执行：
>
>   ```powershell
>   # 管理员 PowerShell
>   & "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
>     --installPath "C:\Program Files\Microsoft Visual Studio\18\Community" `
>     --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --norestart
>   ```
>
> - 装完后 cargo 需要在 VS 开发者环境下运行（`VsDevCmd.bat -arch=x64`），或直接用
>   `tauri build`（CLI 会自己找）。
> - **必须从真正的管理员窗口执行**：本机 `EnableLUA=1`、`ConsentPromptBehaviorAdmin=5`、
>   `PromptOnSecureDesktop=1`，UAC 弹窗在安全桌面上，脚本/自动化点不到，`Start-Process -Verb RunAs`
>   会静默超时。用 Win+X →「终端(管理员)」，先自检
>   `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')`
>   返回 `True` 再执行上面的命令（非提权时会直接 `Exit Code: 5007`）。
> - 备用方案（不推荐）：`rustup target add x86_64-pc-windows-gnu` + MinGW-w64。gnu 目标能编译，
>   但产物需要额外带 `libgcc/libstdc++/libwinpthread` 运行时 DLL，NSIS 打包要自己补，且 Tauri
>   官方只保证 MSVC，故仅作最后手段。
>
> **决定**：桌面外壳改用 **Electron 44.7.0**（2026-10-17）。上述 Tauri/MSVC 阻塞不再影响主线，
> `src-tauri/` 保留作为备选，不参与当前构建。

> **Electron 打包踩坑（均已验证修复）**
>
> - 后端 `src/index.js` 启动时读 `sidecar-backend/package.json` 取版本号，`build.files` 必须包含它，
>   否则打包后报 `ENOENT ... sidecar-backend\package.json not found in app.asar`。
> - `vite.config.js` 必须 `base: './'`、路由必须 **hash 模式**，否则 `file://` 下资源 404、路由空白。
> - 端口通过 `webPreferences.additionalArguments` + preload 同步注入，渲染进程不必等 IPC。
> - `electronDist` 指向 `node_modules/electron/dist`，跳过 158 MB 的重复下载。
> - 同一输出目录重复构建会被环境里的 safe-delete 拦截（`trash` 操作失败），换 `directories.output`
>   或先手工清空即可。

### 阶段 1：Node.js 后端服务（3 周）

| 任务 | 内容 |
|:---|:---|
| 1.1 | 实现本地 HTTP 服务框架，动态分配端口，通过 stdin/stdout 与 Tauri 通信（已实现：`src/index.js` + `src/rpc.js`，一套路由同时挂 stdio 与 `POST /rpc`） |
| 1.2 | 封装 MCP 客户端（会话保持、SSE 解析、`X-User-Role` 头）与连接管理：用 `get_current_config` 读生效配置，用 `update_current_config` 的 `databases` 写连接信息（**只输出 `databases:` map，绝不写 `sources`**） |
| 1.3 | 封装 Schema 发现 API（已实现：`src/schema.js`）。`query_catalog` 用 `where: {kind: {eq: ...}}` 过滤 table/column/relationship，单次 `limit` 上限 500、需按 `offset` 翻页直到 `truncated` 为 false；列定义优先从 table 卡片的 `details_json[].data_json.columns` 取，取不到再退回 `kind=column` 查询。RPC 方法 `schema.discover` / `schema.tables`。**仍未验证**：`audit_role_permissions` 等 dev tools 的启用条件 |
| 1.4 | 封装权限配置 API：legacy 模式下 `update_current_config` 立即生效，故平台侧先算 diff + 二次确认再写入；写入前自动保存 `roles` 快照，`permissions.rollback` 可恢复并清理本次新增角色（已实现：`src/snapshots.js`） |
| 1.5 | 实现 `buildRoleTableConfig(database, matrix)`（方案 B）：输出 `roles[].tables[]`，每项带 `database` 字段与 query/insert/update/delete 四项开关 |
| 1.6 | 实现用户/组织管理模块：本地 SQLite 存储，与 GraphJin RBAC 角色映射（已实现：`src/users.js`，用 Node 内置 `node:sqlite`，避免原生依赖给后续 pkg 打包添麻烦；`syncRolesToGraphJin` 负责把本地角色补进 GraphJin） |
| 1.7 | 实现 GraphJin 进程管理（已实现：`src/supervisor.js` + `graphjin.start/stop/status/health` RPC）。崩溃自动重启：窗口内（默认 60s）最多重启 3 次，超限记 `lastError` 并放弃；二进制按 显式入参 > `GRAPHJIN_BIN` > `src-tauri/binaries/<三元组>` 解析 |
| 1.8 | 实现 MCP 客户端配置生成（已实现：`src/mcp-config.js` + `mcp.clientConfig` / `mcp.clients` / `mcp.endpoint`）。默认输出 **HTTP 传输**直连 `/api/v1/mcp`（官方 `mcp add` 也会把 URL 规范化到该端点）；CLI 命令用已验证存在的 `graphjin mcp add claude\|codex\|all <url>`；stdio 形态仅作兜底并标注 v3.21.14 内置 proxy 的 400 缺陷 |

### 阶段 2：Vue 3 前端开发（4 周）

| 任务 | 内容 |
|:---|:---|
| 2.1 | 搭建 Vue 3 项目骨架：路由、Pinia 状态管理、Element Plus / Naive UI 组件库（已实现：`src/main.js` + `router/` + `stores/app.js`，Element Plus 深色覆盖见 `styles/main.css`） |
| 2.2 | 数据库连接管理界面：表单（类型/主机/端口/认证）、连接测试、连接列表（已实现：`views/ConnectionsView.vue`，只输出 `databases` map） |
| 2.3 | Schema 浏览器：树形展示数据库 → 表 → 列，展示列类型和关系（已实现：`views/SchemaView.vue`） |
| 2.4 | **权限矩阵界面**（核心）：角色选择器 + 表格布局，每行一个表，列为 Query/Insert/Update/Delete 开关（已实现：`views/PermissionsView.vue`） |
| 2.5 | 行过滤器编辑器：为每个角色的每张表配置行级过滤条件（已实现：矩阵单元格下方的「规则」入口，按**操作**独立编辑 filters） |
| 2.6 | 列管控选择器：配置列允许/阻止列表（已实现：allow / block 双模式；block 在写入前展开成**补集白名单**，依据基线 §6.6） |
| 2.7 | 安全策略预览面板：展示当前生效策略和变更 diff（已实现：`views/PolicyView.vue` + `utils/policy.js` + RPC `config.current`。`gj_security` 需 admin JWT 实测不可达，策略真相来源改为 `get_current_config`） |
| 2.8 | MCP 监控面板：运行状态、端点地址、工具列表、一键复制客户端配置（已实现：`views/StatusView.vue`） |
| 2.9 | 设置页面：显示内置 GraphJin 版本（解析 `graphjin version`）、「复制版本信息」；**不做在线更新**（已实现：`views/SettingsView.vue`，版本读 `graphjin-binaries/version.json`） |
| 2.10 | 数据库连接类型扩展（新增需求，已实现：`sidecar-backend/src/db-types.js` + `keystore.js`，RPC `db.types` / `db.templates.*` / `connections.test`）。内置 13 种白名单类型 + 用户自定义**别名模板**（TiDB 等兼容库只能以 postgres/mysql 协议接入）；录入支持**字段 / 连接串 / 文件路径**三种形态；后端自动生成并注入 `GJ_SECRETS_KEYSTORE_KEY`（base64、解码后 32 字节，见基线 §12.4），否则带密码的库配不进去 |

> **写入前二次确认**：legacy 模式更新立即生效（基线 §6.4），
> 权限矩阵点「应用到 GraphJin」时先弹 diff 对话框（`from → to` + 附加规则）再写入。

### 阶段 3：集成与 CI/CD（1 周，已去除在线更新相关任务）

| 任务 | 内容 |
|:---|:---|
| 3.1 | 封装 sidecar 生命周期：拉起 / 停止 / 重启 GraphJin 与后端，解析启动横幅取端口（**已由 Electron 主进程接管**：后端在进程内 `createBackend()`，GraphJin 仍由 `supervisor.js` 拉起并从横幅解析端口） |
| 3.2 | 应用退出与升级时的 sidecar 清理（先 kill 再退出，避免文件占用）（**已实现**：`app.on('before-quit')` 先 `backend.stop()` → `supervisor.stop()` 再退出） |
| 3.3 | 设置页：展示内置 GraphJin 版本（`graphjin version`），提供「复制版本信息」，**不做在线更新**（已实现） |
| 3.4 | 编写各平台 CI/CD 构建脚本（GitHub Actions）：拉二进制 → 校验 → `prepare-binaries` → `electron-builder`（**已完成**：`.github/workflows/build.yml`，Windows / macOS 13 / macOS 14 / Ubuntu 矩阵，二进制 `version` 冒烟 + 安装包上传） |

### 阶段 4：测试与打包（1.5 周）

| 任务 | 内容 |
|:---|:---|
| 4.1 | 端到端测试：添加数据库 → 浏览 Schema → 配置权限 → 启动 MCP → 客户端连接验证（已实现：`scripts/verify-e2e.js`，24 项断言全通过。全链路走真实入口：拉起后端 → HTTP `/rpc` → 建库/发现/配权限/起 GraphJin → 用生成的客户端配置真实建立 MCP 会话 → 快照回滚） |
| 4.2 | 权限验证测试：验证只读角色无法执行 insert/update/delete（已实现：同一脚本内断言 `Insert/Update/Delete blocked`、`db column blocked`、query 被拦静默返回 null） |
| 4.3 | 跨平台打包：Windows NSIS（**已完成**：`release-final/MCP Builder Setup 0.1.0.exe`）；macOS dmg/zip 与 Linux AppImage/deb 的 electron-builder 配置、`dist:mac` / `dist:linux` 脚本和 GitHub Actions 矩阵已完成，本机仅实测 Windows |
| 4.4 | macOS 代码签名和公证（**未做**：需要 Apple Developer 证书；CI 当前显式跳过签名发现） |
| 4.5 | 用户文档和快速入门向导（**已完成**：中英文 README、功能进度表、Docker 测试库说明、截图） |

| 阶段 | 周期 | 核心交付物 |
|:---|:---|:---|
| 阶段 0 | 1.5 周 | 项目骨架 + GraphJin 二进制预置 + sidecar 配置 |
| 阶段 1 | 3 周 | Node.js 后端服务（GraphJin 封装 + 权限编排 + 用户管理） |
| 阶段 2 | 4 周 | Vue 3 可视化界面（数据库管理 + 权限矩阵 + MCP 监控） |
| 阶段 3 | 1 周 | sidecar 生命周期 + 集成 + CI/CD |
| 阶段 4 | 1.5 周 | 三平台安装包 + 测试报告 |
| **总计** | **11 周** | **可发布的跨平台 MCP Server 构建平台** |


## 六、关键风险与缓解

| 风险 | 说明 | 缓解措施 |
|:---|:---|:---|
| **GraphJin source mode 限制** | 配置 `sources` 后 `roles[].tables` 被拒（**已实测证实**） | 已决策采用方案 B：不配 `sources`，改用 `databases` + `roles[].tables`，详见 §3.3 |
| **方案 B 属 legacy 路径**（已决策采用） | `roles[].tables` 被 GraphJin 官方标为 `risk_level: high` 迁移项（catalog 有 `recipe.config.migrate_legacy_roles_tables`），未来版本可能移除 | 权限编排集中在 `permissions.js` 一处，便于将来整体切回 `sources[].access`；设置页对用户明示 |
| **legacy 模式是立即生效的**（新增） | 不配 `sources` 时 `update_current_config` 即使传 `mode:"preview"` 也直接写入，不返回 `preview_id` | 平台侧先自算 diff 并弹二次确认，再调用写入；保留写入前的配置快照以支持回滚 |
| **单数 `database:` 会 panic**（新增） | legacy 单库写法下调用 `update_current_config` 触发服务端 `panic: assignment to entry in nil map`，进程退出 | 生成器只输出 `databases:` map；后端启动时校验配置形态，发现 `sources` 或单数 `database` 直接报错 |
| **配置更新需三步操作** | `update_current_config` 必须先取 `catalog_revision`，再 `preview` 拿 `preview_id`，最后 `apply`；`preview_id` 10 分钟过期且要求 payload 完全一致 | UI 中设计确认对话框，展示 `changes` / `findings_json` 后再执行 apply；过期自动重新 preview |
| **MCP 传输约束**（新增） | Accept 头缺一不可、响应是 SSE、必须回传 `Mcp-Session-Id`、握手顺序固定 | 后端封装统一的 MCP 客户端，禁止各处裸 `fetch` |
| **GraphQL root 不可直接调用**（新增） | `/api/v1/graphql` 的 `gj_*` root 在 anon 下被拦截，dev 头不生效，需真 JWT | 一律走 MCP 工具；确需 GraphQL 时再设计 JWT 签发方案 |
| **内置 CLI 不可用**（新增） | v3.21.14 的 `graphjin cli` / `mcp --server` 有缺陷（见基线 §8），全部子命令失败 | 平台自实现 MCP 客户端，不依赖内置 CLI |
| **sidecar 二进制体积**（升级） | 单平台 `graphjin` 解压后 158.6 MiB，全平台近 800 MB | 仓库只存压缩态 `*.tar.gz`，构建时解压；安装包仅含当前平台 |
| **权限变更需重载** | 部分权限变更需要 Schema reload 或重启 GraphJin | 封装“应用并重载”按钮，UI 中明确提示需要重载 |
| **sidecar 二进制锁定** | Windows 安装升级时 sidecar 进程可能锁定文件导致替换失败 | 升级前先 kill sidecar 进程，或使用版本化目录避免覆盖 |
| **macOS Gatekeeper** | 预置的 GraphJin 二进制需要代码签名 | 构建流程中对二进制进行签名，或在文档中指导用户处理 |
| **Node.js 后端体积** | `pkg` 编译的 Node.js 二进制体积较大（约 40-50MB） | 使用 `node18` target 并启用压缩；或考虑 Bun 编译替代 |
| **secret 必须先配 keystore**（新增，实测） | `password` 与 `connection_string` 都被 GraphJin 当 secret 处理，未设 `secrets.keystore.key` 时写入被拒：`secrets.keystore.key must be set ... GJ_SECRETS_KEYSTORE_KEY` | 后端拉起 GraphJin 时注入 `GJ_SECRETS_KEYSTORE_KEY`（本地生成并持久化），否则所有带密码/连接串的库都配不进去 |

### 6.1 未覆盖风险与遗留待办

以下为**仍存在**的已知限制；原先登记的 R1 / R2 / R5 / R7 / R8 / R9 已完成，保留编号便于追溯。

| # | 项目 | 现状与影响 | 处理方向 |
|:---|:---|:---|:---|
| R1 | `block` 模式依赖 Schema | **已缓解**：前端在展开补集前校验表的列清单，缺失时拒绝写入并提示先刷新 Schema；后端写入前统一留快照 | — |
| R2 | `admin` 角色不进矩阵 | **已完成**：启动与每次写入前自动补齐 admin；UI 明示其为保留角色、不参与矩阵 | — |
| R3 | `gj_security` 策略不可读 | 该 root 走 `/api/v1/graphql` 且需 admin JWT，实测不可达；策略预览以 `get_current_config.roles` 为准 | 需要时再设计 JWT 签发方案；当前不影响功能 |
| R4 | 非 Windows 二进制未实机验证 | **已缓解**：`scripts/smoke-binaries.js` 在 CI 的 Windows / macOS / Linux 矩阵真实执行 `graphjin version`；完整 UI 冒烟仍只在 Windows 跑 | 后续可把 `verify:ui` 移植到 macOS / Linux runner |
| R5 | 权限变更无回滚 | **已完成**：写入前自动快照（每项目保留 30 份），`permissions.rollback` 恢复 roles 并删除本次新增角色，回滚前再快照；UI 有「写入历史」 | — |
| R6 | `sources` 模式迁移预案 | 方案 B 被官方标 `risk_level: high`，未来版本可能移除 | 权限编排仍集中在 `permissions.js`，迁移时只改这一个模块 |
| R7 | 声明支持但驱动未实现 | **已完成**：`driverVerified=false` 的类型在后端前置拦截，前端禁用测试/启动并提示改用兼容协议 | — |
| R8 | 前端包体积 | **已完成**：路由懒加载 + `element-plus` / `vue` vendor chunk；首页 chunk 从 1.17 MB 降到约 39 kB，Element Plus 单独缓存 | 如需进一步压缩可改为按需引入组件 |
| R9 | 端到端测试缺失 | **已完成**：`verify:e2e` 24 项（含快照回滚）、后端单测 127 项、前端策略单测 8 项、UI 冒烟 10 项 | — |
| R10 | 安装包签名 / 公证 | CI 产物未签名，macOS 首次打开需手动放行 | 配置 Apple Developer 证书与 Windows 签名证书后接入 |
| R11 | `dev.yml` 合并非通用 YAML | 已覆盖项目生成格式、flow map、引号键、GraphJin 4 空格回写；anchors / merge keys 仍不支持 | 需要时引入完整的 YAML 解析库 |


## 七、DeepSeek Harness 使用建议

### 7.1 分阶段启动方式

将阶段 0 和阶段 1 的任务 1.1-1.5 作为第一批 Harness 任务，在 **Plan Mode** 下先探索 GraphJin 的实际 API 行为，再编写实现代码：

```
请进入 Plan Mode，阅读 docs/graphjin-3.21.14-baseline.md，基于 GraphJin 的
get_current_config / update_current_config / query_catalog 三个 MCP 工具的实际能力，
制定阶段 1（Node.js 后端服务）的详细实施计划。
（注：原设想的 gj_config / gj_catalog / gj_security GraphQL root 需 admin JWT，
dev 角色头在 GraphQL 端点不生效，已改走 MCP，见基线 §5。）
```

### 7.2 利用 Sub-agent 并行推进

```
请为以下三个并行任务分别创建子代理：
1. 子代理A：实现 GraphJin 连接管理和 Schema 发现 API（任务 1.2-1.3）
2. 子代理B：实现权限配置的 preview/apply 流程和 buildSourceAccessConfig（任务 1.4-1.5）
3. 子代理C：实现用户/组织管理与 GraphJin RBAC 的映射（任务 1.6）
```

### 7.3 长任务管理

阶段 2 的 Vue 3 前端开发周期较长，使用 Harness 的 **goal** 机制设定阶段目标，配合 **compact** 上下文压缩避免上下文溢出。