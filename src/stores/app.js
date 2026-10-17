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
    lastError: '',
  }),

  getters: {
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

    async loadClientConfig() {
      if (!this.isRunning) return;
      const result = await rpcSafe('mcp.clientConfig', { baseUrl: this.baseUrl });
      if (result.ok) this.clientConfig = result.data;
    },
  },
});
