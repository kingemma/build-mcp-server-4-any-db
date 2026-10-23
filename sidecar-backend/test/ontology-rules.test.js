'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileRules, normalizeAccess, ruleShape } = require('../src/ontology-rules');
const { buildSourceAccessConfig } = require('../src/permissions');

function access(overrides = {}) {
  return {
    read: 'authenticated',
    write: 'blocked',
    delete: 'blocked',
    ownerColumn: null,
    namespaceColumn: null,
    adminTables: [],
    blockedTables: [],
    grants: {
      analyst: {
        orders: {
          columns: ['id', 'amount', 'status'],
          filter: '{ owner_code: { _eq: $user_code } }',
        },
      },
      viewer: { orders: { columns: ['id', 'amount'] } },
    },
    ...overrides,
  };
}

function rule(overrides = {}) {
  return {
    id: 1,
    database: 'app',
    kind: 'rule',
    name: '只看未作废',
    aliases: [],
    definition: '',
    tables: [],
    expression: '',
    severity: 'enforce',
    payload: { mode: 'filter', on: { table: 'app.main.orders' }, predicate: '{ status: { _eq: "voided" } }' },
    facets: [],
    ...overrides,
  };
}

test('ruleShape：缺形态 / 缺目标 / 缺判据都给明确的缺失说明', () => {
  assert.equal(ruleShape({}), '没有选择可执行的形态');
  assert.equal(ruleShape({ mode: 'filter' }), '没有指定作用表');
  assert.equal(ruleShape({ mode: 'filter', on: { table: 'app.main.orders' } }), '读筛选没有判定条件');
  assert.equal(
    ruleShape({ mode: 'hide-column', on: { table: 'app.main.orders' } }),
    '隐藏列没有指定列'
  );
  // read-only 不需要表
  assert.equal(typeof ruleShape({ mode: 'read-only' }), 'object');
});

test('ruleShape：读筛选的判据必须是 GraphJin 过滤表达式，SQL 风格直接拒', () => {
  // 判据会被原样写进 grants[].filter：写成 SQL 的后果是编译通过、应用通过、查询时才炸
  assert.match(
    ruleShape({ mode: 'filter', on: { table: 'app.main.orders' }, predicate: 'status = "voided"' }),
    /GraphJin 过滤表达式/
  );
  assert.equal(
    typeof ruleShape({ mode: 'filter', on: { table: 'app.main.orders' }, predicate: '{ a: { _eq: 1 } }' }),
    'object'
  );
});

test('filter：给每个有 grant 的角色加上过滤，多个角色各自生效', () => {
  const report = compileRules({ rules: [rule()], database: 'app', access: access() });

  assert.equal(report.summary.compiled, 1);
  assert.equal(report.access.grants.analyst.orders.filter.includes('{ status: { _eq: "voided" } }'), true);
  assert.equal(report.access.grants.viewer.orders.filter, '{ status: { _eq: "voided" } }');
  // 两个角色各一条变更
  assert.equal(report.changes.filter((change) => change.action !== 'filter-already').length, 2);
});

test('filter：已有过滤用 _and 合并，重复的判定不重复追加', () => {
  const report = compileRules({ rules: [rule()], database: 'app', access: access() });
  const analystFilter = report.access.grants.analyst.orders.filter;
  // 原有条件必须还在：应用规则不能把手工配的行过滤冲掉
  assert.match(analystFilter, /_and/);
  assert.match(analystFilter, /owner_code/);

  const again = compileRules({ rules: [rule()], database: 'app', access: report.access });
  assert.equal(again.summary.effectiveChanges, 0);
  assert.ok(again.changes.every((change) => change.action === 'filter-already'));
});

