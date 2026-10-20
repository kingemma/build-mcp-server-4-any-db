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
