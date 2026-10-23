import { defineStore } from 'pinia';
import i18n from '../i18n';
import { getPort, rpc, rpcSafe, setPort } from '../api/rpc';
import {
  OPERATIONS,
  OPERATION_KEYS,
  STATE_KEYS,
  diffPolicy,
  emptySourceAccess,
  normalizeCurrentRoles,
  normalizePendingMatrix,
  normalizeSourceAccesses,
  resolveColumns,
  scopeToDatabase,
  toAccessPayload,
  unresolvedBlockTables,
} from '../utils/policy';

export { OPERATIONS, OPERATION_KEYS, STATE_KEYS };

/** 平台保留角色：始终全权限，不进入可编辑矩阵 */
const RESERVED_ROLES = new Set(['admin']);

/** 使用引导「关闭后不再自动弹出」的持久化标记 */
const GUIDE_DISMISSED_KEY = 'mcpb.guideDismissed';

/** 侧栏折叠状态的持久化标记：没写过就是首次进入，按默认折叠处理 */
const RAIL_COLLAPSED_KEY = 'mcpb.railCollapsed';

/**
 * 把用户手填的多值文本拆成数组：逗号 / 顿号 / 换行都算分隔符。
 * 用户不会去想「标准分隔符是什么」，所以都认。
 *
 * 入参可能是数组（下拉多选）也可能是字符串（手填框），统一成数组再拆 ——
 * 字符串没有 flatMap，直接调用会 TypeError。
 *
 * @param {*} value
 * @returns {string[]}
 */
