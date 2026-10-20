'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * 权限写入快照。
 *
 * legacy 模式下 `update_current_config` 立即生效、没有 GraphJin 侧的 preview/apply，
 * 误操作只能手工改回。这里在每次写入前把 `get_current_config` 的 roles 原样落盘，
 * 需要时整份恢复，并对「本次写入新增的角色」调用 remove_roles 清掉。
 *
 * 快照按项目目录归档：GraphJin 的端口每次启动都可能变，baseUrl 不适合当身份。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS policy_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key TEXT NOT NULL,
  project_dir TEXT,
  base_url TEXT,
  database TEXT,
  reason TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  role_count INTEGER NOT NULL,
  source_access_json TEXT,
  source_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_snapshots_project
  ON policy_snapshots(project_key, id DESC);
`;

/** 单项目保留的快照数量，够覆盖连续误操作即可 */
const MAX_PER_PROJECT = 30;

/** admin 是平台执行配置读写所依赖的角色，任何回滚都不能把它删掉 */
const PROTECTED_ROLES = new Set(['admin']);

class SnapshotStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotStoreError';
  }
}

/**
 * 取角色名列表，忽略没有 name 的脏数据。
 *
 * @param {Array<Object>} roles
 * @returns {string[]}
 */
function roleNamesOf(roles) {
  return (Array.isArray(roles) ? roles : [])
    .map((role) => role?.name)
    .filter((name) => typeof name === 'string' && name !== '');
}

/**
 * get_current_config 返回的是 Go 结构体直出：表名是 `Name`、操作是 `Query/Insert/...`，
 * 而 update_current_config 的 schema 要求 `name` / `query`。回放前必须归一化，
 * 否则会报 `required: missing properties: ["name"]`（实测）。
 *
 * @param {Object|null} raw GraphJin 的操作对象
 * @param {boolean} withLimit 只有 query 支持 limit
 * @returns {{block: boolean, filters?: string[], columns?: string[], limit?: number}}
 */
function normalizeOperation(raw, withLimit = false) {
  if (!raw || typeof raw !== 'object') return { block: true };
  const block = raw.block ?? raw.Block;
  const result = { block: block === true };

  const filters = raw.filters ?? raw.Filters;
  if (Array.isArray(filters) && filters.length > 0) result.filters = filters;
  const columns = raw.columns ?? raw.Columns;
  if (Array.isArray(columns) && columns.length > 0) result.columns = columns;
  if (withLimit) {
    const limit = raw.limit ?? raw.Limit;
    if (Number.isInteger(limit) && limit > 0) result.limit = limit;
  }
  return result;
}

/**
 * 把快照里的 roles 转成可回写的形态。
 *
 * @param {Array<Object>} roles get_current_config 的 roles 原样
 * @param {Object} [options]
 * @param {string} [options.database] 表缺少 database 时的兜底
 * @returns {Array<{name: string, tables: Array<Object>}>}
 */
function rolesForWrite(roles, { database = null } = {}) {
  const result = [];
  for (const role of Array.isArray(roles) ? roles : []) {
    const name = role?.name;
    if (typeof name !== 'string' || name === '') continue;

    const tables = [];
    for (const table of Array.isArray(role.tables) ? role.tables : []) {
      const tableName = table?.name ?? table?.Name;
      if (typeof tableName !== 'string' || tableName === '') continue;
      const entry = {
        name: tableName,
        database: table?.database ?? table?.Database ?? database ?? undefined,
        query: normalizeOperation(table?.query ?? table?.Query, true),
        insert: normalizeOperation(table?.insert ?? table?.Insert),
        update: normalizeOperation(table?.update ?? table?.Update),
        delete: normalizeOperation(table?.delete ?? table?.Delete),
      };
      // 平台不编辑这两项，但快照回放要尽量保留，避免回滚顺带抹掉手写配置
      const schema = table?.schema ?? table?.Schema;
      if (typeof schema === 'string' && schema !== '') entry.schema = schema;
      if (table?.read_only === true) entry.read_only = true;
      tables.push(entry);
    }
    result.push({ name, tables });
  }
  return result;
}

/**
 * 把快照里的 source access 转成可回写形态。
 *
 * 只保留 access：连接字段（含密码）在 get_current_config 里是脱敏的，
 * 回滚绝不能把 `[REDACTED]` 写回配置，所以回滚走 source_patches 只改权限。
 *
 * @param {Object|null} access get_current_config 里的 access 原样
 * @returns {Object|undefined}
 */
function accessForWrite(access) {
  if (!access || typeof access !== 'object') return undefined;
  const variants = (key) => [
    key,
    key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
    key
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(''),
  ];
  const pick = (key) => {
    for (const name of variants(key)) {
      if (access[name] !== undefined) return access[name];
    }
    return undefined;
  };

  const result = {};
  for (const key of ['read', 'write', 'delete', 'owner_column', 'namespace_column']) {
    const value = pick(key);
    if (typeof value === 'string' && value !== '') result[key] = value;
  }
  for (const key of ['admin_tables', 'blocked_tables']) {
    const value = pick(key);
    if (Array.isArray(value) && value.length > 0) result[key] = value;
  }

  const grants = access.grants ?? access.Grants;
  if (Array.isArray(grants) && grants.length > 0) {
    result.grants = grants
      .map((grant) => {
        const role = grant?.role ?? grant?.Role;
        const tables = (grant?.tables ?? grant?.Tables ?? [])
          .map((table) => {
            const name = table?.name ?? table?.Name;
            const columns = table?.columns ?? table?.Columns ?? [];
            if (typeof name !== 'string' || columns.length === 0) return null;
            const entry = { name, columns };
            const filter = table?.filter ?? table?.Filter;
            if (typeof filter === 'string' && filter !== '') entry.filter = filter;
            return entry;
          })
          .filter(Boolean);
        if (typeof role !== 'string' || tables.length === 0) return null;
        return { role, tables };
      })
      .filter(Boolean);
    if (result.grants.length === 0) delete result.grants;
  }

  return result;
}

/**
 * 生成「恢复到快照」的配置补丁。
 *
 * 只发 roles 不会删除本次新增的角色（实测：未列出的角色原样保留），
 * 所以必须显式 remove_roles。admin 永远保留，否则平台会把自己锁死。
 *
 * @param {Array<Object>} snapshotRoles 快照里的 roles（get_current_config 原样）
 * @param {Array<Object>} currentRoles 当前 roles
 * @param {Object} [options]
 * @param {string} [options.database] 表缺少 database 时的兜底
 * @param {string[]} [options.protectedRoles] 额外保护的角色名
 * @param {Array<Object>} [options.sources] 快照里的 sources（含 access），用于恢复权限
 * @returns {{roles: Array<Object>, remove_roles?: string[], source_patches?: Array<Object>}}
 */
function buildRollbackPatch(
  snapshotRoles,
  currentRoles,
  { database = null, protectedRoles = [], sources = [] } = {}
) {
  const snapshot = rolesForWrite(snapshotRoles, { database });
  const currentNames = roleNamesOf(currentRoles);
  const snapshotNames = new Set(roleNamesOf(snapshot));
  const keep = new Set([...PROTECTED_ROLES, ...protectedRoles]);

  const remove = currentNames.filter((name) => !snapshotNames.has(name) && !keep.has(name));
  const patch = { roles: snapshot };
  if (remove.length > 0) patch.remove_roles = remove;

  const patches = (Array.isArray(sources) ? sources : [])
    .map((source) => {
      const access = accessForWrite(source?.access);
      return source?.name && access ? { name: source.name, access } : null;
    })
    .filter(Boolean);
  if (patches.length > 0) patch.source_patches = patches;

  return patch;
}

class SnapshotStore {
  /**
   * @param {string} dbPath SQLite 文件路径，传 ':memory:' 可建内存库
   */
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    // 同一个 SQLite 文件还可能被 UserStore / ConnectionStore 写入，稍等锁而不是立刻报错
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.#ensureColumns();
  }

  /**
   * 旧库升级：source 模式需要额外保存每个数据源的 access。
   */
  #ensureColumns() {
    const columns = this.db.prepare('PRAGMA table_info(policy_snapshots)').all();
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('source_access_json')) {
      this.db.exec('ALTER TABLE policy_snapshots ADD COLUMN source_access_json TEXT');
    }
    if (!names.has('source_count')) {
      this.db.exec(
        'ALTER TABLE policy_snapshots ADD COLUMN source_count INTEGER NOT NULL DEFAULT 0'
      );
    }
  }

  close() {
    this.db.close();
  }

  /**
   * 规范化项目身份。相对路径统一转绝对路径，避免同一目录存成两条。
   *
   * @param {Object} input
   * @param {string} [input.projectDir]
   * @param {string} [input.baseUrl]
   * @returns {string}
   */
  static projectKey({ projectDir, baseUrl } = {}) {
    if (typeof projectDir === 'string' && projectDir.trim() !== '') {
      return path.resolve(projectDir.trim());
    }
    if (typeof baseUrl === 'string' && baseUrl.trim() !== '') {
      return baseUrl.trim().replace(/\/+$/, '');
    }
    throw new SnapshotStoreError('projectDir 与 baseUrl 至少需要一个');
  }

  /**
   * 保存一份快照。
   *
   * @param {Object} input
   * @param {string} [input.projectDir]
   * @param {string} [input.baseUrl]
   * @param {string} [input.database]
   * @param {'before-apply'|'before-rollback'|string} [input.reason]
   * @param {Array<Object>} input.roles get_current_config 的 roles 原样
   * @param {Array<Object>} [input.sources] get_current_config 的 sources 原样（取 name + access）
   * @returns {Object} 快照摘要（不含 roles）
   */
  save({
    projectDir = null,
    baseUrl = null,
    database = null,
    reason = 'before-apply',
    roles = [],
    sources = [],
  } = {}) {
    if (!Array.isArray(roles)) throw new SnapshotStoreError('roles 必须是数组');
    if (!Array.isArray(sources)) throw new SnapshotStoreError('sources 必须是数组');
    const projectKey = SnapshotStore.projectKey({ projectDir, baseUrl });
    const now = new Date().toISOString();
    const sourceAccess = sources
      .filter((source) => source?.name)
      .map((source) => ({ name: source.name, access: source.access ?? null }));
    const row = this.db
      .prepare(
        `INSERT INTO policy_snapshots
           (project_key, project_dir, base_url, database, reason, roles_json, role_count,
            source_access_json, source_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .get(
        projectKey,
        projectDir ? path.resolve(projectDir) : null,
        baseUrl,
        database,
        reason,
        JSON.stringify(roles),
        roleNamesOf(roles).length,
        sourceAccess.length > 0 ? JSON.stringify(sourceAccess) : null,
        sourceAccess.length,
        now
      );

    this.#prune(projectKey);
    return this.summary(row.id);
  }

  /**
   * @param {string} projectKey
   */
  #prune(projectKey) {
    this.db
      .prepare(
        `DELETE FROM policy_snapshots
         WHERE project_key = ?
           AND id NOT IN (
             SELECT id FROM policy_snapshots
             WHERE project_key = ?
             ORDER BY id DESC
             LIMIT ?
           )`
      )
      .run(projectKey, projectKey, MAX_PER_PROJECT);
  }

  /**
   * 列表只返回摘要：roles_json 可能很大，且策略页已经有同样内容。
   *
   * @param {Object} [filter]
   * @param {string} [filter.projectDir]
   * @param {string} [filter.baseUrl]
   * @param {number} [filter.limit] 默认 20
   * @returns {Array<Object>}
   */
  list({ projectDir = null, baseUrl = null, limit = 20 } = {}) {
    const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PER_PROJECT) : 20;
    if (projectDir || baseUrl) {
      const projectKey = SnapshotStore.projectKey({ projectDir, baseUrl });
      return this.db
        .prepare(
          'SELECT * FROM policy_snapshots WHERE project_key = ? ORDER BY id DESC LIMIT ?'
        )
        .all(projectKey, size)
        .map((row) => this.#summarize(row));
    }
    return this.db
      .prepare('SELECT * FROM policy_snapshots ORDER BY id DESC LIMIT ?')
      .all(size)
      .map((row) => this.#summarize(row));
  }

  /**
   * @param {number} id
   * @returns {Object|null} 含 roles 全文
   */
  get(id) {
    if (!Number.isInteger(id)) throw new SnapshotStoreError('id 必须是整数');
    const row = this.db.prepare('SELECT * FROM policy_snapshots WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...this.#summarize(row),
      roles: JSON.parse(row.roles_json),
      sources: row.source_access_json ? JSON.parse(row.source_access_json) : [],
    };
  }

  /**
   * @param {number} id
   * @returns {boolean}
   */
  remove(id) {
    if (!Number.isInteger(id)) throw new SnapshotStoreError('id 必须是整数');
    return this.db.prepare('DELETE FROM policy_snapshots WHERE id = ?').run(id).changes > 0;
  }

  summary(id) {
    const row = this.db.prepare('SELECT * FROM policy_snapshots WHERE id = ?').get(id);
    return row ? this.#summarize(row) : null;
  }

  #summarize(row) {
    return {
      id: row.id,
      projectKey: row.project_key,
      projectDir: row.project_dir,
      baseUrl: row.base_url,
      database: row.database,
      reason: row.reason,
      roleCount: row.role_count,
      sourceCount: row.source_count ?? 0,
      createdAt: row.created_at,
    };
  }
}

module.exports = {
  SnapshotStore,
  SnapshotStoreError,
  MAX_PER_PROJECT,
  PROTECTED_ROLES,
  buildRollbackPatch,
  normalizeOperation,
  roleNamesOf,
  rolesForWrite,
  accessForWrite,
};
