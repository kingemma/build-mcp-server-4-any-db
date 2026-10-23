'use strict';

/**
 * 把「强制规则」编译成**权限配置的补丁**。
 *
 * 这一步是 D5 的兑现点：在此之前 `severity: enforce` 只是一行文字，模型读到约束照样能违反。
 * 编译之后，规则变成 `sources[].access` 里真实生效的过滤、列清单与屏蔽表。
 *
 * 三条设计原则：
 *
 * 1. **只产出补丁，不写配置。** 编译结果是给人看的 diff；写不写、什么时候写由人决定，
 *    并且复用 `permissions.apply`（它写入前自动存快照）。规则引擎不该有直接改权限的权力。
 * 2. **从现状出发，不从默认值出发。** 补丁必须在当前 access 之上叠加，否则一次「应用规则」
 *    会把用户手工配的 public / owner / 行过滤全部冲掉。
 * 3. **做不到就说做不到。** 写不变量、状态机这类规则没有对应的 GraphJin 能力，编译时明确
 *    报成 conflict，而不是假装编出来一个东西。
 */

const { combineFilters } = require('./permissions');
const { RULE_MODES } = require('./ontology-payload');

/** 可编译的规则形态。写不变量与状态机刻意不在其中——它们没有对应的 GraphJin 能力 */

/**
 * admin 不受强制规则约束。
 *
 * 不是疏忽：管理员本来就要能在规则挡住所有人时把数据修回来。把 admin 也纳入过滤，
 * 一次配错就再也没人改得回来。
 */
const EXEMPT_ROLES = new Set(['admin']);

/**
 * 权限写入路径不认识、因此**写回时会丢掉**的字段。
 *
 * `buildSourceAccessConfig` 只产出它建模过的那几个键；dev.yml 里手写的
 * `public_tables` / `missing_namespace_column` 不在其中。这是既有权限页的行为
 * （不是本次引入的），但既然规则补丁也走这条路，就必须在编译期告诉用户
 * 「应用之后这两项会消失」，而不是让人第二天发现表突然公开了。
 */
const UNPRESERVED_ACCESS_KEYS = [
  'public_tables',
  'publicTables',
  'missing_namespace_column',
  'missingNamespaceColumn',
];

/** 表引用统一取裸表名：权限配置里的 grants / blocked_tables 都按裸表名写 */
function tableNameOf(ref) {
  return String(ref ?? '').trim().split('.').pop();
}

/** @returns {{columns: string[], filter?: string}} */
function normalizeGrant(rule) {
  const columns = Array.isArray(rule?.columns) ? rule.columns.filter(Boolean) : [];
  const filter = typeof rule?.filter === 'string' && rule.filter.trim() !== '' ? rule.filter.trim() : undefined;
  return { columns, ...(filter ? { filter } : {}) };
}

/**
 * 把 access 归一成编译内部用的形状。
 *
 * 输入可能来自两处：运行中实例的 `readConfig('sources')`（grants 是数组、字段是下划线），
 * 或离线读 dev.yml 的同一份结构。统一成 { role: { table: {columns, filter} } } 之后，
 * 后面的逻辑就只需要处理一种形状。
 *
 * @param {Object|null} raw
 * @returns {Object}
 */
function normalizeAccess(raw) {
  const access = raw ?? {};
  const grants = {};
  const source = access.grants;
  if (Array.isArray(source)) {
    for (const grant of source) {
      if (!grant?.role) continue;
      grants[grant.role] ??= {};
      for (const table of grant.tables ?? []) {
        if (!table?.name) continue;
        grants[grant.role][table.name] = normalizeGrant(table);
      }
    }
  } else if (source && typeof source === 'object') {
    for (const [role, tables] of Object.entries(source)) {
      grants[role] ??= {};
      for (const [name, rule] of Object.entries(tables ?? {})) {
        grants[role][name] = normalizeGrant(rule);
      }
    }
  }

  return {
    read: access.read ?? 'authenticated',
    write: access.write ?? 'blocked',
    delete: access.delete ?? access.del ?? 'blocked',
    ownerColumn: access.ownerColumn ?? access.owner_column ?? null,
    namespaceColumn: access.namespaceColumn ?? access.namespace_column ?? null,
    adminTables: Array.isArray(access.adminTables)
      ? [...access.adminTables]
      : Array.isArray(access.admin_tables)
        ? [...access.admin_tables]
        : [],
    blockedTables: Array.isArray(access.blockedTables)
      ? [...access.blockedTables]
      : Array.isArray(access.blocked_tables)
        ? [...access.blocked_tables]
        : [],
    grants,
  };
}

