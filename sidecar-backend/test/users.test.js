'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { UserStore, UserStoreError, syncRolesToGraphJin } = require('../src/users');

test('组织：创建与列出', () => {
  const store = new UserStore(':memory:');
  const org = store.createOrganization('Acme');
  assert.strictEqual(org.name, 'Acme');
  assert.deepStrictEqual(store.listOrganizations().map((o) => o.name), ['Acme']);
  store.close();
});

test('组织：重名报错', () => {
  const store = new UserStore(':memory:');
  store.createOrganization('Acme');
  assert.throws(() => store.createOrganization('Acme'), UserStoreError);
  store.close();
});

test('组织：空名报错', () => {
  const store = new UserStore(':memory:');
  assert.throws(() => store.createOrganization('  '), /组织名 不能为空/);
  store.close();
});

test('用户：创建、按组织过滤、按邮箱查找', () => {
  const store = new UserStore(':memory:');
  const acme = store.createOrganization('Acme');
  const other = store.createOrganization('Other');

  store.createUser({ organizationId: acme.id, name: 'Alice', email: 'a@acme.test', role: 'admin' });
  store.createUser({ organizationId: other.id, name: 'Bob', email: 'b@other.test', role: 'analyst' });

  assert.strictEqual(store.listUsers(acme.id).length, 1);
  assert.strictEqual(store.listUsers().length, 2);
  assert.strictEqual(store.findUserByEmail('b@other.test').name, 'Bob');
  assert.strictEqual(store.findUserByEmail('missing@test'), null);
  store.close();
});

test('用户：邮箱重复、缺字段、非法组织 id 都报错', () => {
  const store = new UserStore(':memory:');
  const org = store.createOrganization('Acme');
  const base = { organizationId: org.id, name: 'Alice', email: 'a@acme.test', role: 'admin' };
  store.createUser(base);

  assert.throws(() => store.createUser(base), UserStoreError);
  assert.throws(() => store.createUser({ ...base, email: 'x@acme.test', role: '' }), /角色 不能为空/);
  assert.throws(() => store.createUser({ ...base, organizationId: 1.5 }), /organizationId 必须是整数/);
  store.close();
});

test('用户：改角色与删除', () => {
  const store = new UserStore(':memory:');
  const org = store.createOrganization('Acme');
  const user = store.createUser({ organizationId: org.id, name: 'Alice', email: 'a@acme.test', role: 'admin' });

  assert.strictEqual(store.setUserRole(user.id, 'readonly'), true);
  assert.strictEqual(store.findUserByEmail('a@acme.test').role, 'readonly');
  assert.strictEqual(store.setUserRole(9999, 'readonly'), false);
  assert.strictEqual(store.deleteUser(user.id), true);
  assert.strictEqual(store.deleteUser(user.id), false);
  assert.throws(() => store.setUserRole('1', 'admin'), /userId 必须是整数/);
  store.close();
});

test('用户：改资料，邮箱重复与缺字段都报错', () => {
  const store = new UserStore(':memory:');
  const org = store.createOrganization('Acme');
  const alice = store.createUser({ organizationId: org.id, name: 'Alice', email: 'a@acme.test', role: 'admin' });
  store.createUser({ organizationId: org.id, name: 'Bob', email: 'b@acme.test', role: 'analyst' });

  const updated = store.updateUser(alice.id, { name: 'Alice Liddell', email: 'alice@acme.test' });
  assert.strictEqual(updated.name, 'Alice Liddell');
  assert.strictEqual(updated.email, 'alice@acme.test');
  assert.strictEqual(updated.role, 'admin');
  assert.strictEqual(store.updateUser(9999, { name: 'X', email: 'x@test' }), null);
  assert.throws(() => store.updateUser(alice.id, { name: '  ', email: 'x@test' }), /用户名 不能为空/);
  assert.throws(() => store.updateUser(alice.id, { name: 'X', email: 'b@acme.test' }), UserStoreError);
  store.close();
});

