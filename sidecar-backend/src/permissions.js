'use strict';

/**
 * 权限编排：把平台内部的权限矩阵转换成 GraphJin 配置。
 *
 * 当前正在从 legacy（`databases` + `roles[].tables`）迁移到 source 模式：
 * - `buildSourceAccessConfig` / `migrateLegacyRoleTables` 是新的写入路径；
 * - `buildRoleTableConfig` 保留，只用于读取与迁移旧项目的矩阵。
 *
 * source 模式的能力边界见 docs/graphjin-source-migration.md §2：
 * 写/删只到 source 级，表级可见性只有公开 / 仅 admin / 全局屏蔽三档。
 */

/**
 * 单项操作（query / insert / update / delete）的配置。
 *
 * @param {{enabled?: boolean, filters?: string[], columns?: string[], limit?: number}} op
 * @param {{withLimit?: boolean}} [options] withLimit 只对 query 有意义
 * @returns {Object} GraphJin 的操作配置
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

/**
 * 将权限矩阵转换为可直接交给 update_current_config 的 roles 补丁。
 *
 * @param {string} database 目标库名。缺失会让规则挂到内部库 __gj_internal_artifacts 上
 * @param {Object} matrix { roleName: { tableName: { query, insert, update, delete } } }
 * @returns {{roles: Array<Object>}} roles 补丁
 */
function buildRoleTableConfig(database, matrix) {
  if (!database) throw new Error('database 不能为空：缺失会让规则落到 __gj_internal_artifacts');

  const roles = [];
  for (const [role, tables] of Object.entries(matrix ?? {})) {
    const roleTables = [];

    for (const [table, ops] of Object.entries(tables ?? {})) {
      roleTables.push({
        name: table,
        database,
        query: buildOperation(ops.query, { withLimit: true }),
        insert: buildOperation(ops.insert),
        update: buildOperation(ops.update),
        delete: buildOperation(ops.delete),
      });
    }

    roles.push({ name: role, tables: roleTables });
  }

  return { roles };
}

/**
 * 把多条 roles 补丁合并成一份以角色为键的矩阵视图，用于展示变更 diff。
 *
 * @param {{roles: Array<Object>}} patch buildRoleTableConfig 的输出
 * @returns {Object} { roleName: { tableName: { query, insert, update, delete } } }
 */
function summarizePatch(patch) {
  const summary = {};
  for (const role of patch.roles ?? []) {
    const tables = {};
    for (const table of role.tables ?? []) {
      tables[table.name] = {
        query: table.query?.block === true ? 'blocked' : 'allowed',
        insert: table.insert?.block === true ? 'blocked' : 'allowed',
        update: table.update?.block === true ? 'blocked' : 'allowed',
        delete: table.delete?.block === true ? 'blocked' : 'allowed',
      };
    }
    summary[role.name] = tables;
  }
  return summary;
}

/** source 模式支持的读档位（`blocked` 会让整个 source 不加载） */
const READ_MODES = ['public', 'authenticated', 'owner', 'account', 'blocked'];

/** source 模式支持的写/删档位；没有 `public`，公开写会被官方 recipe 拒绝 */
const WRITE_MODES = ['blocked', 'authenticated', 'owner', 'account'];

/**
 * 归一化访问档位：非法值回落到安全默认，避免把拼写错误写进配置。
 *
 * @param {string|undefined} value
 * @param {string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
function normalizeMode(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * 把多个行过滤条件合并成一个 source grants 的 filter 字符串。
 *
 * legacy 的 `filters` 是数组，source 的 `filter` 只接受一个表达式；
 * 多个条件用 `_and` 组合，语义与 legacy 的「全部满足」一致。
 *
 * @param {string[]} filters
 * @returns {string|undefined}
 */
