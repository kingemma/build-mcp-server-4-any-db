import { defineStore } from 'pinia';
import i18n from '../i18n';
import { getPort, rpc, rpcSafe, setPort } from '../api/rpc';
import {
  OPERATIONS,
  OPERATION_KEYS,
  STATE_KEYS,
  diffPolicy,
  normalizeCurrentRoles,
  normalizePendingMatrix,
  resolveColumns,
  scopeToDatabase,
  unresolvedBlockTables,
} from '../utils/policy';

export { OPERATIONS, OPERATION_KEYS, STATE_KEYS };

/** 平台保留角色：始终全权限，不进入可编辑矩阵 */
const RESERVED_ROLES = new Set(['admin']);

function emptyOperation() {
  // columnMode: allow = 白名单；block = 阻止列表（写库时转成补集白名单）
  return { enabled: false, filters: [], columnMode: 'allow', columns: [], limit: null };
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
    status: null,
    tables: [],
    schema: null,
    roles: [],
    currentRole: '',
    /** 权限矩阵写入目标库；矩阵键是 `database::table` */
    applyDatabase: '',
    /** { [role]: { ['database::table']: { query, insert, update, delete } } } */
    matrix: {},
    clientConfig: null,
    /** 当前生效策略，按库分隔的原始归一化结果（键为 `database::table`） */
    policyRaw: {},
    /** 当前生效策略，已按 applyDatabase 收敛成纯表名 */
    currentPolicy: {},
    /** 内置数据库类型 + 用户自定义别名模板 */
    dbTypes: [],
    /** 本地已保存的连接（测试通过 / 启动成功后才会有） */
    connections: [],
    /** 运行中实例实际加载的库名 */
    connectedDatabases: [],
    /** 权限写入快照（摘要，不含 roles 全文） */
    snapshots: [],
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
    /** 写入目标库下的表名；矩阵只展示、只提交这个库的表 */
    applyTables: (state) =>
      state.tables
        .filter((table) => table.database === state.applyDatabase)
        .map((table) => table.name),
    tablesForCurrentRole: (state) =>
      scopeToDatabase(
        { [state.currentRole]: state.matrix[state.currentRole] ?? {} },
        state.applyDatabase
      )[state.currentRole] ?? {},
    /** { tableName: string[] } 供 block 模式求补集，只含当前目标库 */
    columnsByTable: (state) => columnsByTableOf(state, state.applyDatabase),
    pendingPolicy: (state) =>
      normalizePendingMatrix(
        scopeToDatabase(state.matrix, state.applyDatabase),
        columnsByTableOf(state, state.applyDatabase)
      ),
    changes(state) {
      return diffPolicy(state.currentPolicy, this.pendingPolicy);
    },
  },

  actions: {
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
        // 换项目/换实例时矩阵不能跨项目残留：键里只有库名和表名，同名表会串
        this.roles = [];
        this.currentRole = '';
        this.matrix = {};
        this.policyRaw = {};
        this.currentPolicy = {};
        this.applyDatabase = '';
        this.snapshots = [];
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
      await this.loadCurrentPolicy();
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
      const policy = scopeToDatabase(this.policyRaw, this.applyDatabase);
      const tableNames = new Set(this.applyTables);
      const roles = new Set();
      const tables = new Set();

      for (const [role, roleTables] of Object.entries(policy)) {
        // admin 由平台保证存在且全权限，不放进矩阵，避免被误改成受限角色
        if (RESERVED_ROLES.has(role)) continue;
        if (!this.roles.includes(role)) this.roles.push(role);
        const byTable = this.matrix[role] ?? {};
        for (const [table, operations] of Object.entries(roleTables)) {
          if (!tableNames.has(table)) continue;
          const key = this.tableKey(table);
          if (byTable[key] && !overwrite) continue;
          byTable[key] = {};
          for (const operation of OPERATIONS) {
            const op = operations[operation] ?? {};
            byTable[key][operation] = {
              // 'default' 表示配置里没写，等同 default_block
              enabled: op.state === 'allowed',
              filters: [...(op.filters ?? [])],
              columnMode: 'allow',
              columns: [...(op.columns ?? [])],
              limit: op.limit ?? null,
            };
          }
          roles.add(role);
          tables.add(key);
        }
        this.matrix[role] = byTable;
      }

      // 覆盖导入：生效策略里没有的格子一并重置为「全拦」，否则本地残留的规则会留下来
      if (overwrite) {
        for (const [role, byTable] of Object.entries(this.matrix)) {
          for (const table of tableNames) {
            if (policy[role]?.[table]) continue;
            const key = this.tableKey(table);
            if (!byTable[key]) continue;
            byTable[key] = {
              query: emptyOperation(),
              insert: emptyOperation(),
              update: emptyOperation(),
              delete: emptyOperation(),
            };
          }
        }
      }

      if (!this.currentRole && this.roles.length) this.currentRole = this.roles[0];
      return { roles: roles.size, tables: tables.size };
    },

    /**
     * @param {string} name 角色名
     */
    addRole(name) {
      const trimmed = (name ?? '').trim();
      if (!trimmed || RESERVED_ROLES.has(trimmed) || this.roles.includes(trimmed)) return false;
      this.roles.push(trimmed);
      this.matrix[trimmed] = {};
      if (!this.currentRole) this.currentRole = trimmed;
      return true;
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
      const key = this.tableKey(table);
      this.matrix[role] ??= {};
      this.matrix[role][key] ??= {};
      const entry = this.matrix[role][key];
      for (const operation of OPERATIONS) {
        entry[operation] ??= emptyOperation();
      }
      return entry;
    },

    /**
     * 矩阵键：`database::table`。视图只拿纯表名，这里统一加库名前缀。
     *
     * @param {string} table
     * @returns {string}
     */
    tableKey(table) {
      return this.applyDatabase ? `${this.applyDatabase}::${table}` : table;
    },

    /**
     * @param {string} role
     * @param {string} table 纯表名
     * @param {'query'|'insert'|'update'|'delete'} operation
     * @returns {Object|undefined}
     */
    operationOf(role, table, operation) {
      return this.matrix[role]?.[this.tableKey(table)]?.[operation];
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
      const columnsByTable = columnsByTableOf(this, this.applyDatabase);
      const scoped = scopeToDatabase(this.matrix, this.applyDatabase);
      // block 模式要展开成补集白名单；没有列清单就不能写，否则会静默放行全部列
      const unresolved = unresolvedBlockTables(scoped, columnsByTable);
      if (unresolved.length > 0) {
        throw new Error(
          i18n.global.t('permissions.blockNeedsSchema', { tables: unresolved.join(', ') })
        );
      }
      const payload = {};
      for (const [role, tables] of Object.entries(scoped)) {
        // 保留角色不写 roles[].tables；后端会单独确保它存在
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
              limit: op.limit ?? null,
            };
          }
        }
        payload[role] = entries;
      }
      return payload;
    },

    /**
     * 读取当前生效策略，供预览面板做 diff。
     */
    async loadCurrentPolicy() {
      if (!this.isRunning) return;
      const result = await rpcSafe('config.current', { baseUrl: this.baseUrl });
      if (!result.ok) {
        this.lastError = result.error ?? '';
        return;
      }
      this.policyRaw = normalizeCurrentRoles(result.data);
      this.applyPolicyScope();
      // 启动后角色与矩阵都是空的：自动回填一次，已配置的策略才能继续编辑
      this.hydrateMatrixFromPolicy();
    },

    /** 把完整策略按写入目标库收敛，diff 与策略页只比较这个库 */
    applyPolicyScope() {
      this.currentPolicy = scopeToDatabase(this.policyRaw, this.applyDatabase);
    },

    /**
     * 切换写入目标库：矩阵与 diff 范围都跟着换。
     *
     * @param {string} database
     */
    selectDatabase(database) {
      if (this.applyDatabase === database) return;
      this.applyDatabase = database;
      this.applyPolicyScope();
      // 新库可能已经有生效策略：切过去时把空格子回填一次
      this.hydrateMatrixFromPolicy();
    },

    /**
     * 把当前矩阵写入 GraphJin（方案 B：roles[].tables）。
     * legacy 模式立即生效，所以调用方必须先展示 diff 并二次确认。
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
     * @param {number} id
     */
    async removeConnection(id) {
      await rpc('connections.remove', { id });
      await this.loadConnections();
    },

    /**
     * 用已保存的连接直接启动。
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

    async loadClientConfig() {
      if (!this.isRunning) return;
      const result = await rpcSafe('mcp.clientConfig', { baseUrl: this.baseUrl });
      if (result.ok) this.clientConfig = result.data;
    },
  },
});