test('filter：没有任何角色覆盖该表时编译不了——没有 grant 就没有地方挂限制', () => {
  const report = compileRules({
    rules: [rule({ payload: { mode: 'filter', on: { table: 'app.main.customers' }, predicate: '{ id: { _gt: 0 } }' } })],
    database: 'app',
    access: access(),
  });
  assert.equal(report.summary.compiled, 1);
  assert.equal(report.changes.length, 0);
  assert.match(report.conflicts[0].reason, /没有任何角色的读规则覆盖/);
});

test('filter：已知角色里没 grant 的会被点名，admin 除外（管理员要能修数据）', () => {
  const report = compileRules({
    rules: [rule()],
    database: 'app',
    access: access(),
    roles: ['admin', 'analyst', 'viewer', 'auditor'],
  });
  const reasons = report.conflicts.map((item) => item.reason).join(' ');
  assert.match(reasons, /auditor/);
  assert.ok(!reasons.includes('admin'), 'admin 不该被报成未覆盖');
  assert.ok(!reasons.includes('viewer'));
});

test('hide-column：从列清单里移除；只剩一列时拒绝，避免空清单', () => {
  const report = compileRules({
    rules: [
      rule({
        payload: { mode: 'hide-column', on: { table: 'app.main.orders', column: 'status' } },
      }),
    ],
    database: 'app',
    access: access(),
  });
  assert.deepEqual(report.access.grants.analyst.orders.columns, ['id', 'amount']);
  // viewer 本来就没有 status：不产生变更，也不报错
  assert.deepEqual(report.access.grants.viewer.orders.columns, ['id', 'amount']);
  assert.ok(report.changes.every((change) => change.action !== 'hide-column' || change.role === 'analyst'));

  const lastColumn = compileRules({
    rules: [
      rule({
        payload: { mode: 'hide-column', on: { table: 'app.main.orders', column: 'amount' } },
      }),
    ],
    database: 'app',
    access: {
      ...access(),
      grants: { only: { orders: { columns: ['amount'] } } },
    },
  });
  assert.match(lastColumn.conflicts[0].reason, /列清单为空/);
  assert.deepEqual(lastColumn.access.grants.only.orders.columns, ['amount']);
});

test('block-table：加入全局屏蔽；原本「仅管理员可读」的会被升级为全局屏蔽', () => {
  const report = compileRules({
    rules: [rule({ payload: { mode: 'block-table', on: { table: 'app.main.orders' } } })],
    database: 'app',
    access: access({ adminTables: ['orders'] }),
  });
  assert.deepEqual(report.access.blockedTables, ['orders']);
  assert.deepEqual(report.access.adminTables, []);
  assert.match(report.changes[0].detail, /全局屏蔽/);

  const again = compileRules({
    rules: [rule({ payload: { mode: 'block-table', on: { table: 'app.main.orders' } } })],
    database: 'app',
    access: report.access,
  });
  assert.equal(again.summary.effectiveChanges, 0);
});

test('read-only：写与删设为 blocked，重复应用不产生新变更', () => {
  const report = compileRules({
    rules: [rule({ payload: { mode: 'read-only' } })],
    database: 'app',
    access: access({ write: 'authenticated', delete: 'authenticated' }),
  });
  assert.equal(report.access.write, 'blocked');
  assert.equal(report.access.delete, 'blocked');

  const again = compileRules({ rules: [rule({ payload: { mode: 'read-only' } })], database: 'app', access: report.access });
  assert.equal(again.summary.effectiveChanges, 0);
});

test('没有形态的强制规则不参与编译，并明确报出来', () => {
  const report = compileRules({
    rules: [rule({ payload: {} })],
    database: 'app',
    access: access(),
  });
  assert.equal(report.summary.compiled, 0);
  assert.equal(report.summary.skipped, 1);
  assert.match(report.conflicts[0].reason, /无法编译/);
});

test('只编译目标库的规则；非 enforce 的规则不参与', () => {
  const report = compileRules({
    rules: [
      rule({ id: 1 }),
      rule({ id: 2, database: 'analytics' }),
      rule({ id: 3, severity: 'warn' }),
    ],
    database: 'app',
    access: access(),
  });
  assert.equal(report.summary.rules, 1);
});

