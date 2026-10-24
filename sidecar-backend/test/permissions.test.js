'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
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
} = require('../src/permissions');

test('buildOperation: 未配置或显式关闭时返回 block', () => {
  assert.deepStrictEqual(buildOperation(undefined), { block: true });
  assert.deepStrictEqual(buildOperation({ enabled: false }), { block: true });
});

test('buildOperation: 开启时带上 filters 与 columns', () => {
  const op = {
    enabled: true,
    filters: ['{ org_id: { _eq: $user.org_id } }'],
    columns: ['id', 'name'],
  };
  assert.deepStrictEqual(buildOperation(op), {
    block: false,
    filters: ['{ org_id: { _eq: $user.org_id } }'],
    columns: ['id', 'name'],
  });
});

test('buildOperation: 空数组不写入，避免产出无意义字段', () => {
  assert.deepStrictEqual(buildOperation({ enabled: true, filters: [], columns: [] }), {
    block: false,
  });
});

test('buildOperation: limit 只在 withLimit 为真时写入', () => {
  assert.deepStrictEqual(buildOperation({ enabled: true, limit: 10 }), { block: false });
  assert.deepStrictEqual(buildOperation({ enabled: true, limit: 10 }, { withLimit: true }), {
    block: false,
    limit: 10,
  });
});

test('buildRoleTableConfig: 缺少 database 时抛错', () => {
  assert.throws(() => buildRoleTableConfig('', { r: { t: {} } }), /database 不能为空/);
});

test('buildRoleTableConfig: 每个表都带 database 与四项操作', () => {
  const patch = buildRoleTableConfig('app', {
    analyst: {
      accounts: {
        query: { enabled: true, limit: 10 },
        insert: { enabled: false },
        update: { enabled: false },
        delete: { enabled: false },
      },
    },
  });

  assert.strictEqual(patch.roles.length, 1);
  const table = patch.roles[0].tables[0];
  assert.strictEqual(table.name, 'accounts');
  // 缺失会挂到内部库 __gj_internal_artifacts
  assert.strictEqual(table.database, 'app');
  assert.deepStrictEqual(table.query, { block: false, limit: 10 });
  assert.deepStrictEqual(table.insert, { block: true });
  assert.deepStrictEqual(table.update, { block: true });
  assert.deepStrictEqual(table.delete, { block: true });
});

test('summarizePatch: 把 block 标记翻译成可读状态', () => {
  const patch = buildRoleTableConfig('app', {
    reviewer: {
      orders: {
        query: { enabled: true },
        insert: { enabled: true },
        update: { enabled: false },
        delete: { enabled: false },
      },
    },
  });

  assert.deepStrictEqual(summarizePatch(patch), {
    reviewer: {
      orders: { query: 'allowed', insert: 'allowed', update: 'blocked', delete: 'blocked' },
    },
  });
});

test('combineFilters: 空/单条/多条分别处理', () => {
  assert.strictEqual(combineFilters([]), undefined);
  assert.strictEqual(combineFilters(['  ']), undefined);
  assert.strictEqual(combineFilters(['{ a: 1 }']), '{ a: 1 }');
  assert.strictEqual(
    combineFilters(['{ a: 1 }', '{ b: 2 }']),
    '{ _and: [{ a: 1 }, { b: 2 }] }'
  );
});

test('buildSourceAccessConfig: 默认写/删 blocked，避免迁移放大权限', () => {
  const access = buildSourceAccessConfig();
  assert.deepStrictEqual(access, { read: 'authenticated', write: 'blocked', delete: 'blocked' });
});

test('buildSourceAccessConfig: 非法档位回落到安全默认', () => {
  const access = buildSourceAccessConfig({ read: 'publick', write: 'public', del: 'yes' });
  assert.strictEqual(access.read, 'authenticated');
  assert.strictEqual(access.write, 'blocked');
  assert.strictEqual(access.delete, 'blocked');
});

test('buildSourceAccessConfig: grants 缺列清单时直接报错', () => {
  assert.throws(
    () => buildSourceAccessConfig({ grants: { analyst: { orders: { columns: [] } } } }),
    /缺少 columns/
  );
});

test('buildSourceAccessConfig: 输出 grants / 表分类 / owner 列', () => {
  const access = buildSourceAccessConfig({
    read: 'authenticated',
    write: 'owner',
    del: 'owner',
    ownerColumn: 'owner_code',
    adminTables: ['audit_logs', 'audit_logs'],
    blockedTables: ['internal_events'],
    grants: {
      analyst: { orders: { columns: ['id', 'total'], filter: '{ owner_code: { _eq: $user_code } }' } },
    },
  });

  assert.deepStrictEqual(access, {
    read: 'authenticated',
    write: 'owner',
    delete: 'owner',
    owner_column: 'owner_code',
    blocked_tables: ['internal_events'],
    admin_tables: ['audit_logs'],
    grants: [
      {
        role: 'analyst',
        tables: [{ name: 'orders', columns: ['id', 'total'], filter: '{ owner_code: { _eq: $user_code } }' }],
      },
    ],
  });
});

