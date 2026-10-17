/**
 * 策略归一化与变更 diff。
 *
 * 形态依据是 scripts/verify-columns.js 的真机 dump：get_current_config 返回的是
 * Go 结构体直出的键（Query / Columns / Filters / Limit，但 database 是小写），
 * 所以这里统一做大小写不敏感的取值。
 */

/** 四项操作，与后端 buildRoleTableConfig 一一对应 */
export const OPERATIONS = ['query', 'insert', 'update', 'delete'];

export const OPERATION_LABELS = {
  query: 'Query',
  insert: 'Insert',
  update: 'Update',
  delete: 'Delete',
};

/** 操作状态：allowed / blocked / default（配置里没写，走 default_block） */
export const STATES = {
  allowed: '允许',
  blocked: '阻止',
  default: '未配置',
};

/**
 * 大小写不敏感取值：get_current_config 的键是 Go 字段名，大小写不统一。
 *
 * @param {Object|null} source
 * @param {...string} keys
 * @returns {*}
 */
function pick(source, ...keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    if (key in source) return source[key];
  }
  const lowered = new Map(
    Object.entries(source).map(([key, value]) => [key.toLowerCase(), value])
  );
  for (const key of keys) {
    if (lowered.has(key.toLowerCase())) return lowered.get(key.toLowerCase());
  }
  return undefined;
}

function toArray(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

/**
 * 把一项操作配置归一化。
 *
 * @param {Object|null} raw GraphJin 的 Query / Insert / Update / Delete
 * @returns {{state: string, filters: string[], columns: string[], limit: number|null}}
 */
function normalizeOperation(raw) {
  if (!raw || typeof raw !== 'object') {
    return { state: 'default', filters: [], columns: [], limit: null };
  }
  const block = pick(raw, 'block');
  const limit = pick(raw, 'limit');
  return {
    state: block === true ? 'blocked' : 'allowed',
    filters: toArray(pick(raw, 'filters')),
    columns: toArray(pick(raw, 'columns')),
    limit: typeof limit === 'number' && limit > 0 ? limit : null,
  };
}

/**
 * 把 get_current_config 的结果归一化成与前端矩阵同构的结构。
 *
 * @param {Object} config config.current 的返回值
 * @returns {Object} { roleName: { tableName: { query, insert, update, delete } } }
 */
export function normalizeCurrentRoles(config = {}) {
  const result = {};
  for (const role of toArray(pick(config, 'roles'))) {
    const roleName = pick(role, 'name');
    if (!roleName) continue;
    const tables = {};
    for (const table of toArray(pick(role, 'tables'))) {
      const tableName = pick(table, 'name', 'Name');
      if (!tableName) continue;
      const operations = {};
      for (const operation of OPERATIONS) {
        // Go 直出的是 Query / Insert / Update / Delete，yaml 写入侧可能是小写
        operations[operation] = normalizeOperation(pick(table, operation, capitalize(operation)));
      }
      tables[tableName] = operations;
    }
    result[roleName] = tables;
  }
  return result;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * 把前端矩阵（含 columnMode）折算成可比较的状态视图。
 *
 * block 模式在 GraphJin 侧没有原生支持（实测对象形态被拒），只能表达成
 * 「全部列减去阻止列」的补集白名单，这里按同样的规则展开，保证 diff 与实际写入一致。
 *
 * @param {Object} matrix { role: { table: { query: {enabled, filters, columnMode, columns, limit} } } }
 * @param {Object} [columnsByTable] { tableName: string[] } block 模式求补集用
 * @returns {Object} 与 normalizeCurrentRoles 同构
 */
export function normalizePendingMatrix(matrix = {}, columnsByTable = {}) {
  const result = {};
  for (const [role, tables] of Object.entries(matrix ?? {})) {
    const normalized = {};
    for (const [table, operations] of Object.entries(tables ?? {})) {
      normalized[table] = {};
      for (const operation of OPERATIONS) {
        const op = operations?.[operation] ?? {};
        normalized[table][operation] = {
          state: op.enabled ? 'allowed' : 'blocked',
          filters: toArray(op.filters),
          columns: resolveColumns(op, columnsByTable[table] ?? []),
          limit: typeof op.limit === 'number' ? op.limit : null,
        };
      }
    }
    result[role] = normalized;
  }
  return result;
}

/**
 * 把列管控配置折算成 GraphJin 只认的白名单数组。
 *
 * @param {{columnMode?: string, columns?: string[]}} op
 * @param {string[]} allColumns 该表的全部列
 * @returns {string[]} 白名单；空数组表示不限制
 */
export function resolveColumns(op, allColumns = []) {
  const selected = toArray(op?.columns);
  if (selected.length === 0) return [];
  if (op?.columnMode !== 'block') return selected;
  const blocked = new Set(selected);
  return allColumns.filter((column) => !blocked.has(column));
}

function describeDetails(operation) {
  const parts = [];
  if (operation.filters.length > 0) parts.push(`行过滤 ${operation.filters.length} 条`);
  if (operation.columns.length > 0) parts.push(`列白名单 ${operation.columns.join(', ')}`);
  if (operation.limit !== null) parts.push(`默认 limit ${operation.limit}`);
  return parts.join(' · ');
}

/**
 * 对比当前生效策略与待应用矩阵。
 *
 * @param {Object} current normalizeCurrentRoles 的结果
 * @param {Object} pending normalizePendingMatrix 的结果
 * @returns {Array<Object>} 变更列表，每项含 kind / role / table / operation / from / to
 */
export function diffPolicy(current = {}, pending = {}) {
  const changes = [];
  for (const [role, tables] of Object.entries(pending)) {
    for (const [table, operations] of Object.entries(tables)) {
      for (const operation of OPERATIONS) {
        const to = operations[operation];
        const from = current?.[role]?.[table]?.[operation] ?? {
          state: 'default',
          filters: [],
          columns: [],
          limit: null,
        };
        const stateChanged = from.state !== to.state;
        const detailChanged =
          from.filters.join('|') !== to.filters.join('|') ||
          from.columns.join('|') !== to.columns.join('|') ||
          from.limit !== to.limit;
        if (!stateChanged && !detailChanged) continue;

        changes.push({
          role,
          table,
          operation,
          kind: current?.[role]?.[table] ? 'changed' : 'added',
          stateChanged,
          from,
          to,
          detail: describeDetails(to),
        });
      }
    }
  }
  return changes;
}