test('编译不改动传入的现状（返回的是副本）', () => {
  const base = access();
  const before = JSON.stringify(base);
  compileRules({ rules: [rule()], database: 'app', access: base });
  assert.equal(JSON.stringify(base), before);
});

test('normalizeAccess：接受实例返回的数组形态与下划线字段', () => {
  const normalized = normalizeAccess({
    read: 'public',
    write: 'authenticated',
    delete: 'blocked',
    owner_column: 'owner_id',
    admin_tables: ['secrets'],
    blocked_tables: ['audit'],
    grants: [
      { role: 'analyst', tables: [{ name: 'orders', columns: ['id'], filter: '{ a: { _eq: 1 } }' }] },
    ],
  });
  assert.equal(normalized.ownerColumn, 'owner_id');
  assert.deepEqual(normalized.adminTables, ['secrets']);
  assert.deepEqual(normalized.blockedTables, ['audit']);
  assert.deepEqual(normalized.grants.analyst.orders.columns, ['id']);
  assert.equal(normalized.grants.analyst.orders.filter, '{ a: { _eq: 1 } }');
});

test('编译结果能直接喂给 buildSourceAccessConfig——不在应用那一步才炸', () => {
  // 应用时真正调用的是 buildSourceAccessConfig（permissions.apply 内部）。
  // 如果编译产出它会拒绝的形状（空列清单、admin 与 blocked 重叠），用户会点下「应用」才失败。
  const report = compileRules({
    rules: [
      rule(),
      rule({ id: 2, name: '隐藏列', payload: { mode: 'hide-column', on: { table: 'app.main.orders', column: 'status' } } }),
      rule({ id: 3, name: '只读', payload: { mode: 'read-only' } }),
    ],
    database: 'app',
    access: access({ adminTables: ['orders'] }),
  });

  const built = buildSourceAccessConfig({
    read: report.access.read,
    write: report.access.write,
    del: report.access.delete,
    ownerColumn: report.access.ownerColumn ?? undefined,
    adminTables: report.access.adminTables,
    blockedTables: report.access.blockedTables,
    grants: report.access.grants,
  });

  assert.equal(built.write, 'blocked');
  assert.equal(built.delete, 'blocked');
  // 两个角色各一条 grant，过滤与列清单都在
  assert.equal(built.grants.length, 2);
  const analyst = built.grants.find((grant) => grant.role === 'analyst');
  assert.match(analyst.tables[0].filter, /_eq/);
  assert.deepEqual(analyst.tables[0].columns, ['id', 'amount']);
});

test('block-table 与 admin_tables 的重叠在编译期解决，应用期不会因此抛错', () => {
  const report = compileRules({
    rules: [rule({ payload: { mode: 'block-table', on: { table: 'app.main.orders' } } })],
    database: 'app',
    access: access({ adminTables: ['orders'] }),
  });
  assert.doesNotThrow(() =>
    buildSourceAccessConfig({
      read: report.access.read,
      write: report.access.write,
      del: report.access.delete,
      adminTables: report.access.adminTables,
      blockedTables: report.access.blockedTables,
      grants: report.access.grants,
    })
  );
});

test('现状里有写入路径不认识的字段时，编译期就提示「应用后会丢」', () => {
  const report = compileRules({
    rules: [rule()],
    database: 'app',
    // dev.yml 允许手写 public_tables，但 buildSourceAccessConfig 不产出它
    access: { ...access(), public_tables: ['lookups'] },
  });
  const warned = report.conflicts.find((item) => /public_tables/.test(item.reason));
  assert.ok(warned, '必须提示 public_tables 会被丢掉');
  assert.match(warned.reason, /丢失/);

  // 没有这类字段时不产生噪音
  const clean = compileRules({ rules: [rule()], database: 'app', access: access() });
  assert.ok(!clean.conflicts.some((item) => /public_tables/.test(item.reason)));
});