test('summarizeSourceAccess: 把 access 折回可展示结构', () => {
  const summary = summarizeSourceAccess(
    buildSourceAccessConfig({
      ownerColumn: 'owner_code',
      adminTables: ['audit_logs'],
      grants: { analyst: { orders: { columns: ['id'] } } },
    })
  );

  assert.deepStrictEqual(summary, {
    read: 'authenticated',
    write: 'blocked',
    delete: 'blocked',
    ownerColumn: 'owner_code',
    namespaceColumn: null,
    adminTables: ['audit_logs'],
    blockedTables: [],
    grants: { analyst: { orders: { columns: ['id'], filter: null } } },
  });
});

test('migrateLegacyRoleTables: 只迁移未 block 的读规则，写规则降级', () => {
  const { access, conflicts } = migrateLegacyRoleTables({
    roles: [
      {
        name: 'analyst',
        tables: [
          {
            name: 'orders',
            database: 'app',
            query: { block: false, filters: ['{ owner_code: { _eq: $user_code } }'] },
            insert: { block: false },
            update: { block: true },
            delete: { block: true },
          },
        ],
      },
    ],
    columnsByTable: { orders: ['id', 'owner_code', 'total'] },
  });

  assert.strictEqual(access.write, 'blocked');
  assert.strictEqual(access.delete, 'blocked');
  assert.deepStrictEqual(access.grants, [
    {
      role: 'analyst',
      tables: [
        {
          name: 'orders',
          columns: ['id', 'owner_code', 'total'],
          filter: '{ owner_code: { _eq: $user_code } }',
        },
      ],
    },
  ]);
  assert.deepStrictEqual(
    conflicts.map((item) => item.reason),
    ['insert-rule-dropped']
  );
});

test('migrateLegacyRoleTables: 按角色屏蔽表记为冲突，不同步进 grants', () => {
  const { access, conflicts } = migrateLegacyRoleTables({
    roles: [
      { name: 'analyst', tables: [{ name: 'secrets', query: { block: true } }] },
      { name: 'viewer', tables: [{ name: 'secrets', query: { block: false } }] },
    ],
    columnsByTable: { secrets: ['id'] },
  });

  assert.deepStrictEqual(access.grants, [{ role: 'viewer', tables: [{ name: 'secrets', columns: ['id'] }] }]);
  assert.deepStrictEqual(
    conflicts.map((item) => `${item.role}:${item.reason}`),
    ['analyst:per-role-block']
  );
});

test('migrateLegacyRoleTables: 所有非 admin 角色都屏蔽的表归入 admin_tables', () => {
  const { access } = migrateLegacyRoleTables({
    roles: [
      { name: 'analyst', tables: [{ name: 'audit_logs', query: { block: true } }] },
      { name: 'viewer', tables: [{ name: 'audit_logs', query: { block: true } }] },
    ],
    columnsByTable: {},
  });

  assert.deepStrictEqual(access.admin_tables, ['audit_logs']);
  assert.strictEqual(access.grants, undefined);
});

test('migrateLegacyRoleTables: 缺列清单时不生成 grants 并记冲突', () => {
  const { access, conflicts } = migrateLegacyRoleTables({
    roles: [{ name: 'analyst', tables: [{ name: 'orders', query: { block: false } }] }],
    columnsByTable: {},
  });

  assert.strictEqual(access.grants, undefined);
  assert.deepStrictEqual(
    conflicts.map((item) => item.reason),
    ['missing-columns']
  );
});

test('buildSourceAccessConfig: owner 档位缺少 ownerColumn 时拒绝写入', () => {
  assert.throws(
    () => buildSourceAccessConfig({ read: 'owner' }),
    /owner 需要 ownerColumn/
  );
  assert.throws(
    () => buildSourceAccessConfig({ write: 'owner' }),
    /owner 需要 ownerColumn/
  );
});

test('buildSourceAccessConfig: 同一张表不能既 admin_tables 又 blocked_tables', () => {
  assert.throws(
    () => buildSourceAccessConfig({ adminTables: ['orders'], blockedTables: ['orders'] }),
    /不能同时是 admin_tables 与 blocked_tables/
  );
});

/* ------------------------------------------- 角色 → 库边界 */

test('applyDatabaseBoundary: 未配置（null）时原样返回，不静默收紧', () => {
  const access = buildSourceAccessConfig({
    grants: { analyst: { accounts: { columns: ['id'] } } },
  });
  const result = applyDatabaseBoundary({
    access,
    allowedRoles: null,
    roles: ['admin', 'analyst'],
    tables: ['accounts'],
    columnsByTable: { accounts: ['id'] },
  });
  assert.deepStrictEqual(result.access, access);
  assert.deepStrictEqual(result.deniedRoles, []);
});