function cloneAccess(access) {
  const grants = {};
  for (const [role, tables] of Object.entries(access.grants)) {
    grants[role] = {};
    for (const [name, rule] of Object.entries(tables)) {
      grants[role][name] = { ...rule, columns: [...rule.columns] };
    }
  }
  return { ...access, grants };
}

/**
 * 这条规则能不能编译，缺什么。
 *
 * @param {Object} payload
 * @returns {{mode: string, table: string, tableName: string, column: string, predicate: string}|string}
 *   可编译时返回归一后的参数，否则返回缺失说明
 */
function ruleShape(payload) {
  const mode = payload?.mode;
  if (!RULE_MODES.includes(mode)) return '没有选择可执行的形态';

  const tableName = tableNameOf(payload?.on?.table);
  const column = typeof payload?.on?.column === 'string' ? payload.on.column.trim() : '';
  const predicate = typeof payload?.predicate === 'string' ? payload.predicate.trim() : '';

  if (mode === 'read-only') return { mode, table: '', tableName: '', column: '', predicate: '' };
  if (tableName === '') return '没有指定作用表';
  if (mode === 'filter') {
    if (predicate === '') return '读筛选没有判定条件';
    // 判据会被原样写进 grants[].filter，必须本身就是 GraphJin 过滤表达式。
    // 允许写成 SQL 风格（`voided_at is null`）的后果是：编译通过、应用通过、查询时才炸。
    if (!predicate.startsWith('{') || !predicate.endsWith('}')) {
      return '读筛选的判定条件必须是 GraphJin 过滤表达式（形如 { status: { _eq: "active" } }）';
    }
  }
  if (mode === 'hide-column' && column === '') return '隐藏列没有指定列';
  return { mode, table: payload.on.table, tableName, column, predicate };
}

/**
 * 编译强制规则。
 *
 * @param {Object} options
 * @param {Array<Object>} [options.rules] 本体论条目（只取 kind=rule 且 severity=enforce）
 * @param {string} [options.database] 目标库；给了就只编译该库的规则
 * @param {Object} [options.access] 当前 access（数组或 map 两种形态都收）
 * @param {string[]} [options.roles] 已知角色名；用来报告「哪些角色不受这条规则约束」
 * @returns {Object} { database, base, access, changes, conflicts, summary }
 */
