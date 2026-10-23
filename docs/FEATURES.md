# 功能进度

> 更新于 2026-10-21。新增/完成功能时同步本表；实现细节见 `Plan.md`、
> `docs/graphjin-3.21.14-baseline.md` 与 `docs/graphjin-source-migration.md`。

## 已完成

### 桌面端与分发

| 能力 | 说明 |
|:--|:--|
| Electron 外壳 | 主进程起后端、注入端口、外链走系统浏览器、退出前先停 GraphJin；窗口标题跟着项目名走（`dev.yml` 的 `app_name`），Windows 自绘标题带居中显示 |
| Windows 安装包 | `npm run dist:win` → `release-final/`（NSIS，可选安装目录） |
| macOS 打包配置 | `npm run dist:mac` → dmg + zip；GitHub Actions 在 macOS 13 / 14 上产出 |
| Linux 打包配置 | `npm run dist:linux` → AppImage + deb；GitHub Actions 在 ubuntu-latest 上产出 |
| CI / CD | `.github/workflows/build.yml`：单测 + Web 构建 → 四平台矩阵打包并上传产物 |
| 应用图标 | `build/icon.png`（1024×1024）打包时转 ico / icns，exe 与安装器共用；窗口 / 任务栏图标用 `electron/icon.png`（512×512） |
| 二进制随包分发 | `extraResources` 打包 `binaries/graphjin-*`；三个 `dist:*` 打包前先跑 `check:binaries`，缺当前平台二进制直接报错，不会产出空壳安装包 |
| 二进制管理 | `fetch:binaries` 下载 + sha256 校验，`prepare:binaries` 解压改名 |
| 二进制冒烟 | `smoke:binaries` 真实执行 `graphjin version` 并核对版本，CI 四个打包 job 各跑一次 |

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
| legacy 配置迁移 | 启动前发现 `databases:` + `roles[].tables` 就先起临时实例，用只读配置 API 读角色与 catalog，改写 `dev.yml` 为 `sources` + `access.grants`，再按新配置重启；失败用 `.bak` 回滚，catalog 为空记 `missing-columns` 且不生成 grants |
| 用户 / 组织 | SQLite 存储；角色可同步到 GraphJin；组织有成员时拒绝删除，成员资料可改；成员可签发 MCP 令牌 |
| 连接本地存储 | SQLite + AES-256-GCM；`name + project_dir` 唯一；摘要字段独立明文列 |
| 连接自检 | 服务未运行时临时起单库实例跑 `validate_config`，用完即停；缺必填字段的配置前置拦截，不起进程 |
| dev.yml 增量合并 | 只改 `sources:` 段；支持块风格与扁平的单行 flow 数组（归一化后写回块格式，`sources: []` 也兼容）、引号键，兼容本项目 2 空格与 GraphJin 回写的 4 空格缩进；anchors / aliases / merge keys 与 flow 里的嵌套结构（如 `access: {...}`）显式拒绝 |
| 一键演示 | `demo.bootstrap`：建示例库（orders / customers + 数据）与 analyst 只读角色（行过滤 + 写删 blocked），直接启动，记录落进「已保存连接」 |
| 一键体检 | `diagnostics.run`：二进制 / 后端 / 实例 / 库 / 角色逐项 ok / fail / skip |
| 测试 | `node:test` 共 353 项 |

### 前端

