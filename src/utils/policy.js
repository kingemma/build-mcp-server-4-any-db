/**
 * 策略归一化与变更 diff。
 *
 * GraphJin source 模式下，角色只能约束「读」：`sources[].access.grants[]`。
 * 写/删是 source 级开关（`access.write` / `access.delete`），不按角色区分。
 */

/** 角色级可编辑的操作：只剩读 */
export const OPERATIONS = ['query'];

/** 操作名的 i18n key；文案不落在这里，视图用 t() 渲染 */
export const OPERATION_KEYS = {
  query: 'permissions.operations.query',
};

/** source 级访问档位（与 GraphJin access 枚举一致） */
export const ACCESS_MODES = ['authenticated', 'owner', 'account', 'blocked'];

/** 读档位额外支持 public */
export const READ_MODES = ['public', ...ACCESS_MODES];

/** 需要 owner 列配合的档位 */
export const OWNER_MODES = new Set(['owner']);

/** 操作状态：allowed / blocked / default（配置里没写，走 default_block） */
export const STATE_KEYS = {
  allowed: 'permissions.states.allowed',
  blocked: 'permissions.states.blocked',
  default: 'permissions.states.default',
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
 * 把 get_current_config 的结果归一化成与前端矩阵同构的结构。
 *
 * 表键带库名（`database::table`）：多库项目里同名表不能互相覆盖，
 * 展示和写入前再用 scopeToDatabase 还原成纯表名。
 *
 * @param {Object} config config.current 的返回值
 * @returns {Object} { roleName: { 'database::table': { query, insert, update, delete } } }
 */
export function normalizeCurrentRoles(config = {}) {
  const result = {};
  for (const source of toArray(pick(config, 'sources'))) {
    const database = pick(source, 'name');
    if (!database) continue;
    const access = pick(source, 'access') ?? {};
    for (const grant of toArray(pick(access, 'grants'))) {
      const roleName = pick(grant, 'role');
      if (!roleName) continue;
      result[roleName] ??= {};
      for (const table of toArray(pick(grant, 'tables'))) {
        const tableName = pick(table, 'name', 'Name');
        if (!tableName) continue;
        const filter = pick(table, 'filter');
        result[roleName][`${database}::${tableName}`] = {
          query: {
            state: 'allowed',
            filters: filter ? [filter] : [],
            columns: toArray(pick(table, 'columns')),
          },
        };
      }
    }
  }
  return result;
}

/**
 * 把每个数据源的 source 级访问档位归一化。
 *
 * @param {Object} config config.current 的返回值
 * @returns {Object} { [database]: { read, write, delete, ownerColumn, namespaceColumn, adminTables, blockedTables } }
 */
export function normalizeSourceAccesses(config = {}) {
  const result = {};
  for (const source of toArray(pick(config, 'sources'))) {
    const name = pick(source, 'name');
    if (!name) continue;
    const access = pick(source, 'access') ?? {};
    result[name] = {
      read: pick(access, 'read') ?? 'authenticated',
      write: pick(access, 'write') ?? 'blocked',
      delete: pick(access, 'delete') ?? 'blocked',
      ownerColumn: pick(access, 'owner_column') ?? '',
      namespaceColumn: pick(access, 'namespace_column') ?? '',
      adminTables: toArray(pick(access, 'admin_tables')),
      blockedTables: toArray(pick(access, 'blocked_tables')),
    };
  }
  return result;
}

/**
 * 缺省（还没读到配置时）的 source 级档位：读需认证，写/删关闭。
 *
 * @returns {Object}
 */
export function emptySourceAccess() {
  return {
    read: 'authenticated',
    write: 'blocked',
    delete: 'blocked',
    ownerColumn: '',
    namespaceColumn: '',
    adminTables: [],
    blockedTables: [],
  };
}

/**
 * 把前端表单里的档位折成后端 `permissions.build/apply` 的 access 入参。
 *
 * @param {Object} access
 * @returns {Object}
 */
export function toAccessPayload(access = {}) {
  const payload = {
    read: access.read ?? 'authenticated',
    write: access.write ?? 'blocked',
    delete: access.delete ?? 'blocked',
  };
  if (access.ownerColumn) payload.ownerColumn = access.ownerColumn;
  if (access.namespaceColumn) payload.namespaceColumn = access.namespaceColumn;
  if (access.adminTables?.length) payload.adminTables = access.adminTables;
  if (access.blockedTables?.length) payload.blockedTables = access.blockedTables;
  return payload;
}

/**
 * 取出某个库的条目，并把 `database::table` 键还原成纯表名。
 *
 * database 为空时保留全部条目并统一剥掉已有的库前缀：启动早期还没确定目标库，
 * 此时至少要让策略页能展示内容，而不是整片空白。
 *
 * @param {Object} map { roleName: { 'database::table': value } }
 * @param {string} database 库名
 * @returns {Object} { roleName: { tableName: value } }；该库下没有表时省略该角色
 */
export function scopeToDatabase(map = {}, database = '') {
  const prefix = database ? `${database}::` : '';
  const result = {};
  for (const [role, entries] of Object.entries(map ?? {})) {
    const scoped = {};
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (prefix) {
        if (!key.startsWith(prefix)) continue;
        scoped[key.slice(prefix.length)] = value;
        continue;
      }
      const separator = key.indexOf('::');
      scoped[separator >= 0 ? key.slice(separator + 2) : key] = value;
    }
    if (Object.keys(scoped).length > 0) result[role] = scoped;
  }
  return result;
}