function compileRules({ rules = [], database = '', access = null, roles = [] } = {}) {
  const base = normalizeAccess(access);
  const working = cloneAccess(base);
  const changes = [];
  const conflicts = [];
  const knownRoles = Array.isArray(roles) ? roles.filter((role) => typeof role === 'string' && role) : [];

  const scoped = (Array.isArray(rules) ? rules : []).filter(
    (entry) =>
      entry?.kind === 'rule' &&
      entry?.severity === 'enforce' &&
      (!database || entry?.database === database)
  );

  let compiled = 0;
  let skipped = 0;

  // 先把「应用之后会丢的东西」说清楚：这类提示不该等到出事才被想起
  for (const key of UNPRESERVED_ACCESS_KEYS) {
    const value = access?.[key];
    const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
    if (present) {
      conflicts.push({
        ruleId: null,
        ruleName: '现状配置',
        reason: `当前 access 里的 ${key} 不会被写回（权限写入路径不支持它），应用补丁后这一项会丢失`,
      });
    }
  }

  for (const rule of scoped) {
    const shape = ruleShape(rule.payload);
    if (typeof shape === 'string') {
      // 形态不完整：这条规则没有被编译。lint 的 enforce 检查会同时报它，
      // 两处都报是故意的——编译面板与体检面板是两条独立的确认路径
      conflicts.push({ ruleId: rule.id, ruleName: rule.name, reason: `无法编译：${shape}` });
      skipped += 1;
      continue;
    }
    compiled += 1;

    if (shape.mode === 'read-only') {
      const already = working.write === 'blocked' && working.delete === 'blocked';
      working.write = 'blocked';
      working.delete = 'blocked';
      changes.push({
        ruleId: rule.id,
        ruleName: rule.name,
        action: already ? 'read-only-already' : 'read-only',
        detail: already ? '写与删已经是屏蔽状态' : '把写与删设为 blocked',
      });
      continue;
    }

    // 后面的三种形态都针对一张具体的表
    const name = shape.tableName;

    if (shape.mode === 'block-table') {
      if (working.blockedTables.includes(name)) {
        changes.push({
          ruleId: rule.id,
          ruleName: rule.name,
          action: 'block-table-already',
          detail: `${name} 已在全局屏蔽列表里`,
        });
        continue;
      }
      const wasAdminOnly = working.adminTables.includes(name);
      if (wasAdminOnly) {
        working.adminTables = working.adminTables.filter((item) => item !== name);
      }
      working.blockedTables.push(name);
      changes.push({
        ruleId: rule.id,
        ruleName: rule.name,
        action: 'block-table',
        detail: wasAdminOnly
          ? `${name} 从「仅管理员可读」改为「全局屏蔽」（含 admin）`
          : `${name} 加入全局屏蔽（含 admin）`,
      });
      continue;
    }

    // filter / hide-column 只能落在「有 grant 的角色」上：
    // source 模式下没列出的表对已认证角色是全开的，没有 grant 就没有地方挂限制
    const rolesWithGrant = Object.keys(working.grants).filter(
      (role) => working.grants[role]?.[name]
    );

    if (rolesWithGrant.length === 0) {
      conflicts.push({
        ruleId: rule.id,
        ruleName: rule.name,
        reason: `没有任何角色的读规则覆盖 ${name}：没有 grant 就没有地方挂这条限制`,
      });
      continue;
    }

    if (knownRoles.length > 0) {
      const uncovered = knownRoles.filter(
        (role) => !EXEMPT_ROLES.has(role) && !rolesWithGrant.includes(role)
      );
      if (uncovered.length > 0) {
        conflicts.push({
          ruleId: rule.id,
          ruleName: rule.name,
          reason: `${uncovered.join('、')} 对 ${name} 没有 grant，这条规则不会约束它们`,
        });
      }
    }

    for (const role of rolesWithGrant) {
      const grant = working.grants[role][name];

      if (shape.mode === 'filter') {
        const existing = grant.filter ?? '';
        if (existing.includes(shape.predicate)) {
          changes.push({
            ruleId: rule.id,
            ruleName: rule.name,
            action: 'filter-already',
            role,
            detail: `${role} 的过滤条件里已有这条判定`,
          });
          continue;
        }
        grant.filter = existing === '' ? shape.predicate : combineFilters([existing, shape.predicate]);
        changes.push({
          ruleId: rule.id,
          ruleName: rule.name,
          action: existing === '' ? 'add-filter' : 'merge-filter',
          role,
          detail:
            existing === ''
              ? `给 ${role} 的 ${name} 加上过滤：${shape.predicate}`
              : `给 ${role} 的 ${name} 追加过滤：${shape.predicate}`,
        });
        continue;
      }

      // hide-column
      if (!grant.columns.includes(shape.column)) {
        changes.push({
          ruleId: rule.id,
          ruleName: rule.name,
          action: 'column-already-hidden',
          role,
          detail: `${role} 的 ${name} 本来就没有 ${shape.column}`,
        });
        continue;
      }
      if (grant.columns.length <= 1) {
        conflicts.push({
          ruleId: rule.id,
          ruleName: rule.name,
          reason: `${role} 的 ${name} 只剩这一列，移掉后列清单为空（GraphJin 不接受空清单）`,
        });
        continue;
      }
      grant.columns = grant.columns.filter((column) => column !== shape.column);
      changes.push({
        ruleId: rule.id,
        ruleName: rule.name,
        action: 'hide-column',
        role,
        detail: `从 ${role} 的 ${name} 列清单里移除 ${shape.column}`,
      });
    }
  }

  const effective = changes.filter(
    (change) => !String(change.action).endsWith('-already')
  ).length;

  return {
    database,
    base,
    access: working,
    changes,
    conflicts,
    summary: {
      rules: scoped.length,
      compiled,
      skipped,
      effectiveChanges: effective,
      conflicts: conflicts.length,
    },
  };
}

module.exports = {
  RULE_MODES,
  EXEMPT_ROLES,
  compileRules,
  normalizeAccess,
  ruleShape,
};