test('applyDatabaseBoundary: 不在清单里的角色拿到恒不成立的 filter', () => {
  const access = buildSourceAccessConfig({
    grants: { inventory_viewer: { vouchers: { columns: ['id', 'amount'] } } },
  });
  const result = applyDatabaseBoundary({
    access,
    allowedRoles: ['finance_analyst'],
    roles: ['admin', 'finance_analyst', 'inventory_viewer'],
    tables: ['vouchers', 'invoices'],
    columnsByTable: { vouchers: ['id', 'amount'], invoices: ['id', 'no'] },
  });

  assert.deepStrictEqual(result.deniedRoles, ['inventory_viewer']);
  // 原有的 grant 必须被摘掉，否则会盖掉拒绝
  assert.strictEqual(
    result.access.grants.some((grant) => grant.role === 'inventory_viewer' && grant.tables.some((t) => t.filter === undefined)),
    false
  );
  const denied = result.access.grants.find((grant) => grant.role === 'inventory_viewer');
  assert.deepStrictEqual(
    denied.tables.map((table) => table.name),
    ['vouchers', 'invoices']
  );
  for (const table of denied.tables) {
    assert.strictEqual(table.filter, denyFilterFor('id'));
    assert.deepStrictEqual(table.columns, ['id']);
  }
});

test('applyDatabaseBoundary: admin 永远不被拒绝，且不做无谓改写', () => {
  const access = buildSourceAccessConfig({
    grants: { finance_analyst: { vouchers: { columns: ['id'] } } },
  });
  const result = applyDatabaseBoundary({
    access,
    allowedRoles: ['finance_analyst'],
    roles: ['admin', 'finance_analyst'],
    tables: ['vouchers'],
    columnsByTable: { vouchers: ['id'] },
  });
  assert.deepStrictEqual(result.deniedRoles, []);
  assert.strictEqual(result.access.grants.length, 1);
});

test('applyDatabaseBoundary: 没有 id 时退回首列；没有列清单时报冲突而不是写坏配置', () => {
  const access = buildSourceAccessConfig({});
  const result = applyDatabaseBoundary({
    access,
    allowedRoles: [],
    roles: ['admin', 'viewer'],
    tables: ['logs', 'unknown'],
    columnsByTable: { logs: ['ts', 'message'] },
  });

  const denied = result.access.grants.find((grant) => grant.role === 'viewer');
  assert.deepStrictEqual(denied.tables, [
    { name: 'logs', columns: ['ts'], filter: denyFilterFor('ts') },
  ]);
  assert.deepStrictEqual(
    result.conflicts.map((item) => `${item.table}:${item.reason}`),
    ['unknown:no-anchor-column']
  );
});

test('applyDatabaseBoundary: 允许清单里的角色不受影响，其余角色逐个生成拒绝', () => {
  const access = buildSourceAccessConfig({
    grants: {
      finance_analyst: { vouchers: { columns: ['id'], filter: '{ owner_code: { _eq: $user_code } }' } },
    },
  });
  const result = applyDatabaseBoundary({
    access,
    allowedRoles: ['finance_analyst'],
    roles: ['admin', 'finance_analyst', 'inventory_viewer', 'auditor'],
    tables: ['vouchers'],
    columnsByTable: { vouchers: ['id', 'owner_code'] },
  });

  assert.deepStrictEqual(result.deniedRoles.sort(), ['auditor', 'inventory_viewer']);
  const finance = result.access.grants.find((grant) => grant.role === 'finance_analyst');
  assert.strictEqual(finance.tables[0].filter, '{ owner_code: { _eq: $user_code } }');
  for (const role of ['auditor', 'inventory_viewer']) {
    const grant = result.access.grants.find((item) => item.role === role);
    assert.strictEqual(grant.tables[0].filter, denyFilterFor('id'));
  }
});

test('denyFilterFor: 非空列用 _is_null，可空列按类型挑哨兵', () => {
  // 非空列：_is_null 必然 0 行，且与列类型无关
  assert.strictEqual(
    denyFilterFor({ name: 'id', type: 'INTEGER', notNull: true, primaryKey: true }),
    '{ id: { _is_null: true } }'
  );
  // 可空数值列：用 -1（字符串哨兵在数值列上虽然也是 0 行，但那是类型不匹配，不稳）
  assert.strictEqual(denyFilterFor({ name: 'amount', type: 'numeric', notNull: false }), '{ amount: { _eq: -1 } }');
  // 可空文本列
  assert.strictEqual(
    denyFilterFor({ name: 'memo', type: 'text', notNull: false }),
    '{ memo: { _eq: "__not_granted__" } }'
  );
});

test('pickAnchorColumn: 主键优先，其次 id，最后首列', () => {
  assert.strictEqual(
    pickAnchorColumn([
      { name: 'code', type: 'text' },
      { name: 'voucher_id', type: 'int', primaryKey: true },
    ]).name,
    'voucher_id'
  );
  assert.strictEqual(pickAnchorColumn([{ name: 'sku' }, { name: 'id' }]).name, 'id');
  assert.strictEqual(pickAnchorColumn([{ name: 'ts' }]).name, 'ts');
  assert.strictEqual(pickAnchorColumn([]), null);
});