/**
 * 找出「block 模式列管控」但缺少表列清单的条目。
 *
 * GraphJin 的 `columns` 只接受白名单，block 模式必须展开成补集；表还没被
 * catalog 发现时补集无从计算，直接写会把所有列静默放行（基线 §6.6）。
 *
 * @param {Object} matrix { role: { tableName: { query, insert, update, delete } } }
 * @param {Object} columnsByTable { tableName: string[] }
 * @returns {string[]} 无法展开的表名（去重）
 */
export function unresolvedBlockTables(matrix = {}, columnsByTable = {}) {
  const unresolved = new Set();
  for (const tables of Object.values(matrix ?? {})) {
    for (const [table, operations] of Object.entries(tables ?? {})) {
      if ((columnsByTable[table] ?? []).length > 0) continue;
      for (const operation of OPERATIONS) {
        const entry = operations?.[operation];
        if (entry?.columnMode === 'block' && (entry.columns ?? []).length > 0) {
          unresolved.add(table);
          break;
        }
      }
    }
  }
  return [...unresolved];
}

/**
 * 把前端矩阵（含 columnMode）折算成可比较的状态视图。
 *
 * block 模式在 GraphJin 侧没有原生支持（实测对象形态被拒），只能表达成
 * 「全部列减去阻止列」的补集白名单，这里按同样的规则展开，保证 diff 与实际写入一致。
 *
 * @param {Object} matrix { role: { table: { query: {enabled, filters, columnMode, columns} } } }
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
 * 一个列都没选 = 不限制列，展开成全部列：GraphJin 的 `grants[].columns` 必填，
 * 后端拿不到列清单时也会从 schema 补成全部列。这里同样展开，才能和写入后读回的
 * 策略对上，否则每次写完都留一条永远消不掉的「列白名单」假 diff。
 *
 * @param {{columnMode?: string, columns?: string[]}} op
 * @param {string[]} allColumns 该表的全部列；缺 schema 时为空数组
 * @returns {string[]} 白名单；空数组表示列清单未知
 */
export function resolveColumns(op, allColumns = []) {
  const selected = toArray(op?.columns);
  if (selected.length === 0) return [...allColumns];
  if (op?.columnMode !== 'block') return selected;
  const blocked = new Set(selected);
  return allColumns.filter((column) => !blocked.has(column));
}

/**
 * 把一项操作的附加规则抽成结构化片段，文案由调用方按语言渲染。
 *
 * @param {{filters: string[], columns: string[]}} operation
 * @returns {{filters: number, columns: string[]}}
 */
function describeDetails(operation) {
  return {
    filters: operation.filters.length,
    columns: operation.columns,
  };
}

/**
 * 渲染附加规则摘要。
 *
 * @param {{filters: number, columns: string[]}} detail
 * @param {(key: string, params?: Object) => string} t i18n 的 t
 * @returns {string}
 */
export function formatDetail(detail, t) {
  if (!detail) return '';
  const parts = [];
  if (detail.filters > 0) parts.push(t('permissions.detail.filters', { count: detail.filters }));
  if (detail.columns.length > 0) {
    parts.push(t('permissions.detail.allowList', { columns: detail.columns.join(', ') }));
  }
  return parts.join(' · ');
}

/**
 * 渲染一项操作的规则摘要（把过滤条件与列名原样列出）。
 *
 * @param {{filters?: string[], columns?: string[]}} operation
 * @param {(key: string, params?: Object) => string} t
 * @returns {string}
 */
export function formatOperationRules(operation, t) {
  const parts = [];
  if (operation?.filters?.length > 0) {
    parts.push(t('permissions.detail.filtersShort', { value: operation.filters.join(' / ') }));
  }
  if (operation?.columns?.length > 0) {
    parts.push(t('permissions.detail.columnsShort', { value: operation.columns.join(', ') }));
  }
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
        };
        const stateChanged = from.state !== to.state;
        const detailChanged =
          from.filters.join('|') !== to.filters.join('|') ||
          from.columns.join('|') !== to.columns.join('|');
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