| 页面 / 能力 | 说明 |
|:--|:--|
| 欢迎页 | 价值主张 + 三步状态（连接 / 配权 / 接入，按当前数据自动判定），一键体验演示、一键体检入口 |
| 一键演示 | 10 秒建示例项目并启动（orders / customers + analyst 只读角色），返回库 / 角色 / 表 / 端点，可跳到 Schema 与权限矩阵 |
| 接入向导 | 客户端卡片（含配置文件位置）、配置 JSON 一键复制、`graphjin mcp add` 命令、自检 tools/list |
| 自查诊断 | 二进制 / 后端 / 实例 / 库 / 角色的红绿灯结果 |
| 使用向导 | 应用内抽屉式分步引导（连接 → 配权限 → 验证 → 讲清业务 → 接入 AI，本体论排在接入之前），每步可跳转对应页面；首访自动弹出，关闭写 localStorage 不再自动弹，右下角悬浮按钮随时再次打开 |
| 导航顺序 | 左侧菜单顺序 = 用户动线，与使用向导五步严格一致（欢迎页之后依次连接 → 配权限 → 验证 → 本体论 → 接入 AI），向导覆盖不到的运维页排在动线之后；有断言防回归 |
| 侧栏布局 | 左侧菜单钉在窗口内不随内容滚动——滚动只发生在右侧内容区，窗口本身不出滚动条（有断言防回归）；首次进入折叠为 64px 图标栏，hover 出 tooltip（标题 · 副标题），底部按钮展开为 248px 完整菜单，选择写 localStorage 下次沿用 |
| 运行状态 | 进程、端点、项目目录、重启次数、探活、停止、MCP 客户端配置复制；发生 legacy 迁移时展示迁移结果面板（成功/失败、迁移的库、冲突明细、备份文件路径可复制） |
| 数据库连接 | 内置类型 + 自定义模板；三种录入方式；测试 / 启动 / 存模板；驱动未验证类型自动禁用测试与启动；**启动前先验证连接，连不上则拦下并给出原因**；临时实例验证时相对路径按项目目录解析 |
| 业务本体论 | 人类维护的领域知识，**按库各自一套**：术语 / 概念 / 关系 / 业务规则 / 指标口径 / 样例六类，可挂别名；关联表为下拉**多选**（不折叠标签，选了几张就看得到几张）、候选来自当前库的 Schema，落库为**规范形式**（`库.schema.表`，段数随引擎而定）；结构化载荷按类别白名单校验（术语的绑定列与**值域**、概念的主键/显示列、**关系的两端与基数**（可从现存外键一键填入）、规则的范围/判据/命中动作、指标**粒度/单位/时间窗口/可执行片段**），系统不认识的行业信息走**扩展属性**（原样转交、不解释）；渲染成业务语境文档（六个小节、按库分组）经 MCP 网关下发（握手 instructions + `business_ontology` 工具，支持按类别 / 按库过滤，空结果会说明"哪个库没有 / 哪些库有"而不是回空字符串）；没有维护时网关保持纯透传；页面内**一致性体检**（引用格式 / 引用的表是否还在 / 强制规则有没有可判定表达式 / 指标有没有计算式 / 绑定的列是否存在 / 关系两端对不对得上 / 别名冲突 / 覆盖率缺口），实例没跑时只跑不依赖 schema 的规则并明说跳过了几项；**从 schema 起草**（列出没有概念的表 / 没有关系的外键 / 有注释却没有术语的列，点「起草」只填表单、不落库）；**值域扫描**（对绑定列抽样去重后填入，只接受低基数列，超长 / 含等号 / 高基数的列直接拒绝，避免把敏感值带进上下文）；**样例评测**（查询还能不能跑通 / 与声明的期望结构是否一致 / 问题需要的表有没有被讲；没给实例时不跑查询，只做结构与覆盖；**不评价模型答得好不好**——那需要真模型与真答案）；**强制规则编译**（把 enforce 规则编译成权限补丁：读筛选 / 隐藏列 / 整表禁读 / 全局只读；**只算不写**，应用走权限页同一条 `permissions.apply` 路径并自动存快照；GraphJin 表达不了的规则列为冲突而不是假装编出来）；交付分层：握手只下发**目录**（各库计数 + 硬约束 + 怎么取细节，有长度上限），全文按需取；`business_ontology` 支持按库 / 按类别 / 按说法**检索**（返回命中理由），`describe_business_object` 给单个对象的**画像**（自身 + 共用同一批表的相关条目）；上游 `ask_graphjin_agent` 的描述会补一句「它看不到平台注入的本体论」；**按角色裁剪**（被屏蔽表、以及非 admin 的「仅管理员可读」表，其条目不下发给该角色的客户端；判定读 dev.yml 的 `sources[].access`，按 mtime 缓存）；单条正文超过 1000 字时渲染截断并标注、体检提醒拆分 |
| 已保存连接 | 测试或启动成功后自动落盘；回填表单、一键启动、删除；「已连接」按当前运行实例现算（项目目录 + dev.yml 库名匹配），停止或换项目后回落为「已测试」；删除时同步从 dev.yml 摘掉该库，还有别的库则重启实例、删最后一个则停止服务 |
| Schema 浏览器 | 顶部库选择，按库加载表 / 列 / 关系；结构与关系隔离 |
| MCP Client | 按 MCP 协议连当前实例；「测试全部库」逐库读 catalog 再跑一次最小查询（跨库重名表降级为仅 catalog 校验），另可列工具、按角色执行 GraphQL 看原始返回；示例查询按当前库真实表名生成、点击填入，工具调用示例给出可复制的参数 JSON |
| 权限矩阵 | 每个数据源一个独立标签页，角色清单、矩阵与未提交改动各自独立；角色 × 表的读规则（行过滤、列白名单 / 黑名单）；数据源级读/写/删档位、owner 列、仅管理员/全局屏蔽表；标签上有未提交改动提示；可移除本地角色 |
| 策略回填 / 导入 | 加载时用生效策略补空格子（不覆盖本地改动）；「从生效策略导入」二次确认后覆盖 |
| 写入历史 / 回滚 | 列出每份快照（时间、角色数、库、原因），可恢复到任意一份；回滚前自动再快照 |
| 用户与组织 | 组织 / 成员增删改；成员角色即 GraphJin 角色名，一键把成员角色同步进 GraphJin；组织有成员时拒绝删除 |
| 权限验证 | 以任意角色真跑一条 GraphQL（`graphql.execute`），区分「静默返回 null」与「返回 errors」 |
| 策略预览 | 生效策略 vs 待写入矩阵的逐项 diff；自带库选择，可直接打开使用 |
| 设置 | 后端端口、内置 GraphJin 版本、缓存平台、版本信息复制 |
| 国际化 | `vue-i18n`，中文 / English，跟随系统 + 本地持久化；Element Plus 语言包同步 |
| 视觉主题 | 深色侧栏 + 浅色内容区；提高正文 / 表格字号与对比度；统一 Element Plus 输入、按钮、弹窗、下拉与滚动条样式 |
| 前端拆包 | 十个页面路由懒加载 + `element-plus` / `vue` vendor chunk；首页 JS 从 1.17 MB 降到约 53 kB |
| 空状态与错误提示 | 未运行 / 无库 / 无表 / 解密失败均有明确文案 |