function splitLoose(value) {
  const source = Array.isArray(value) ? value : [String(value ?? '')];
  return source
    .flatMap((item) => String(item).split(/[,，、\n]/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyOperation() {
  // columnMode: allow = 白名单；block = 阻止列表（写库时转成补集白名单）
  return { enabled: false, filters: [], columnMode: 'allow', columns: [] };
}

/**
 * @param {Object} state
 * @param {string} [database] 限定库；不传则按表名合并（多库同名表会互相覆盖）
 * @returns {Object} { tableName: string[] }
 */
function columnsByTableOf(state, database) {
  const map = {};
  for (const table of state.schema?.tables ?? []) {
    if (database && table.database !== database) continue;
    map[table.name] = (table.columns ?? []).map((column) => column.name);
  }
  return map;
}

export const useAppStore = defineStore('app', {
  state: () => ({
    port: getPort(),
    isBackendUp: false,
    isBusy: false,
    /** 使用引导抽屉是否打开；关闭后写 localStorage，不再自动弹出 */
    guideOpen: false,
    /** 侧栏是否折叠为「图标 + tooltip」：首次进入折叠，之后跟随用户选择 */
    railCollapsed: localStorage.getItem(RAIL_COLLAPSED_KEY) !== '0',
    status: null,
    tables: [],
    schema: null,
    currentRole: '',
    /** 权限页当前激活的库；每个库一个标签页，矩阵与角色清单互不影响 */
    applyDatabase: '',
    /** { [database]: { [role]: { [table]: { query: {...} } } } } */
    matrices: {},
    /** { [database]: string[] } 每库独立的角色清单 */
    rolesByDb: {},
    clientConfig: null,
    /** 当前生效策略，按库分隔的原始归一化结果（键为 `database::table`） */
    policyRaw: {},
    /** 当前生效策略，已按 applyDatabase 收敛成纯表名 */
    currentPolicy: {},
    /** GraphJin 配置里已存在的角色名（可能还没有任何 grants） */
    configRoles: [],
    /** 每个数据源的 source 级访问档位（读/写/删 + owner 列 + 表分类） */
    sourceAccessByDb: {},
    /** 当前写入目标库的 source 级档位（可编辑） */
    sourceAccess: emptySourceAccess(),
    /** 生效中的 source 级档位，用于判断是否有未提交改动 */
    currentSourceAccess: emptySourceAccess(),
    /** 是否成功读过一次生效策略：空策略与「还没读」要分开提示 */
    hasLoadedPolicy: false,
    /** 支持的 MCP 客户端清单（含各平台配置路径） */
    clients: [],
    /** 内置数据库类型 + 用户自定义别名模板 */
    dbTypes: [],
    /** 本地已保存的连接（测试通过 / 启动成功后才会有） */
    connections: [],
    /** 运行中实例实际加载的库名 */
    connectedDatabases: [],
    /** 权限写入快照（摘要，不含 roles 全文） */
    snapshots: [],
    /** 本地组织与成员（SQLite，users.js） */
    organizations: [],
    /** 业务本体论条目：术语 / 概念 / 规则 / 指标 */
    ontology: [],
    /** 本体论渲染出的业务语境文档，MCP 网关原样送给 AI */
    ontologyRendered: '',
    /** 本体论体检结果；null 表示还没跑过（改条目后清空，避免展示过期结论） */
    ontologyLint: null,
    /** 从 schema 起草的候选；null 表示还没生成过 */
    ontologyProposals: null,
    /** 样例评测结果；null 表示还没跑过 */
    ontologyEval: null,
    /** 强制规则编译出的权限补丁；null 表示还没编译过 */
    ontologyRules: null,
    users: [],
    /** Schema 页当前选中的库 */
    activeDatabase: '',
    lastError: '',
  }),

  getters: {
    builtInTypes: (state) => state.dbTypes.filter((item) => item.custom !== true),
    customTemplates: (state) => state.dbTypes.filter((item) => item.custom === true),
    isRunning: (state) => Boolean(state.status?.running),
    baseUrl: (state) => state.status?.baseUrl ?? '',
    databaseNames: (state) => [...new Set(state.tables.map((t) => t.database))],
    /** 当前标签页的矩阵：{ role: { table: {ops} } } */
    matrix: (state) => state.matrices[state.applyDatabase] ?? {},
    /** 当前标签页自己的角色清单 */
    roles: (state) => state.rolesByDb[state.applyDatabase] ?? [],
    /** 写入目标库下的表名；矩阵只展示、只提交这个库的表 */
    applyTables: (state) =>
      state.tables
        .filter((table) => table.database === state.applyDatabase)
        .map((table) => table.name),
    tablesForCurrentRole() {
      return this.matrix[this.currentRole] ?? {};
    },
    /** { tableName: string[] } 供 block 模式求补集，只含当前目标库 */
    columnsByTable: (state) => columnsByTableOf(state, state.applyDatabase),
    pendingPolicy() {
      return normalizePendingMatrix(this.matrix, this.columnsByTable);
    },
    changes() {
      return diffPolicy(this.currentPolicy, this.pendingPolicy);
    },
    /**
     * 每个库有多少项未提交改动：标签页上的小圆点靠它判断。
     *
     * @returns {Object} { database: number }
     */
    pendingByDatabase(state) {
      const result = {};
      for (const database of this.databaseNames) {
        const pending = normalizePendingMatrix(
          state.matrices[database] ?? {},
          columnsByTableOf(state, database)
        );
        result[database] = diffPolicy(scopeToDatabase(state.policyRaw, database), pending).length;
      }
      return result;
    },
    /**
     * GraphJin 里真实存在的角色：MCP 试跑、引导卡判定只能用这份。
     *
     * 不能混进 users.role —— 那是本地成员角色，可能还没 users.syncRoles 同步进
     * GraphJin。拿它去试跑，得到的是「没有权限」而不是「角色不存在」，会被误读成配置问题。
     */
    grantedRoles(state) {
      return [
        ...new Set(['admin', ...state.configRoles, ...Object.keys(state.policyRaw ?? {})]),
      ].sort();
    },
    /** 成员角色候选：当前库角色 + 生效策略角色 + 已在用的角色 */
    roleNames(state) {
      return [
        ...new Set([
          ...(state.rolesByDb[state.applyDatabase] ?? []),
          ...Object.keys(state.currentPolicy ?? {}),
          ...state.users.map((user) => user.role),
        ]),
      ].sort();
    },
  },

  actions: {
    openGuide() {
      this.guideOpen = true;
    },

    /** 关闭即视为「不再自动弹出」；右下角悬浮按钮仍可再次打开 */
    closeGuide() {
      this.guideOpen = false;
      localStorage.setItem(GUIDE_DISMISSED_KEY, '1');
    },

    /** 首次进入自动弹出，被关过就静默 */
    autoOpenGuide() {
      if (!localStorage.getItem(GUIDE_DISMISSED_KEY)) this.guideOpen = true;
    },

    /** 折叠 / 展开侧栏；选择写进 localStorage，下次启动沿用 */
    toggleRail() {
      this.railCollapsed = !this.railCollapsed;
      localStorage.setItem(RAIL_COLLAPSED_KEY, this.railCollapsed ? '1' : '0');
    },

    /**
     * @param {number} port 后端 HTTP 端口
     */
    applyPort(port) {
      this.port = Number(port) || 0;
      setPort(this.port);
    },

    async refreshBackend() {
      this.isBackendUp = await rpcSafe('ping').then((r) => r.ok);
      if (this.isBackendUp) await this.refreshStatus();
    },

    async refreshStatus() {
      const result = await rpcSafe('graphjin.status');
      if (result.ok) this.status = result.data;
      else this.lastError = result.error ?? '';
      // 接入配置带的是运行中实例的端点，实例没了就不能继续算「已接入」
      if (!this.isRunning) this.clientConfig = null;
    },

    /**
     * 启动 GraphJin；目录里没有 dev.yml 时会按 databases 初始化项目。
     * @param {{projectDir: string, appName?: string, databases: Object}} payload
     */
    async startGraphJin(payload) {
      this.isBusy = true;
      this.lastError = '';
      try {
        this.status = await rpc('graphjin.start', payload);
        await this.loadSchema();
        // 后端在启动成功时已落盘连接，这里把列表和实际加载的库同步过来
        await Promise.all([
          this.loadConnections(),
          this.loadConnectedDatabases(),
          this.loadSnapshots(),
        ]);
      } catch (error) {
        this.lastError = error.message;
        throw error;
      } finally {
        this.isBusy = false;
      }
    },

    async stopGraphJin() {
      this.isBusy = true;
      try {
        this.status = await rpc('graphjin.stop');
        this.tables = [];
        this.schema = null;
        this.connectedDatabases = [];
        this.activeDatabase = '';
        // 换项目/换实例时矩阵不能跨项目残留：同名库、同名表会串
        this.currentRole = '';
        this.matrices = {};
        this.rolesByDb = {};
        this.policyRaw = {};
        this.currentPolicy = {};
        this.configRoles = [];
        this.sourceAccessByDb = {};
        this.sourceAccess = emptySourceAccess();
        this.currentSourceAccess = emptySourceAccess();
        this.hasLoadedPolicy = false;
        this.applyDatabase = '';
        this.snapshots = [];
        this.clientConfig = null;
        // 「已连接」由后端按运行态现算，停止后必须重新拉一次才会回落成已测试
        await this.loadConnections();
      } finally {
        this.isBusy = false;
      }
    },

    async loadSchema() {
      if (!this.isRunning) return;
      const [tables, schema] = await Promise.all([
        rpcSafe('schema.tables', { baseUrl: this.baseUrl }),
        rpcSafe('schema.discover', { baseUrl: this.baseUrl }),
      ]);
      if (tables.ok) this.tables = tables.data;
      if (schema.ok) this.schema = schema.data;
      const names = this.databaseNames;
      if (!names.includes(this.applyDatabase)) this.applyDatabase = names[0] ?? '';
      // 库可能刚刚被删掉：Schema 页的选择不能停在已经不存在的库上
      if (!names.includes(this.activeDatabase)) this.activeDatabase = this.applyDatabase;
      this.ensureDatabase();
      await this.loadCurrentPolicy();
    },

    /**
     * 视图挂载时调用。
     *
     * 冷启动时视图的 onMounted 先于父组件拉回 status 执行，isRunning 还是 false，
     * 直接判 running 会让页面停在空态。视图要同时 watch(isRunning) 再调一次，
     * 这里保证 schema 只拉一次、策略空读不重复触发。
     */
    async ensureSchemaLoaded() {
      if (!this.isRunning) return;
      if (this.tables.length === 0) {
        await this.loadSchema();
        return;
      }
      if (!this.applyDatabase) this.applyDatabase = this.databaseNames[0] ?? '';
      this.ensureDatabase();
      if (!this.hasLoadedPolicy) await this.loadCurrentPolicy();
    },

    /**
     * 确保某个库有自己的矩阵与角色清单容器。
     *
     * 标签页按库懒初始化：切到哪个库才建哪个库的空矩阵，
     * 各库的未提交改动因此天然互不可见。
     *
     * @param {string} [database] 默认当前库
     */
    ensureDatabase(database = this.applyDatabase) {
      if (!database) return;
      this.matrices[database] ??= {};
      this.rolesByDb[database] ??= [];
    },

    /**
     * 用生效策略回填矩阵。
     *
     * 默认只补缺失的格子，不动已经改过的单元格：自动回填不能把用户没提交的改动冲掉。
     * overwrite 时以策略为准覆盖（「从生效策略导入」按钮），用于重置本地改动。
     *
     * 只回填目标库里存在的表：矩阵按 `database::table` 存，别的库的表会写进错的库。
     *
     * @param {{overwrite?: boolean}} [options]
     * @returns {{roles: number, tables: number}} 实际回填的角色数 / 表数（按库表去重）
     */
    hydrateMatrixFromPolicy({ overwrite = false } = {}) {
      const database = this.applyDatabase;
      if (!database) return { roles: 0, tables: 0 };
      this.ensureDatabase(database);

      const matrix = this.matrices[database];
      const roleList = this.rolesByDb[database];
      const policy = scopeToDatabase(this.policyRaw, database);
      const tableNames = new Set(this.applyTables);
      const filledRoles = new Set();
      const filledTables = new Set();

      for (const [role, roleTables] of Object.entries(policy)) {
        // admin 由平台保证存在且全权限，不放进矩阵，避免被误改成受限角色
        if (RESERVED_ROLES.has(role)) continue;
        if (!roleList.includes(role)) roleList.push(role);
        const byTable = (matrix[role] ??= {});
        for (const [table, operations] of Object.entries(roleTables)) {
          if (!tableNames.has(table)) continue;
          if (byTable[table] && !overwrite) continue;
          byTable[table] = {};
          for (const operation of OPERATIONS) {
            const op = operations[operation] ?? {};
            byTable[table][operation] = {
              // 'default' 表示配置里没写，等同 default_block
              enabled: op.state === 'allowed',
              filters: [...(op.filters ?? [])],
              columnMode: 'allow',
              columns: [...(op.columns ?? [])],
            };
          }
          filledRoles.add(role);
          filledTables.add(table);
        }
      }

      // 覆盖导入：生效策略里没有的格子一并重置为「全拦」，否则本地残留的规则会留下来
      if (overwrite) {
        for (const [role, byTable] of Object.entries(matrix)) {
          for (const table of tableNames) {
            if (!byTable[table]) continue;
            // 策略里有的格子上面的循环已经按策略写过，这里只处理本地多出来的
            if (policy[role]?.[table]) continue;
            byTable[table] = {
              query: emptyOperation(),
              insert: emptyOperation(),
              update: emptyOperation(),
              delete: emptyOperation(),
            };
          }
        }
      }

      // 配置里已存在但还没有 grants 的角色也要出现在编辑器里，
      // 否则「先建角色、后配规则」的流程会看不到角色
      for (const role of this.configRoles) {
        if (RESERVED_ROLES.has(role) || roleList.includes(role)) continue;
        roleList.push(role);
      }

      if (!this.currentRole || !roleList.includes(this.currentRole)) {
        this.currentRole = roleList[0] ?? '';
      }
      return { roles: filledRoles.size, tables: filledTables.size };
    },

    /**
     * @param {string} name 角色名
     */
    addRole(name) {
      const database = this.applyDatabase;
      if (!database) return false;
      const trimmed = (name ?? '').trim();
      this.ensureDatabase(database);
      const roleList = this.rolesByDb[database];
      if (!trimmed || RESERVED_ROLES.has(trimmed) || roleList.includes(trimmed)) return false;
      roleList.push(trimmed);
      this.matrices[database][trimmed] = {};
      if (!this.currentRole) this.currentRole = trimmed;
      return true;
    },

    /**
     * 从本地矩阵删掉一个角色。
     *
     * 只影响本地：GraphJin 里已经写入的角色与表规则不会被这次删除回收 ——
     * 那需要回滚到写入前的快照。视图负责在角色已生效时给出提示。
     *
     * @param {string} name
     * @returns {boolean} 是否真的删掉了本地角色
     */
    removeRole(name) {
      const database = this.applyDatabase;
      if (!database) return false;
      const roleList = this.rolesByDb[database] ?? [];
      const index = roleList.indexOf(name);
      if (index < 0) return false;
      roleList.splice(index, 1);
      delete this.matrices[database][name];
      if (this.currentRole === name) this.currentRole = roleList[0] ?? '';
      return true;
    },

    /**
     * 判断角色是否已写进生效策略（任一库都算），用于删除前的提示。
     *
     * @param {string} name
     * @returns {boolean}
     */
    isRoleEffective(name) {
      const database = this.applyDatabase;
      const keys = Object.keys(this.policyRaw?.[name] ?? {});
      if (!database) return keys.length > 0;
      return keys.some((key) => key.startsWith(`${database}::`));
    },

    /**
     * 取（必要时创建）某个单元格的四项操作。
     *
     * 矩阵不再预填所有表：预填空格子会让「用生效策略回填」误以为用户已经改过，
     * 从而跳过真正需要回填的格子。视图在第一次编辑时调用这里落格子。
     *
     * @param {string} role
     * @param {string} table 纯表名
     * @returns {Object} { query, insert, update, delete }
     */
    ensureOperations(role, table) {
      const database = this.applyDatabase;
      if (!database) throw new Error(i18n.global.t('permissions.selectDatabase'));
      this.ensureDatabase(database);
      const byRole = (this.matrices[database][role] ??= {});
      byRole[table] ??= {};
      const entry = byRole[table];
      for (const operation of OPERATIONS) {
        entry[operation] ??= emptyOperation();
      }
      return entry;
    },

    /**
     * @param {string} role
     * @param {string} table 纯表名
     * @param {'query'|'insert'|'update'|'delete'} operation
     * @returns {Object|undefined}
     */
    operationOf(role, table, operation) {
      return this.matrix[role]?.[table]?.[operation];
    },

    /**
     * @param {string} role
     * @param {string} table 纯表名
     * @param {'query'|'insert'|'update'|'delete'} operation
     */
    toggleOperation(role, table, operation) {
      const entry = this.ensureOperations(role, table)[operation];
      if (entry) entry.enabled = !entry.enabled;
    },

    /**
     * 把当前矩阵折算成后端要的载荷：block 模式的列管控在这里展开成补集白名单，
     * 并且只提交目标库的表 —— 否则 A 库的表会被写进 B 库的角色配置。
     *
     * @returns {Object} { role: { table: { query, insert, update, delete } } }
     */
    resolveMatrix() {
      if (!this.applyDatabase) throw new Error(i18n.global.t('permissions.selectDatabase'));
      const columnsByTable = columnsByTableOf(this, this.applyDatabase);
      const scoped = this.matrix;
      // block 模式要展开成补集白名单；没有列清单就不能写，否则会静默放行全部列
      const unresolved = unresolvedBlockTables(scoped, columnsByTable);
      if (unresolved.length > 0) {
        throw new Error(
          i18n.global.t('permissions.blockNeedsSchema', { tables: unresolved.join(', ') })
        );
      }
      const payload = {};
      for (const [role, tables] of Object.entries(scoped)) {
        // 保留角色不写 grants；后端会单独确保它存在
        if (RESERVED_ROLES.has(role)) continue;
        const entries = {};
        for (const [table, operations] of Object.entries(tables)) {
          entries[table] = {};
          for (const operation of OPERATIONS) {
            const op = operations?.[operation] ?? emptyOperation();
            entries[table][operation] = {
              enabled: op.enabled,
              filters: [...(op.filters ?? [])],
              columns: resolveColumns(op, columnsByTable[table] ?? []),
            };
          }
        }
        payload[role] = entries;
      }
      return payload;
    },

    /**
     * 读取当前生效策略，供预览面板做 diff。
     *
     * 运行中走 config.current（GraphJin 现算，唯一真相来源）；停止时改读 dev.yml
     * —— 否则「这一步配过没有」在服务停着时完全无从判断，只能猜。
     */
    async loadCurrentPolicy() {
      const result = this.isRunning
        ? await rpcSafe('config.current', { baseUrl: this.baseUrl })
        : await rpcSafe('config.file', { projectDir: this.status?.projectDir ?? null });
      if (!result.ok) {
        this.lastError = result.error ?? '';
        return;
      }
      this.policyRaw = normalizeCurrentRoles(result.data);
      this.sourceAccessByDb = normalizeSourceAccesses(result.data);
      this.configRoles = (result.data?.roles ?? [])
        .map((role) => role?.name)
        .filter(Boolean);
      this.hasLoadedPolicy = true;
      this.applyPolicyScope();
      // 启动后角色与矩阵都是空的：自动回填一次，已配置的策略才能继续编辑
      this.hydrateMatrixFromPolicy();
    },

    /** 把完整策略按写入目标库收敛，diff 与策略页只比较这个库 */
    applyPolicyScope() {
      this.currentPolicy = scopeToDatabase(this.policyRaw, this.applyDatabase);
      const access = this.sourceAccessByDb[this.applyDatabase] ?? emptySourceAccess();
      this.sourceAccess = { ...access, adminTables: [...access.adminTables], blockedTables: [...access.blockedTables] };
      this.currentSourceAccess = {
        ...access,
        adminTables: [...access.adminTables],
        blockedTables: [...access.blockedTables],
      };
    },

    /**
     * 修改当前数据源的 source 级档位（读/写/删/owner 列/表分类）。
     *
     * @param {string} field
     * @param {*} value
     */
    setSourceAccess(field, value) {
      if (!Object.hasOwn(this.sourceAccess, field)) return;
      this.sourceAccess = { ...this.sourceAccess, [field]: value };
      if (this.applyDatabase) {
        this.sourceAccessByDb = { ...this.sourceAccessByDb, [this.applyDatabase]: this.sourceAccess };
      }
    },

    /**
     * 切换写入目标库：矩阵与 diff 范围都跟着换。
     *
     * @param {string} database
     */
    selectDatabase(database) {
      if (!database || this.applyDatabase === database) return;
      this.applyDatabase = database;
      this.ensureDatabase(database);
      this.applyPolicyScope();
      // 新库可能已经有生效策略：切过去时把空格子回填一次
      this.hydrateMatrixFromPolicy();
      // 角色清单按库独立，切库后原来的选中角色可能不存在
      if (this.currentRole && !this.roles.includes(this.currentRole)) {
        this.currentRole = this.roles[0] ?? '';
      }
    },

    /**
     * 把当前矩阵与数据源档位写入 GraphJin（source 模式：sources[].access + grants）。
     * 写入立即生效，所以调用方必须先展示 diff 并二次确认。
     *
     * @param {string} [database] 目标库，默认取 applyDatabase；库名缺失会让规则落到内部库
     * @returns {Promise<Object>} 后端返回的写入结果
     */
    async applyPermissions(database = this.applyDatabase) {
      this.isBusy = true;
      this.lastError = '';
      try {
        this.selectDatabase(database);
        const result = await rpc('permissions.apply', {
          baseUrl: this.baseUrl,
          projectDir: this.status?.projectDir ?? null,
          database: this.applyDatabase,
          matrix: this.resolveMatrix(),
          access: toAccessPayload(this.sourceAccess),
        });
        await Promise.all([this.loadCurrentPolicy(), this.loadSnapshots()]);
        return result;
      } catch (error) {
        this.lastError = error.message;
        throw error;
      } finally {
        this.isBusy = false;
      }
    },

    /** 权限写入历史（摘要）。未运行时仍然返回已落盘的快照。 */
    async loadSnapshots() {
      const result = await rpcSafe('permissions.snapshots', {
        baseUrl: this.baseUrl || null,
        projectDir: this.status?.projectDir ?? null,
      });
      if (result.ok) this.snapshots = result.data ?? [];
      else this.lastError = result.error ?? '';
    },

    /**
     * 回滚到某份快照；不传 id 时恢复最近一份。
     *
     * @param {number} [id]
     * @returns {Promise<Object>} 后端回滚结果
     */
    async rollbackPermissions(id = undefined) {
      if (!this.isRunning) throw new Error(i18n.global.t('errors.rollbackNeedsRunning'));
      this.isBusy = true;
      this.lastError = '';
      try {
        const params = {
          baseUrl: this.baseUrl,
          projectDir: this.status?.projectDir ?? null,
        };
        if (Number.isInteger(id)) params.id = id;
        const result = await rpc('permissions.rollback', params);
        await Promise.all([this.loadCurrentPolicy(), this.loadSnapshots()]);
        return result;
      } catch (error) {
        this.lastError = error.message;
        throw error;
      } finally {
        this.isBusy = false;
      }
    },

    /**
     * 以指定角色执行一条 GraphQL，验证权限是否真的生效。
     *
     * 返回值就是 GraphJin 的 `{ data, errors }`：query 被拦时 data 里的字段是 null
     * （不报错），写操作被拦才带 errors —— 界面必须把这两种情况分开说。
     *
     * @param {string} role
     * @param {string} query
     * @returns {Promise<{data?: Object, errors?: Array}>}
     */
    async executeGraphql(role, query) {
      if (!this.isRunning) throw new Error(i18n.global.t('errors.verifyNeedsRunning'));
      return rpc('graphql.execute', { baseUrl: this.baseUrl, role, query });
    },

    /** 支持的 MCP 客户端（Claude Desktop / Cursor …）及各平台配置路径 */
    async loadClients() {
      const result = await rpcSafe('mcp.clients', { platform: undefined });
      if (result.ok) this.clients = result.data ?? [];
      else this.lastError = result.error ?? '';
    },

    /** 组织与成员都存在本地 SQLite，不依赖 GraphJin 是否在跑 */
    async loadOrganizations() {
      const result = await rpcSafe('users.listOrganizations');
      if (result.ok) this.organizations = result.data ?? [];
      else this.lastError = result.error ?? '';
    },

    async loadUsers() {
      const result = await rpcSafe('users.list');
      if (result.ok) this.users = result.data ?? [];
      else this.lastError = result.error ?? '';
    },

    /**
     * @param {string} name 组织名
     * @returns {Promise<Object>} 新建的组织
     */
    async createOrganization(name) {
      const result = await rpc('users.createOrganization', { name });
      await this.loadOrganizations();
      return result;
    },

    /**
     * 删除组织。后端在组织还有成员时会拒绝，避免级联删掉成员。
     *
     * @param {number} organizationId
     * @returns {Promise<{deleted: boolean, members: number}>}
     */
    async deleteOrganization(organizationId) {
      const result = await rpc('users.deleteOrganization', { organizationId });
      await this.loadOrganizations();
      return result;
    },

    /**
     * 改成员资料（姓名、邮箱）。角色单独走 setUserRole。
     *
     * @param {number} userId
     * @param {{name: string, email: string}} payload
     * @returns {Promise<Object>} 更新后的成员
     */
    async updateUser(userId, payload) {
      const result = await rpc('users.update', { userId, ...payload });
      await this.loadUsers();
      return result;
    },

    /**
     * 成员角色就是 GraphJin 角色名；角色不存在时写入规则会被拒，由 syncUserRoles 补齐。
     *
     * @param {{organizationId: number, name: string, email: string, role: string}} payload
     * @returns {Promise<Object>} 新建的成员
     */
    async createUser(payload) {
      const result = await rpc('users.create', payload);
      await this.loadUsers();
      return result;
    },

    /**
     * @param {number} userId
     * @param {string} role
     * @returns {Promise<{updated: boolean}>}
     */
    async setUserRole(userId, role) {
      const result = await rpc('users.setRole', { userId, role });
      await this.loadUsers();
      return result;
    },

    /**
     * @param {number} userId
     */
    async deleteUser(userId) {
      await rpc('users.delete', { userId });
      await this.loadUsers();
    },

    /**
     * 为成员签发 MCP 访问令牌。
     *
     * 令牌里的 role / user_code 就是网关转发给 GraphJin 的身份，改角色后需重新签发。
     *
     * @param {number} userId
     * @returns {Promise<{token: string, expiresIn: number, user: Object}>}
     */
    async createToken(userId) {
      return rpc('auth.token', { userId });
    },

    /**
     * 把成员用到的角色补齐进 GraphJin：角色不存在时 grants 引用会被拒。
     *
     * @returns {Promise<{created: string[], existing: string[]}>}
     */
    async syncUserRoles() {
      if (!this.isRunning) throw new Error(i18n.global.t('users.syncNeedsRunning'));
      return rpc('users.syncRoles', { baseUrl: this.baseUrl });
    },

    /**
     * 一键演示：建示例项目并启动。
     *
     * 不碰用户自己的库：示例表 + analyst 只读角色（行过滤），直接就能看到权限生效。
     *
     * @returns {Promise<Object>} demo.bootstrap 的结果
     */
    async bootstrapDemo() {
      this.isBusy = true;
      try {
        const report = await rpc('demo.bootstrap', {});
        this.status = report?.status ?? null;
        await Promise.all([
          this.loadConnectedDatabases(),
          this.loadSchema(),
          this.loadConnections(),
          // 演示是换了实例，接入配置必须跟着换，否则欢迎页第三步会停在旧端点上
          this.loadClientConfig(),
        ]);
        return report;
      } finally {
        this.isBusy = false;
      }
    },

    /**
     * 一键体检：后端 / 二进制 / 实例 / 库 / 角色的红绿灯。
     *
     * @returns {Promise<Array<{id: string, status: 'ok'|'fail'|'skip', detail: string}>>}
     */
    async runDiagnostics() {
      const data = await rpc('diagnostics.run', {});
      return data?.checks ?? [];
    },

    /**
     * 拉内置类型与自定义模板。类型元数据在后端，避免前端硬编码一份会漂移的白名单。
     */
    async loadDbTypes() {
      const result = await rpcSafe('db.types');
      if (result.ok) this.dbTypes = [...result.data.builtIn, ...result.data.templates];
      else this.lastError = result.error ?? '';
    },

    /**
     * 新增别名模板（如 TiDB → postgres 协议）。
     *
     * @param {Object} payload { id, label, wireType, defaultPort, note }
     */
    async addDbTemplate(payload) {
      const result = await rpc('db.templates.add', payload);
      this.dbTypes = [...this.builtInTypes, ...result.templates];
    },

    /**
     * @param {string} id 模板标识
     */
    async removeDbTemplate(id) {
      const result = await rpc('db.templates.remove', { id });
      this.dbTypes = [...this.builtInTypes, ...result.templates];
    },

    /**
     * 测试连接。validate_config 会真的去连目标库，后端不自己实现 ping。
     *
     * @param {string} name 连接名
     * @param {Object} connection dev.yml 里的库连接配置
     * @returns {Promise<{ok: boolean, message: string}>}
     */
    async testConnection(name, connection, { projectDir = null, appName = null } = {}) {
      const result = await rpc('connections.test', {
        // 未启动时留空：后端会起一个用完即停的临时实例做验证
        baseUrl: this.isRunning ? this.baseUrl : null,
        name,
        connection,
        projectDir,
        appName,
      });
      const errors = result?.errors ?? [];
      return {
        ok: result?.success === true || result?.valid === true,
        message: errors.length > 0 ? errors.join('；') : (result?.message ?? ''),
      };
    },

    /** 本地已保存的连接列表（摘要，不含密码） */
    async loadConnections() {
      const result = await rpcSafe('connections.list');
      if (result.ok) this.connections = result.data;
      else this.lastError = result.error ?? '';
    },

    /**
     * 取单条已保存连接，含解密后的 config。
     *
     * @param {number} id
     * @returns {Promise<Object|null>}
     */
    async fetchConnection(id) {
      return rpc('connections.get', { id });
    },

    /**
     * 删除已保存连接。
     *
     * 后端会把该库从运行实例的 dev.yml 里摘掉：还有别的库就重启，最后一个库
     * 就停掉服务。这里跟着同步运行态，否则 Schema 页会继续显示已经删掉的库。
     *
     * @param {number} id
     * @returns {Promise<{action: 'record'|'stopped'|'restarted'}>}
     */
    async removeConnection(id) {
      const result = await rpc('connections.remove', { id });
      await this.loadConnections();
      if (result?.action === 'stopped') {
        // 服务已经由后端停掉，复用停止流程把矩阵 / schema / 库列表一起归零
        await this.stopGraphJin();
      } else if (result?.action === 'restarted') {
        await this.refreshStatus();
        await this.loadConnectedDatabases();
        await this.loadSchema();
      }
      return result;
    },

    /**
     * 业务本体论：AI 查数据之前的语境。维护在这里，经 MCP 网关送给客户端。
     *
     * @returns {Promise<{entries: Array<Object>, rendered: string}>}
     */
    async loadOntology() {
      const result = await rpcSafe('ontology.list');
      if (result.ok) {
        this.ontology = result.data.entries ?? [];
        this.ontologyRendered = result.data.rendered ?? '';
      } else {
        this.lastError = result.error ?? '';
      }
      return result;
    },

    /**
     * @param {Object} entry 条目；带 id 为更新，否则按同库同名同类覆盖。
     *   aliases 收字符串（视图里是手填框），tables 收数组（视图里是下拉多选）
     * @returns {Promise<Object>} 保存后的条目
     */
    async saveOntology(entry) {
      const saved = await rpc('ontology.save', {
        ...entry,
        aliases: splitLoose(entry.aliases),
        tables: Array.isArray(entry.tables) ? entry.tables : splitLoose(entry.tables),
      });
      // 条目变了，上一次体检 / 候选 / 评测 / 编译的结论都立刻过期
      this.ontologyLint = null;
      this.ontologyProposals = null;
      this.ontologyEval = null;
      this.ontologyRules = null;
      await this.loadOntology();
      return saved;
    },

    /**
     * @param {number} id
     */
    async removeOntology(id) {
      await rpc('ontology.remove', { id });
      this.ontologyLint = null;
      this.ontologyProposals = null;
      this.ontologyEval = null;
      this.ontologyRules = null;
      await this.loadOntology();
    },

    /**
     * 一致性体检：只回答「结构是否自洽」，不回答「业务是否合理」。
     *
     * schema 由后端自己从运行中的实例取：前端把整份 schema 传过去既慢，也会让
     * 「体检」在页面没加载 schema 时行为不同。后端拿不到时自己会跳过需要 schema 的规则。
     *
     * @returns {Promise<Object>} 体检结果
     */
    async runOntologyLint() {
      this.ontologyLint = await rpc('ontology.lint', {});
      return this.ontologyLint;
    },

    /**
     * 从 schema 起草候选：没有概念的表、没有关系的外键、有注释却没有术语的列。
     *
     * 只拿候选，不写库——点「起草」才填表单，保存仍是人的动作。
     *
     * @returns {Promise<Object>} 候选
     */
    async proposeOntology() {
      this.ontologyProposals = await rpc('ontology.propose', {
        database: this.activeDatabase || null,
      });
      return this.ontologyProposals;
    },

    /**
     * 扫一列的真实取值，供「值域」使用。
     *
     * 只对低基数列有意义：后端会拒掉取值太多的列，避免把姓名/金额那种列塞进上下文。
     *
     * @param {{table: string, column: string}} params 裸表名与裸列名（会拼进 GraphQL）
     * @returns {Promise<Object>} 扫描结果
     */
    async scanOntologyValues({ table, column }) {
      return rpc('ontology.scanValues', { baseUrl: this.baseUrl, table, column });
    },

    /**
     * 样例评测。
     *
     * 测三件确定的事：样例还能不能跑、结构是否与声明一致、问题需要的表有没有被讲。
     * **不测模型答得好不好**——那需要真模型与真答案，这里没有，也不假装有。
     *
     * @returns {Promise<Object>} 评测报告
     */
    async runOntologyEval() {
      this.ontologyEval = await rpc('ontology.eval', {
        // 实例没跑时不传地址：后端会退化成只做结构与覆盖检查
        baseUrl: this.baseUrl || undefined,
        database: this.activeDatabase || undefined,
      });
      return this.ontologyEval;
    },

    /**
     * 把强制规则编译成权限补丁。
     *
     * 只算不写：返回的是「现状 + 规则」的完整 access 与变更清单，写不写由人决定。
     * 现状优先从运行中的实例读，停着时后端会退回 dev.yml——两边读的是同一份真相。
     *
     * @returns {Promise<Object>} 编译结果
     */
    async compileOntologyRules() {
      this.ontologyRules = await rpc('ontology.compileRules', {
        database: this.activeDatabase,
        baseUrl: this.baseUrl || null,
        projectDir: this.status?.projectDir ?? null,
        // 角色清单必须按**本体论页当前选中的库**取：applyDatabase 是权限页的选择，
        // 两者可以不同，取错了会把别的库的角色名报成「没有 grant」
        roles: this.rolesByDb[this.activeDatabase] ?? [],
      });
      return this.ontologyRules;
    },

    /**
     * 应用编译结果。
     *
     * 复用 `permissions.apply`：它写入前自动存快照、同步角色，并且走的是权限页同一条写入路径。
     * 另造一条「规则专用写入」等于绕开回滚能力，不划算。
     *
     * @param {Object} access 编译输出的完整 access
     * @returns {Promise<Object>} 写入结果
     */
    async applyOntologyRules(access) {
      const result = await rpc('permissions.apply', {
        baseUrl: this.baseUrl,
        projectDir: this.status?.projectDir ?? null,
        database: this.activeDatabase,
        // 快照来源写清楚：回滚时能分清这次是「应用规则补丁」还是手改矩阵
        reason: 'before-ontology-rules',
        matrix: {},
        // 同时传 grants：让角色同步也覆盖到补丁里出现的角色
        grants: access.grants,
        access,
      });
      await Promise.all([this.loadCurrentPolicy(), this.loadSnapshots()]);
      return result;
    },

    /**
     * 用已保存的连接直接启动。
     *
     * 启动前先验证连接：库可能已经下线（密码改了、服务停了、网络断了），
     * 不验证直接启动只会拿到一句 GraphJin 启动失败，看不出是连接本身的问题。
     *
     * 服务在跑时先停掉：supervisor 只托管一个实例，且启动参数只在项目没有
     * dev.yml 时生效，不先停就会让人误以为换了库、实际还是旧的。
     *
     * @param {number} id
     * @returns {Promise<Object>} 被启动的连接记录
     */
    async startFromSavedConnection(id) {
      const connection = await this.fetchConnection(id);
      if (!connection) throw new Error(i18n.global.t('connections.messages.missing'));
      if (!connection.config) throw new Error(i18n.global.t('connections.errors.unreadable'));
      // 启动前先验证：库可能已经下线（密码改了、服务停了、网络断了），
      // 不验证直接启动只会拿到一句 GraphJin 启动失败，看不出是连接本身的问题。
      // 服务在跑就复用现成实例验证，没跑就起一个用完即停的临时实例。
      // validate_config 有时把错误当结果返回、有时直接抛（isError），两条路都算没连上
      //
      // 先刷新状态：应用不轮询 graphjin.status，页面刷新还存在竞态（可能抓到停止前
      // 的旧状态），isRunning 会一直是 true。拿着过期 baseUrl 去验证只会得到
      // ECONNREFUSED，把好连接误判成坏连接 —— 下面选临时实例还是现成实例也依赖它。
      await this.refreshStatus();
      let probe;
      try {
        probe = await this.testConnection(connection.name, connection.config, {
          projectDir: connection.projectDir,
          appName: connection.appName,
        });
      } catch (error) {
        probe = { ok: false, message: error.message };
      }
      if (!probe.ok) {
        throw new Error(
          i18n.global.t('connections.errors.startVerifyFailed', {
            reason: probe.message || i18n.global.t('connections.messages.failed'),
          })
        );
      }
      if (this.isRunning) await this.stopGraphJin();
      await this.startGraphJin({
        projectDir: connection.projectDir,
        appName: connection.appName,
        databases: { [connection.name]: connection.config },
      });
      return connection;
    },

    /** Schema 页顶部的库列表：以运行中实例的实际配置为准 */
    async loadConnectedDatabases() {
      if (!this.isRunning) {
        this.connectedDatabases = [];
        this.activeDatabase = '';
        return;
      }
      const result = await rpcSafe('graphjin.databases', { baseUrl: this.baseUrl });
      if (!result.ok) {
        this.lastError = result.error ?? '';
        return;
      }
      this.connectedDatabases = result.data.databases ?? [];
      if (!this.connectedDatabases.includes(this.activeDatabase)) {
        this.activeDatabase = this.connectedDatabases[0] ?? '';
      }
    },

    async loadClientConfig({ gateway = false, token = null } = {}) {
      if (!this.isRunning) {
        this.clientConfig = null;
        return;
      }
      // 网关挂在平台自己的端口上；只有这条路带得上业务本体论（见 mcp-gateway.js）
      const gatewayUrl = gateway ? `http://127.0.0.1:${this.port}/api/v1/mcp` : null;
      const result = await rpcSafe('mcp.clientConfig', {
        baseUrl: this.baseUrl,
        ...(gatewayUrl ? { gatewayUrl } : {}),
        ...(token ? { token } : {}),
      });
      if (result.ok) this.clientConfig = result.data;
    },
  },
});
