'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hiddenTablesByDatabase,
  filterEntriesForRole,
  splitRef,
  refsOf,
  createOntologyProvider,
} = require('../src/ontology-delivery');

const ACCESSES = {
  app: { blocked_tables: ['audit'], admin_tables: ['salaries'] },
  // 另一个库也有一张叫 orders 的表：屏蔽是按库生效的，不能跨库连坐
  analytics: { blocked_tables: ['orders'], admin_tables: [] },
};

function entry(overrides) {
  return {
    id: 1,
    database: 'app',
    kind: 'term',
    name: '买家',
    aliases: [],
    definition: 'x',
    tables: [],
    expression: '',
    severity: 'info',
    payload: {},
    facets: [],
    ...overrides,
  };
}

const ENTRIES = [
  entry({ id: 1, name: '买家', tables: ['app.main.customers'] }),
  entry({ id: 2, kind: 'concept', name: '薪酬', tables: ['app.main.salaries'] }),
  entry({ id: 3, name: '审计日志', tables: ['app.main.audit'] }),
  entry({ id: 4, name: '订单事件', tables: ['analytics.main.orders'] }),
  entry({ id: 5, name: '订单', tables: ['app.main.orders'] }),
  entry({ id: 6, name: '口语', tables: [] }),
];

test('隐藏表：按库收集；blocked 对所有人隐藏，admin 表只对非 admin 隐藏', () => {
  const asAdmin = hiddenTablesByDatabase(ACCESSES, 'admin');
  assert.deepEqual([...asAdmin.get('app')].sort(), ['audit']);
  assert.deepEqual([...asAdmin.get('analytics')], ['orders']);

  const asCustomer = hiddenTablesByDatabase(ACCESSES, 'customer');
  assert.deepEqual([...asCustomer.get('app')].sort(), ['audit', 'salaries']);
  // 空集合的库不进 map，省得后面白查
  assert.deepEqual([...asCustomer.get('analytics')], ['orders']);
});

test('过滤：非 admin 看不到管理员表与屏蔽表，admin 看得到管理员表', () => {
  const adminNames = filterEntriesForRole(ENTRIES, { accesses: ACCESSES, role: 'admin' }).map(
    (item) => item.name
  );
  assert.ok(adminNames.includes('薪酬'));
  assert.ok(!adminNames.includes('审计日志'));

  const customerNames = filterEntriesForRole(ENTRIES, {
    accesses: ACCESSES,
    role: 'customer',
  }).map((item) => item.name);
  assert.ok(!customerNames.includes('薪酬'));
  assert.ok(!customerNames.includes('审计日志'));
});

test('过滤：同名表在不同库不连坐——analytics 屏蔽了 orders，app 的 orders 仍然可见', () => {
  const names = filterEntriesForRole(ENTRIES, { accesses: ACCESSES, role: 'customer' }).map(
    (item) => item.name
  );
  assert.ok(names.includes('订单'), 'app.main.orders 不该被 analytics 的屏蔽影响');
  assert.ok(!names.includes('订单事件'), 'analytics.main.orders 该被屏蔽');
});

test('过滤：没有表引用的条目保留（它不指向任何被隐藏的对象）', () => {
  const names = filterEntriesForRole(ENTRIES, { accesses: ACCESSES, role: 'customer' }).map(
    (item) => item.name
  );
  assert.ok(names.includes('口语'));
});

test('过滤：沾到一张被隐藏的表就整条隐藏——一半语义也会泄漏那张表的存在', () => {
  const relation = entry({
    id: 9,
    kind: 'relation',
    name: '薪酬归属',
    tables: ['app.main.customers', 'app.main.salaries'],
    payload: { from: { table: 'app.main.salaries' }, to: { table: 'app.main.customers' } },
  });
  const kept = filterEntriesForRole([relation], { accesses: ACCESSES, role: 'customer' });
  assert.deepEqual(kept, []);
  const asAdmin = filterEntriesForRole([relation], { accesses: ACCESSES, role: 'admin' });
  assert.equal(asAdmin.length, 1);
});

test('过滤：绑定的列、规则作用表、关系两端都参与判定', () => {
  const byColumn = entry({ id: 10, payload: { column: 'app.main.salaries.amount' } });
  const byRuleTable = entry({ id: 11, kind: 'rule', payload: { mode: 'filter', on: { table: 'app.main.audit' } } });
  const byRelation = entry({
    id: 12,
    kind: 'relation',
    payload: { from: { table: 'app.main.audit' }, to: { table: 'app.main.customers' } },
  });

  for (const item of [byColumn, byRuleTable, byRelation]) {
    assert.equal(refsOf(item).length > 0, true, `refsOf 应取到引用：${item.id}`);
    assert.deepEqual(filterEntriesForRole([item], { accesses: ACCESSES, role: 'customer' }), []);
  }
});

test('splitRef：规范形式取首尾，短引用归到条目自己的库', () => {
  assert.deepEqual(splitRef('app.main.salaries', 'x'), { database: 'app', table: 'salaries' });
  assert.deepEqual(splitRef('app.orders', 'x'), { database: 'app', table: 'orders' });
  assert.deepEqual(splitRef('orders', 'app'), { database: 'app', table: 'orders' });
  assert.equal(splitRef('', 'app'), null);
});

test('提供方：没有项目目录时不过滤（读不到配置就别假装知道）', () => {
  const store = { list: () => ENTRIES, renderEntries: (list) => list.map((item) => item.name).join(',') };
  let called = false;
  const provider = createOntologyProvider({
    store,
    projectDir: null,
    readAccesses: () => {
      called = true;
      return ACCESSES;
    },
  });
  const business = provider('customer');
  assert.equal(called, false);
  assert.ok(business.entries.some((item) => item.name === '薪酬'));
});

test('提供方：按角色过滤，且没有可见条目时返回 null（保持纯透传）', () => {
  const store = { list: () => ENTRIES, renderEntries: (list) => list.map((item) => item.name).join(',') };
  const provider = createOntologyProvider({
    store,
    projectDir: '/tmp/project',
    readAccesses: () => ACCESSES,
  });

  const asCustomer = provider('customer');
  assert.ok(!asCustomer.entries.some((item) => item.name === '薪酬'));
  assert.ok(asCustomer.entries.some((item) => item.name === '买家'));

  const onlySecrets = {
    list: () => [entry({ id: 99, name: '薪酬', tables: ['app.main.salaries'] })],
    renderEntries: () => 'x',
  };
  const narrow = createOntologyProvider({
    store: onlySecrets,
    projectDir: '/tmp/project',
    readAccesses: () => ACCESSES,
  });
  assert.equal(narrow('customer'), null);
  assert.ok(narrow('admin'));
});

test('提供方：没有条目时返回 null；目录与文档是懒渲染的', () => {
  const empty = createOntologyProvider({ store: { list: () => [], renderEntries: () => '' } });
  assert.equal(empty('admin'), null);

  let renders = 0;
  const store = {
    list: () => ENTRIES,
    renderEntries: (list) => {
      renders += 1;
      return list.map((item) => item.name).join(',');
    },
  };
  const provider = createOntologyProvider({ store, projectDir: null });
  const business = provider('admin');
  // 只取条目不该触发渲染：tools/list 这类请求不关心正文
  assert.equal(renders, 0);
  assert.match(business.catalog, /库 app/);
  assert.equal(renders, 0, 'catalog 不该调用 renderEntries');
  assert.match(business.document, /买家/);
  assert.equal(renders, 1);
});