### 文档与验证

| 内容 | 位置 / 命令 |
|:--|:--|
| 中英文 README（介绍、截图、部署运行） | `README.md` / `README.en.md` |
| 使用向导（从零到接入 AI 的完整走法） | `docs/GUIDE.md` |
| 功能进度（本文件） | `docs/FEATURES.md` |
| GraphJin 实测基线 | `docs/graphjin-3.21.14-baseline.md` |
| source 迁移设计与踩坑 | `docs/graphjin-source-migration.md` |
| 本地测试数据库 | `docs/docker-compose-4-test-db-connection.yml`：MySQL / PostgreSQL / MongoDB / SQL Server，Oracle 注释可选 |
| 后端单测 | `cd sidecar-backend && npm test`（353 项） |
| 前端单测 | `npm run test:frontend`（12 项：策略归一化 / diff、中英文语言包 key 一致） |
| 真机全链路 | `cd sidecar-backend && npm run verify:e2e`（24 项，含快照回滚） |
| legacy 迁移验证 | `cd sidecar-backend && npm run verify:migration`（12 项，含数据库不可达的项目） |
| 二进制冒烟 | `npm run smoke:binaries` |
| UI 冒烟 + 截图 | `npm run build && npm run verify:ui`（76 项：语言切换、窗口标题带项目名、连不上的记录启动被拦并给出原因、运行中实例不受影响、菜单顺序与使用向导一致、侧栏钉住不随内容滚 / 默认折叠成图标 / tooltip 弹文案 / 展开并记住选择、本体论按库隔离 / 切库整套更换 / 关联表下拉多选累加且按规范形式落库 / 一致性体检报出引用了不存在的表 / 从 schema 起草候选 / 样例评测跑通结构与覆盖 / 强制规则编译报出无处可挂的冲突 / 握手只下发目录 / 按说法检索并给出对象画像 / 新增同步、向导五步且本体论排在接入前并可直达、网关握手下发业务语境、网关追加本体论工具且不丢上游工具、本体论工具可按库取一节、组织/成员与资料编辑、权限写入 / 验证 / 回滚、每库独立标签、MCP 逐库探活与查询、MCP 调用示例、粘成 JSON 参数自动解包、右下角悬浮按钮存在 / 可打开、使用向导自动弹出 / 关闭 / 再开 / 跳转、停止后连接状态回落、删库后 Schema 重置、本地角色删除、停止后按 dev.yml 判定权限 / 刷新后三步状态回填、欢迎页 / 接入向导 / 一键演示 / 一键体检）；`--shots=docs/screenshots` 逐页产出 12 个页面 × 中英文截图（含使用向导打开态） |

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
| dev.yml 合并不是通用 YAML 解析器 | 手写 anchors / merge keys 与嵌套 flow 无法合并 | 已覆盖项目生成格式、扁平 flow 数组、引号键与 GraphJin 回写格式；不支持的构造会明确报错并拒绝合并，不会改坏文件 |
| 一个后端只托管一个实例 | 切换连接要停旧实例 | 设计取舍；避免多实例端口与 keystore 冲突 |
| 库不可达时迁移不生成 grants | 该库的角色读不到数据 | catalog 为空拿不到列清单，记 `missing-columns` 冲突；宁可少授权也不退化成全列可读，库恢复后重跑迁移即可 |

## 已知边界（非缺陷）

- 一个后端进程只托管一个 GraphJin 实例；切换连接会先停止再启动。
- source 模式下 `source_patches` 会忽略 `access.grants`，平台改为整份替换 `sources`；
  替换前先从 dev.yml 读回真实连接串（配置 API 返回 `[REDACTED]`）。
- 删除角色必须在清空引用它的 grants 之后，否则 `update_current_config` 会 reload 失败。
- `grants[].columns` 只约束读：写列白名单实测不生效；写 / 删没有表级开关，只有
  source 级 `access.write` / `access.delete`（`docs/graphjin-source-migration.md` §2.2）。
- 未列入任何 grants 的表对已认证角色完全可读，收敛只能靠 `admin_tables` / `blocked_tables`。
- 迁移只读配置、不改配置：任何 `update_current_config` 都会触发 reload 并重连所有库，
  任一库连不上就整次失败（§2.4c）。
- 连接凭据依赖 `keystore.key`；该文件丢失后旧记录只能重新录入密码。
- 权限快照存在同一个 `mcp-builder.db`，只保留每个项目最近 30 份。
- `admin` 是保留角色：平台不为它写限制规则、默认不进入矩阵，任何回滚都不会删除它。
