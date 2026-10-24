'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseAccessStore } = require('../src/database-access');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-dbaccess-'));
  return { dir, file: path.join(dir, 'test.db') };
}

test('rolesFor: 没配过返回 null，配过空数组返回空数组', () => {
  const store = new DatabaseAccessStore(':memory:');
  assert.strictEqual(store.rolesFor('finance'), null);

  store.setRoles('finance', []);
  // 「配过但只允许 admin」与「没配过」必须能区分，否则无法表达「谁都不给」
  assert.deepStrictEqual(store.rolesFor('finance'), []);
});

test('setRoles: 去掉 admin、去重、清空旧值', () => {
  const store = new DatabaseAccessStore(':memory:');
  const saved = store.setRoles('finance', ['finance_analyst', 'admin', 'finance_analyst', ' ']);
  assert.deepStrictEqual(saved, ['finance_analyst']);
  assert.deepStrictEqual(store.rolesFor('finance'), ['finance_analyst']);

  store.setRoles('finance', ['auditor']);
  assert.deepStrictEqual(store.rolesFor('finance'), ['auditor']);
});

test('setRoles: 入参不合法时抛错且不改动已有数据', () => {
  const store = new DatabaseAccessStore(':memory:');
  store.setRoles('finance', ['finance_analyst']);
  assert.throws(() => store.setRoles('', ['x']), /database 不能为空/);
  assert.throws(() => store.setRoles('finance', 'nope'), /roles 必须是字符串数组/);
  assert.deepStrictEqual(store.rolesFor('finance'), ['finance_analyst']);
});

test('list: 只返回配过的库', () => {
  const store = new DatabaseAccessStore(':memory:');
  store.setRoles('finance', ['finance_analyst']);
  store.setRoles('inventory', ['inventory_viewer']);
  store.setRoles('legacy', []);
  assert.deepStrictEqual(store.list(), {
    access: {
      finance: ['finance_analyst'],
      inventory: ['inventory_viewer'],
      legacy: [],
    },
    configured: ['finance', 'inventory', 'legacy'],
  });
});

test('落盘后新实例能读到（桌面端重启不丢配置）', () => {
  const { dir, file } = tempDb();
  const first = new DatabaseAccessStore(file);
  const second = new DatabaseAccessStore(file);
  try {
    first.setRoles('finance', ['finance_analyst']);
    assert.deepStrictEqual(second.rolesFor('finance'), ['finance_analyst']);
  } finally {
    // Windows 上文件被打开时删不掉，先关连接
    first.close();
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