test('组织：有成员时拒绝删除，清空后可删', () => {
  const store = new UserStore(':memory:');
  const org = store.createOrganization('Acme');
  const user = store.createUser({ organizationId: org.id, name: 'A', email: 'a@test', role: 'admin' });

  assert.throws(() => store.deleteOrganization(org.id), /还有 1 个成员/);
  store.deleteUser(user.id);
  assert.deepStrictEqual(store.deleteOrganization(org.id), { deleted: true, members: 0 });
  assert.strictEqual(store.listOrganizations().length, 0);
  assert.strictEqual(store.deleteOrganization(org.id).deleted, false);
  store.close();
});

test('角色：去重且有序', () => {
  const store = new UserStore(':memory:');
  const org = store.createOrganization('Acme');
  for (const [name, email, role] of [
    ['A', 'a@t', 'admin'],
    ['B', 'b@t', 'analyst'],
    ['C', 'c@t', 'admin'],
  ]) {
    store.createUser({ organizationId: org.id, name, email, role });
  }
  assert.deepStrictEqual(store.listRoles(), ['admin', 'analyst']);
  store.close();
});

test('syncRolesToGraphJin：只补齐缺失的角色', async () => {
  const store = new UserStore(':memory:');
  const org = store.createOrganization('Acme');
  store.createUser({ organizationId: org.id, name: 'A', email: 'a@t', role: 'admin' });
  store.createUser({ organizationId: org.id, name: 'B', email: 'b@t', role: 'analyst' });
  store.createUser({ organizationId: org.id, name: 'C', email: 'c@t', role: 'reviewer' });

  const applied = [];
  const service = {
    readConfig: async () => ({ roles: [{ name: 'admin' }] }),
    updateConfig: async (patch) => {
      applied.push(patch);
      return { success: true };
    },
  };

  const result = await syncRolesToGraphJin({ store, service });
  assert.deepStrictEqual(result.created, ['analyst', 'reviewer']);
  assert.deepStrictEqual(result.existing, ['admin']);
  assert.deepStrictEqual(applied[0].roles, [{ name: 'analyst' }, { name: 'reviewer' }]);
  store.close();
});

test('syncRolesToGraphJin：全部已存在时不写入', async () => {
  const store = new UserStore(':memory:');
  const org = store.createOrganization('Acme');
  store.createUser({ organizationId: org.id, name: 'A', email: 'a@t', role: 'admin' });

  let called = false;
  const service = {
    readConfig: async () => ({ roles: [{ name: 'admin' }] }),
    updateConfig: async () => {
      called = true;
      return { success: true };
    },
  };

  const result = await syncRolesToGraphJin({ store, service });
  assert.deepStrictEqual(result.created, []);
  assert.strictEqual(called, false);
  store.close();
});

test('syncRolesToGraphJin：显式指定 roleNames 时以它为准', async () => {
  const store = new UserStore(':memory:');
  const applied = [];
  const service = {
    readConfig: async () => ({ roles: [] }),
    updateConfig: async (patch) => {
      applied.push(patch);
      return { success: true };
    },
  };

  // 库里没有用户，但权限矩阵里出现了角色，也要先补齐
  const result = await syncRolesToGraphJin({ store, service, roleNames: ['readonly', 'admin'] });
  assert.deepStrictEqual(result.created, ['readonly', 'admin']);
  assert.deepStrictEqual(applied[0].roles, [{ name: 'readonly' }, { name: 'admin' }]);
  store.close();
});

test('syncRolesToGraphJin：没有用户时不调用 GraphJin', async () => {
  const store = new UserStore(':memory:');
  let called = false;
  const service = { readConfig: async () => { called = true; return {}; }, applyConfig: async () => ({}) };
  assert.deepStrictEqual(await syncRolesToGraphJin({ store, service }), { created: [], existing: [] });
  assert.strictEqual(called, false);
  store.close();
});
