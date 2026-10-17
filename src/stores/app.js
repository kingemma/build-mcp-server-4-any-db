import { defineStore } from 'pinia';
import { getPort, rpc, rpcSafe, setPort } from '../api/rpc';
import {
  OPERATIONS,
  OPERATION_LABELS,
  diffPolicy,
  normalizeCurrentRoles,
  normalizePendingMatrix,
  resolveColumns,
} from '../utils/policy';

export { OPERATIONS, OPERATION_LABELS };

function emptyOperation() {
  // columnMode: allow = 白名单；block = 阻止列表（写库时转成补集白名单）
  return { enabled: false, filters: [], columnMode: 'allow', columns: [], limit: null };
}

function columnsByTableOf(state) {
  const map = {};
  for (const table of state.schema?.tables ?? []) {
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
    /** { [role]: { [table]: { query, insert, update, delete } } } */
    matrix: {},
    clientConfig: null,
    /** 当前生效策略（get_current_config 归一化后） */
    currentPolicy: {},
    /** 内置数据库类型 + 用户自定义别名模板 */
    dbTypes: [],
    /** 本地已保存的连接（测试通过 / 启动成功后才会有） */
    connections: [],
    /** 运行中实例实际加载的库名 */
    connectedDatabases: [],
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
    tablesForCurrentRole: (state) => state.matrix[state.currentRole] ?? {},
    /** { tableName: string[] } 供 block 模式求补集 */
    columnsByTable: (state) => columnsByTableOf(state),
    pendingPolicy: (state) => normalizePendingMatrix(state.matrix, columnsByTableOf(state)),
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
        await Promise.all([this.loadConnections(), this.loadConnectedDatabases()]);
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
      this.syncMatrixTables();
      await this.loadCurrentPolicy();
    },

    /**
     * 新增角色后把已有表补进矩阵，避免出现“表没有默认策略”的空洞。
     */
    syncMatrixTables() {
      for (const role of this.roles) {
        const byTable = this.matrix[role] ?? {};
        for (const table of this.tables) {
          if (!byTable[table.name]) {
            byTable[table.name] = {
              query: emptyOperation(),
              insert: emptyOperation(),
              update: emptyOperation(),
              delete: emptyOperation(),
            };
          }
        }
        this.matrix[role] = byTable;
      }
    },

    /**
     * @param {string} name 角色名
     */
    addRole(name) {
      const trimmed = (name ?? '').trim();
      if (!trimmed || this.roles.includes(trimmed)) return false;
      this.roles.push(trimmed);
      this.matrix[trimmed] = {};
      if (!this.currentRole) this.currentRole = trimmed;
      this.syncMatrixTables();
      return true;
    },

    /**
     * @param {string} role
     * @param {string} table
     * @param {'query'|'insert'|'update'|'delete'} operation
     */
    toggleOperation(role, table, operation) {
      const entry = this.matrix[role]?.[table]?.[operation];
      if (entry) entry.enabled = !entry.enabled;
    },

    /**
     * 把当前矩阵折算成后端要的载荷：block 模式的列管控在这里展开成补集白名单。
     *
     * @returns {Object} { role: { table: { query, insert, update, delete } } }
     */
    resolveMatrix() {
      const columnsByTable = columnsByTableOf(this);
      const payload = {};
      for (const role of this.roles) {
        const tables = {};
        for (const [table, operations] of Object.entries(this.matrix[role] ?? {})) {
          tables[table] = {};
          for (const operation of OPERATIONS) {
            const op = operations?.[operation] ?? emptyOperation();
            tables[table][operation] = {
              enabled: op.enabled,
              filters: [...(op.filters ?? [])],
              columns: resolveColumns(op, columnsByTable[table] ?? []),
              limit: op.limit ?? null,
            };
          }
        }
        payload[role] = tables;
      }
      return payload;
    },

    /**
     * 读取当前生效策略，供预览面板做 diff。
     */
    async loadCurrentPolicy() {
      if (!this.isRunning) return;
      const result = await rpcSafe('config.current', { baseUrl: this.baseUrl });
      if (result.ok) this.currentPolicy = normalizeCurrentRoles(result.data);
      else this.lastError = result.error ?? '';
    },

    /**
     * 把当前矩阵写入 GraphJin（方案 B：roles[].tables）。
     * legacy 模式立即生效，所以调用方必须先展示 diff 并二次确认。
     *
     * @param {string} database 库名，缺失会让规则落到内部库
     * @returns {Promise<Object>} 后端返回的写入结果
     */
    async applyPermissions(database) {
      this.isBusy = true;
      this.lastError = '';
      try {
        const result = await rpc('permissions.apply', {
          baseUrl: this.baseUrl,
          database,
          matrix: this.resolveMatrix(),
        });
        await this.loadCurrentPolicy();
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
      if (!connection) throw new Error('保存的连接不存在');
      if (!connection.config) throw new Error('这条连接无法解密，请重新填写并测试一次');
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
