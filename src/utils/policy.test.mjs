import test from 'node:test';
import assert from 'node:assert';

import {
  diffPolicy,
  normalizeCurrentRoles,
  normalizePendingMatrix,
  resolveColumns,
  scopeToDatabase,
  unresolvedBlockTables,
} from './policy.js';

const RAW_CONFIG = {
  roles: [
    {
      name: 'admin',
      tables: [
        {
          Name: 'accounts',
          database: 'app',
          Query: { Block: false, Limit: 0, Filters: null, Columns: null },
          Insert: { Block: false },
          Update: { Block: false },
          Delete: { Block: false },
        },
      ],
    },
    {
      name: 'bi',
      tables: [
        {
          Name: 'accounts',
          database: 'analytics',
          Query: { Block: false, Limit: 10, Filters: ['{ id: { _gt: 1 } }'], Columns: ['id'] },
          Insert: { Block: true },
          Update: { Block: true },
          Delete: { Block: true },
        },
      ],
    },
  ],
};

test('normalizeCurrentRoles：表键带库名，避免多库同名表互相覆盖', () => {
  const roles = normalizeCurrentRoles(RAW_CONFIG);

  assert.deepStrictEqual(Object.keys(roles.admin), ['app::accounts']);
  assert.deepStrictEqual(Object.keys(roles.bi), ['analytics::accounts']);
  assert.strictEqual(roles.bi['analytics::accounts'].query.state, 'allowed');
  assert.deepStrictEqual(roles.bi['analytics::accounts'].query.filters, [
    '{ id: { _gt: 1 } }',
  ]);
  assert.strictEqual(roles.bi['analytics::accounts'].insert.state, 'blocked');
});

test('normalizeCurrentRoles：大小写键都能读，缺操作时记为 default', () => {
  const roles = normalizeCurrentRoles({
    roles: [
      {
        Name: 'r',
        tables: [{ name: 't', database: 'db', query: { block: false }, Insert: { block: true } }],
      },
    ],
  });

  assert.strictEqual(roles.r['db::t'].query.state, 'allowed');
  assert.strictEqual(roles.r['db::t'].insert.state, 'blocked');
  assert.strictEqual(roles.r['db::t'].update.state, 'default');
});

test('scopeToDatabase：只取目标库并还原纯表名', () => {
  const roles = normalizeCurrentRoles(RAW_CONFIG);

  assert.deepStrictEqual(scopeToDatabase(roles, 'app'), {
    admin: { accounts: roles.admin['app::accounts'] },
  });
  assert.deepStrictEqual(scopeToDatabase(roles, 'missing'), {});
});

test('scopeToDatabase：没有目标库时保留全部并剥掉库前缀', () => {
  const scoped = scopeToDatabase(
    { r: { 'a::t': 1, 'b::t': 2, plain: 3 } },
    ''
  );

  assert.deepStrictEqual(scoped, { r: { t: 2, plain: 3 } });
});

test('resolveColumns：白名单原样返回，黑名单转补集', () => {
  assert.deepStrictEqual(resolveColumns({ columnMode: 'allow', columns: ['id'] }, ['id', 'x']), [
    'id',
  ]);
  assert.deepStrictEqual(resolveColumns({ columnMode: 'block', columns: ['x'] }, ['id', 'x']), [
    'id',
  ]);
  assert.deepStrictEqual(resolveColumns({ columnMode: 'block', columns: [] }, ['id', 'x']), []);
});

test('unresolvedBlockTables：block 模式但缺列清单时列出表名', () => {
  const matrix = {
    r: {
      app: {
        query: { columnMode: 'block', columns: ['secret'], enabled: true },
        insert: { columnMode: 'allow', columns: [], enabled: false },
      },
      other: {
        query: { columnMode: 'block', columns: ['secret'], enabled: true },
      },
    },
  };

  assert.deepStrictEqual(
    unresolvedBlockTables(matrix, { app: ['id', 'secret'], other: [] }),
    ['other']
  );
  assert.deepStrictEqual(unresolvedBlockTables(matrix, { app: ['id'], other: ['id'] }), []);
});

test('normalizePendingMatrix + diffPolicy：写入前状态与生效策略可比', () => {
  const current = normalizeCurrentRoles(RAW_CONFIG);
  const pending = normalizePendingMatrix({
    admin: {
      accounts: {
        query: { enabled: true },
        insert: { enabled: true },
        update: { enabled: true },
        delete: { enabled: true },
      },
    },
  });

  // 传入的矩阵键是纯表名（已被 scopeToDatabase 收敛）
  const changes = diffPolicy(scopeToDatabase(current, 'app'), pending);
  assert.deepStrictEqual(changes, []);
});

test('diffPolicy：开关与附加规则变化都会产出 diff', () => {
  const current = scopeToDatabase(normalizeCurrentRoles(RAW_CONFIG), 'analytics');
  const pending = normalizePendingMatrix({
    bi: {
      accounts: {
        query: { enabled: true, limit: 99, columns: ['id', 'name'] },
        insert: { enabled: false },
        update: { enabled: false },
        delete: { enabled: false },
      },
    },
  });

  const changes = diffPolicy(current, pending);
  assert.ok(changes.length >= 1);
  assert.ok(changes.some((change) => change.operation === 'query' && change.to.limit === 99));
});
