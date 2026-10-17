'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildOperation, buildRoleTableConfig, summarizePatch } = require('../src/permissions');

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