function combineFilters(filters) {
  const list = (Array.isArray(filters) ? filters : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return `{ _and: [${list.join(', ')}] }`;
}

/**
 * 生成 source 模式的 `access` 配置。
 *
 * 决策 A 的映射：写/删只到 source 级；表级只剩「公开 / 仅 admin / 全局屏蔽」三档，
 * 角色之间靠列白名单与行过滤区分。`grants` 是加法而不是白名单 —— 未列出的表
 * 对已认证角色完全可读，所以「按角色屏蔽表」不会再由这里产出。
 *
 * @param {Object} [options]
 * @param {string} [options.read] public / authenticated / owner / account / blocked
 * @param {string} [options.write] blocked / authenticated / owner / account
 * @param {string} [options.del] 删除档位，取值同 write
 * @param {string} [options.ownerColumn] owner 模式使用的归属列
 * @param {string} [options.namespaceColumn] account 模式使用的租户列
 * @param {string[]} [options.adminTables] 仅 admin 可读的表
 * @param {string[]} [options.blockedTables] 所有人（含 admin）都不可读的表
 * @param {Object} [options.grants] { role: { table: { columns, filter } } }
 * @returns {Object} 可直接并入 `sources[].access` 的对象
 */
function buildSourceAccessConfig({
  read = 'authenticated',
  write = 'blocked',
  del = 'blocked',
  ownerColumn,
  namespaceColumn,
  adminTables = [],
  blockedTables = [],
  grants = {},
} = {}) {
  const access = {
    read: normalizeMode(read, READ_MODES, 'authenticated'),
    write: normalizeMode(write, WRITE_MODES, 'blocked'),
    delete: normalizeMode(del, WRITE_MODES, 'blocked'),
  };

  // owner 档位没有归属列会退化成「谁能看所有行」，属于静默故障，直接拒绝
  const needsOwner = ['read', 'write', 'delete'].filter((key) => access[key] === 'owner');
  if (needsOwner.length > 0 && !ownerColumn) {
    throw new Error(`access.${needsOwner[0]} = owner 需要 ownerColumn`);
  }
  if (ownerColumn) access.owner_column = ownerColumn;
  if (namespaceColumn) access.namespace_column = namespaceColumn;

  const blocked = [...new Set(blockedTables)];
  const admin = [...new Set(adminTables)];
  const overlap = blocked.filter((table) => admin.includes(table));
  if (overlap.length > 0) {
    throw new Error(`表 ${overlap.join(', ')} 不能同时是 admin_tables 与 blocked_tables`);
  }
  if (blocked.length > 0) access.blocked_tables = blocked;
  if (admin.length > 0) access.admin_tables = admin;

  const grantList = [];
  for (const [role, tables] of Object.entries(grants ?? {})) {
    const entries = [];
    for (const [name, rule] of Object.entries(tables ?? {})) {
      const columns = Array.isArray(rule?.columns) ? rule.columns.filter(Boolean) : [];
      // GraphJin 会以「columns is required」拒绝空数组，缺列清单不能靠空数组糊过去
      if (columns.length === 0) {
        throw new Error(`grants.${role}.${name} 缺少 columns：source 模式要求显式列白名单`);
      }
      const entry = { name, columns };
      const filter = typeof rule?.filter === 'string' ? rule.filter.trim() : '';
      if (filter !== '') entry.filter = filter;
      entries.push(entry);
    }
    if (entries.length > 0) grantList.push({ role, tables: entries });
  }
  if (grantList.length > 0) access.grants = grantList;

  return access;
}

/**
 * 把 access 配置折算成 UI 可展示的摘要。
 *
 * @param {Object} access buildSourceAccessConfig 的返回值（或从运行实例读回的配置）
 * @returns {Object} 含各档位、表分类与角色级 grants
 */
function summarizeSourceAccess(access = {}) {
  const grants = {};
  for (const grant of access.grants ?? []) {
    const tables = {};
    for (const table of grant.tables ?? []) {
      tables[table.name] = {
        columns: Array.isArray(table.columns) ? table.columns : [],
        filter: typeof table.filter === 'string' && table.filter !== '' ? table.filter : null,
      };
    }
    if (grant.role) grants[grant.role] = tables;
  }

  return {
    read: access.read ?? null,
    write: access.write ?? null,
    delete: access.delete ?? null,
    ownerColumn: access.owner_column ?? null,
    namespaceColumn: access.namespace_column ?? null,
    adminTables: Array.isArray(access.admin_tables) ? access.admin_tables : [],
    blockedTables: Array.isArray(access.blocked_tables) ? access.blocked_tables : [],
    grants,
  };
}

/**
 * 把 legacy 的 `roles[].tables` 迁移成 source 模式的 access。
 *
 * 迁移按「不放大权限」原则：
 * - 写/删一律 blocked（legacy 的表级写开关无法表达，迁移后在 UI 里重新开启）；
 * - 只有 query 未 block 的角色/表才生成 grants；
 * - 缺少列清单的表不生成 grants（否则会退化成「全列可读」），并记为冲突；
 * - 所有非 admin 角色都屏蔽的表归入 admin_tables，混合情况记为冲突。
 *
 * @param {Object} options
 * @param {Array<Object>} options.roles legacy 的 roles 数组
 * @param {Object} options.columnsByTable { tableName: string[] } 列表清单
 * @param {string[]} [options.adminRoles] 拥有 admin 身份的角色名
 * @param {string} [options.ownerColumn] 留空时用 legacy 的 `$user_code` 约定
 * @returns {{access: Object, conflicts: Array<Object>}} access 与无法表达或需要人工确认的规则
 */
function migrateLegacyRoleTables({ roles = [], columnsByTable = {}, adminRoles = ['admin'], ownerColumn } = {}) {
  const conflicts = [];
  const grants = {};
  const blockedByNonAdmin = new Map();

  for (const role of roles ?? []) {
    const roleName = role?.name;
    if (!roleName) continue;
    const isAdmin = adminRoles.includes(roleName);

    for (const table of role.tables ?? []) {
      const tableName = table?.name;
      if (!tableName) continue;

      const query = table.query ?? {};
      const allowed = query.block !== true;
      const columnList = Array.isArray(query.columns) ? query.columns.filter(Boolean) : [];

      if (!allowed) {
        if (!isAdmin) {
          const entry = blockedByNonAdmin.get(tableName) ?? { blocked: 0, allowed: 0 };
          entry.blocked += 1;
          blockedByNonAdmin.set(tableName, entry);
        }
        conflicts.push({
          role: roleName,
          table: tableName,
          reason: 'per-role-block',
          detail: 'source 模式无法按角色屏蔽表；已按其他角色的规则处理',
        });
        continue;
      }

      if (!isAdmin) {
        const entry = blockedByNonAdmin.get(tableName) ?? { blocked: 0, allowed: 0 };
        entry.allowed += 1;
        blockedByNonAdmin.set(tableName, entry);
      }

      const columns = columnList.length > 0 ? columnList : (columnsByTable[tableName] ?? []).filter(Boolean);
      if (columns.length === 0) {
        conflicts.push({
          role: roleName,
          table: tableName,
          reason: 'missing-columns',
          detail: '缺少列清单，无法生成 grants（空数组会被 GraphJin 拒绝）',
        });
        continue;
      }

      const rule = { columns };
      const filter = combineFilters(query.filters);
      if (filter) rule.filter = filter;

      if (!isAdmin) {
        grants[roleName] ??= {};
        grants[roleName][tableName] = rule;
      }

      for (const [op, label] of [['insert', 'insert'], ['update', 'update'], ['delete', 'delete']]) {
        if (table[op] && table[op].block !== true) {
          conflicts.push({
            role: roleName,
            table: tableName,
            reason: `${label}-rule-dropped`,
            detail: '表级写开关无法表达，迁移后写/删为 source 级且默认 blocked',
          });
        }
      }
    }
  }

  // 只有当一个表被所有提及它的非 admin 角色都屏蔽时，才等价于「仅 admin 可读」
  const adminTables = [];
  for (const [tableName, entry] of blockedByNonAdmin) {
    if (entry.blocked > 0 && entry.allowed === 0) adminTables.push(tableName);
  }

  const access = buildSourceAccessConfig({
    read: 'authenticated',
    write: 'blocked',
    del: 'blocked',
    ownerColumn,
    adminTables,
    grants,
  });

  return { access, conflicts };
}

/**
 * 把列清单统一成 { name, type, notNull, primaryKey }：调用方有的只给列名。
 *
 * @param {Array<string|Object>} columns
 * @returns {Array<Object>}
 */
function normalizeColumnMeta(columns) {
  return (Array.isArray(columns) ? columns : [])
    .map((column) => (typeof column === 'string' ? { name: column } : column))
    .filter((column) => column && column.name);
}

/** 挑拒绝规则用的锚点列：主键优先，其次 id，最后首列 @param {Array} columns */
function pickAnchorColumn(columns) {
  const meta = normalizeColumnMeta(columns);
  return meta.find((column) => column.primaryKey === true) ?? meta.find((column) => column.name === 'id') ?? meta[0] ?? null;
}

const NUMERIC_TYPE = /int|numeric|decimal|real|double|float|serial|money|number/i;

/**
 * 「本库没你的份」用的 filter。
 *
 * 实测（2026-10-24，scripts/verify-source-acl.js + verify:ui）：
 * - `{ 列: { _in: [] } }` 查询时是 0 行，但**写进配置时被拒**：
 *   `add roles failed: role filter { id: { _in: [] } }: empty object or list for '_in'`。
 *   启动路径与写入路径的校验不一致，所以它不能用作编译产物。
 * - `{ 列: { _eq: 哨兵 } }` 两条路径都接受，且查询返回 0 行。
 *
 * 因此：非空列用 `_is_null: true`（与类型无关，必然 0 行），否则按列类型挑哨兵值。
 * 兜底还有应用后的真实自检（`permissions.apply` 里的 boundaryCheck）——猜错会被抓出来，
 * 而不是静默放行。
 *
 * @param {string|Object} anchor 列名或列元数据
 * @returns {string}
 */
function denyFilterFor(anchor) {
  const column = typeof anchor === 'string' ? { name: anchor } : anchor ?? {};
  if (!column.name) throw new Error('denyFilterFor 需要列名');
  if (column.notNull === true) return `{ ${column.name}: { _is_null: true } }`;
  const sentinel = NUMERIC_TYPE.test(String(column.type ?? '')) ? '-1' : '"__not_granted__"';
  return `{ ${column.name}: { _eq: ${sentinel} } }`;
}

/**
 * 应用「角色 → 库」边界：不在允许清单里的角色，在本库一行都看不到。
 *
 * 为什么必须显式写 deny grant：source 模式下 `read: authenticated` 对所有已认证角色
 * 生效，没被 grants 点名的角色不受任何限制（实测：外来角色能读全表）。所以「看不
 * 到这个库」不能靠「不写 grant」表达，只能给该角色写一份恒不成立的 filter。
 *
 * @param {Object} options
 * @param {Object} options.access buildSourceAccessConfig 的输出
 * @param {string[]|null} options.allowedRoles 允许访问本库的角色；null 表示未配置（不限制）
 * @param {string[]} options.roles 全部已知角色（含 admin）
 * @param {string[]} options.tables 本库的表名
 * @param {Object} [options.columnsByTable] { 表名: [列名] }，用来挑锚点列
 * @returns {{ access: Object, deniedRoles: string[], conflicts: Array<Object> }}
 */
function applyDatabaseBoundary({
  access,
  allowedRoles,
  roles = [],
  tables = [],
  columnsByTable = {},
} = {}) {
  if (allowedRoles === null || allowedRoles === undefined) {
    // 未配置就维持现状：老项目不会被静默收紧
    return { access: access ?? {}, deniedRoles: [], conflicts: [] };
  }

  const allowed = new Set(allowedRoles.map(String));
  const all = [...new Set([...(roles ?? []).map(String), ...allowed])];
  const deniedRoles = all.filter((role) => role !== 'admin' && !allowed.has(role));
  if (deniedRoles.length === 0) return { access: access ?? {}, deniedRoles, conflicts: [] };

  const conflicts = [];
  const deniedSet = new Set(deniedRoles);
  // 先摘掉被拒角色原有的 grant：它可能来自矩阵或上一次的编译，留着就会盖掉 deny
  const keptGrants = (access?.grants ?? [])
    .filter((grant) => !deniedSet.has(grant?.role))
    .map((grant) => ({ role: grant.role, tables: grant.tables ?? [] }));

  for (const role of deniedRoles) {
    const entries = [];
    for (const table of tables) {
      const anchor = pickAnchorColumn(columnsByTable[table]);
      if (!anchor) {
        conflicts.push({
          role,
          table,
          reason: 'no-anchor-column',
          detail: '拿不到列清单，无法生成拒绝规则；请先刷新 schema 再应用',
        });
        continue;
      }
      entries.push({ name: table, columns: [anchor.name], filter: denyFilterFor(anchor) });
    }
    if (entries.length > 0) keptGrants.push({ role, tables: entries });
  }

  return {
    access: { ...access, grants: keptGrants },
    deniedRoles,
    conflicts,
  };
}

module.exports = {
  buildOperation,
  buildRoleTableConfig,
  summarizePatch,
  buildSourceAccessConfig,
  summarizeSourceAccess,
  migrateLegacyRoleTables,
  combineFilters,
  applyDatabaseBoundary,
  denyFilterFor,
  pickAnchorColumn,
};
