# 功能进度

> 更新于 2026-10-18。新增/完成功能时同步本表；实现细节见 `Plan.md` 与
> `docs/graphjin-3.21.14-baseline.md`。

## 已完成

### 桌面端与分发

| 能力 | 说明 |
|:--|:--|
| Electron 外壳 | 主进程起后端、注入端口、外链走系统浏览器、退出前先停 GraphJin |
| Windows 安装包 | `npm run dist:win` → `release-final/`（NSIS，可选安装目录） |
| 二进制随包分发 | `extraResources` 打包 `src-tauri/binaries/graphjin-*` |
| 二进制管理 | `fetch:binaries` 下载 + sha256 校验，`prepare:binaries` 解压改名 |

### 后端

| 能力 | 说明 |
|:--|:--|
| JSON-RPC 服务 | HTTP `POST /rpc` + stdio 双传输，同一份方法表 |
| GraphJin 进程编排 | 绝对路径校验、端口探活、崩溃自动重启、状态查询 |
| MCP 客户端 | Streamable HTTP、会话管理、**会话失效自动重连**、请求串行队列 |
| Schema 发现 | `query_catalog` 分页（table / column / relationship），支持按库过滤 |
| 权限编排 | 方案 B：本地角色名 = GraphJin 角色名；四项操作 + 行过滤 + 列管控 + 默认 limit |
| 策略读取 | `get_current_config` 顶层 `roles` 解析成可对比结构 |
| 用户 / 组织 | SQLite 存储，角色可同步到 GraphJin |
| 连接本地存储 | SQLite + AES-256-GCM；`name + project_dir` 唯一；摘要字段独立明文列 |
| 连接自检 | 服务未运行时临时起单库实例跑 `validate_config`，用完即停 |
| dev.yml 增量合并 | 只改 `databases:` 段，保留 `roles` 等；新默认库自动摘掉其它 `default` |
| 测试 | `node:test` 共 104 项 |

### 前端

| 页面 / 能力 | 说明 |
|:--|:--|
| 运行状态 | 进程、端点、项目目录、重启次数、探活、停止、MCP 客户端配置复制 |
| 数据库连接 | 内置类型 + 自定义模板；三种录入方式；测试 / 启动 / 存模板 |
| 已保存连接 | 测试或启动成功后自动落盘；回填表单、一键启动、删除 |
| Schema 浏览器 | 顶部库选择，按库加载表 / 列 / 关系；结构与关系隔离 |
| 权限矩阵 | 角色 × 表 × 四项操作；行过滤、列白名单 / 黑名单、默认 limit |
| 策略预览 | 生效策略 vs 待写入矩阵的逐项 diff |
| 设置 | 后端端口、内置 GraphJin 版本、缓存平台、版本信息复制 |
| 国际化 | `vue-i18n`，中文 / English，跟随系统 + 本地持久化；Element Plus 语言包同步 |
| 空状态与错误提示 | 未运行 / 无库 / 无表 / 解密失败均有明确文案 |

### 文档与验证

| 内容 | 位置 / 命令 |
|:--|:--|
| 中英文 README（介绍、截图、部署运行） | `README.md` / `README.en.md` |
| 功能进度（本文件） | `docs/FEATURES.md` |
| GraphJin 实测基线 | `docs/graphjin-3.21.14-baseline.md` |
| 本地测试数据库 | `docs/docker-compose-4-test-db-connection.yml`：MySQL / PostgreSQL / MongoDB / SQL Server，Oracle 注释可选 |
| 后端单测 | `cd sidecar-backend && npm test`（104 项） |
| 真机全链路 | `cd sidecar-backend && npm run verify:e2e`（17 项） |
| UI 冒烟 + 截图 | `npm run build && npm run verify:ui`（10 项，含语言切换） |

## 未完成

### 功能缺口

| 项 | 影响 | 备注 |
|:--|:--|:--|
| 权限矩阵未按库过滤 | 多库项目会把 A 库的表写进 B 库的角色配置 | 新发现；需要把表身份改成 `database::table` |
| 策略写入无回滚 | 误操作只能手工改回 | legacy 模式无 preview，已用二次确认缓解 |
| 连接测试多一次进程启停 | 未启动服务时约多 1–2s | 服务在跑时复用现成实例 |
| `driverVerified=false` 类型 | 配置白名单通过但连接层报 unsupported | 前端已标注，未自动禁用 |
| dev.yml 合并格式限制 | 手写 flow 风格 / 引号 key 无法合并 | 只保证本项目生成的缩进格式 |

### 平台与工程化

| 项 | 状态 |
|:--|:--|
| macOS / Linux 安装包 | 未开始（二进制已支持多平台下载） |
| 代码签名 / 公证 | 未开始 |
| CI / CD（GitHub Actions） | 未开始，验证脚本均为本地真机运行 |
| 前端拆包 | 单 chunk > 1 MB，未做 manualChunks |
| 非 Windows 实机冒烟 | 未做 |

### 权限模型遗留

| 项 | 说明 |
|:--|:--|
| `gj_security` 策略读取 | 需要 admin JWT，anon/dev 头均不可达；真相来源改用 MCP `get_current_config` |
| block 模式依赖 Schema | 屏蔽列依赖已发现列；表结构缺失时无法完成 |
| `admin` 角色未纳入矩阵 | 内置角色保持默认全权限，避免自我锁死 |

## 已知边界（非缺陷）

- 一个后端进程只托管一个 GraphJin 实例；切换连接会先停止再启动。
- 运行时用 `update_current_config` 合并 `databases` 会让实例进入
  `roles 'admin' not defined` 状态，因此连接只在启动时通过 `dev.yml` 生效。
- 连接凭据依赖 `keystore.key`；该文件丢失后旧记录只能重新录入密码。
