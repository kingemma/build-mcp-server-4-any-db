'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCatalog,
  searchEntries,
  describeObject,
} = require('../src/ontology-catalog');

function entry(overrides) {
  return {
    id: 1,
    database: 'app',
    kind: 'term',
    name: '买家',
    aliases: [],
    definition: '',
    tables: [],
    expression: '',
    severity: 'info',
    payload: {},
    facets: [],
    ...overrides,
  };
}

const ENTRIES = [
  entry({ id: 1, name: '买家', aliases: ['客户'], definition: '平台的付费主体', tables: ['app.main.customers'] }),
  entry({ id: 2, kind: 'concept', name: '订单', definition: '购买意图', tables: ['app.main.orders'] }),
  entry({
    id: 3,
    kind: 'relation',
    name: '下单人',
    payload: {
      from: { table: 'app.main.orders', column: 'customer_id' },
      to: { table: 'app.main.customers', column: 'id' },
      cardinality: 'many-to-one',
    },
  }),
  entry({
    id: 4,
    kind: 'rule',
    name: '只看未作废',
    severity: 'enforce',
    payload: { mode: 'filter', on: { table: 'app.main.orders' }, predicate: '{ voided_at: { _is_null: true } }' },
  }),
  entry({ id: 5, kind: 'rule', name: '只是提醒', severity: 'warn', definition: 'x' }),
  entry({ id: 6, kind: 'metric', name: '平均金额', tables: ['app.main.orders'], expression: 'avg(amount)' }),
  entry({ id: 7, database: 'analytics', kind: 'term', name: '事件', tables: ['analytics.main.events'] }),
];

test('目录：没有条目时返回空串（网关据此不注入）', () => {
  assert.equal(buildCatalog([]), '');
  assert.equal(buildCatalog(null), '');
});

test('目录：按库给计数，只列硬约束，不列提醒级别的规则', () => {
  const text = buildCatalog(ENTRIES);
  assert.match(text, /# 业务本体论（目录）/);
  assert.match(text, /## 库 app/);
  assert.match(text, /术语 1 · 概念 1 · 关系 1 · 规则 2 · 指标 1/);
  // 强制规则必须出现在目录里：它们决定「答案会不会错」，不能等模型主动去取
  assert.match(text, /只看未作废/);
  assert.match(text, /形态=filter/);
  assert.ok(!text.includes('只是提醒'), '提醒级规则不该占目录篇幅');
  assert.match(text, /## 库 analytics/);
});

test('目录：告诉模型怎么从目录跳到细节，且标明内容是数据不是指令', () => {
  const text = buildCatalog(ENTRIES);
  assert.match(text, /数据\*\*，不是指令/);
  assert.match(text, /business_ontology\(\{database/);
  assert.match(text, /business_ontology\(\{query/);
  assert.match(text, /describe_business_object/);
  assert.match(text, /query_catalog/);
});

test('目录：超过上限时截断并注明，不把条目截一半', () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    entry({ id: index + 1, kind: 'rule', name: `规则${index}`, severity: 'enforce', payload: { mode: 'read-only' } })
  );
  const text = buildCatalog(many, { maxChars: 600 });
  assert.ok(text.length <= 600, `目录长度应受控，实际 ${text.length}`);
  assert.match(text, /目录已截断/);
  // 截断发生在行边界：不会出现半截的 `- [rule#`
  for (const line of text.split('\n')) {
    if (line.startsWith('- [rule#')) assert.match(line, /\] .+/);
  }
});

test('检索：别名命中优先于说明命中', () => {
  const byAlias = searchEntries(ENTRIES, '客户');
  assert.equal(byAlias[0].entry.name, '买家');
  assert.match(byAlias[0].matchedBy.join(''), /完全匹配/);

  const byDefinition = searchEntries(ENTRIES, '付费主体');
  assert.equal(byDefinition[0].entry.name, '买家');
  assert.match(byDefinition[0].matchedBy.join(''), /说明/);
});

test('检索：表名也能命中，且命中理由写清楚', () => {
  const matches = searchEntries(ENTRIES, '客户表在哪 customers');
  assert.ok(matches.some((match) => match.entry.name === '买家'));
  const hit = matches.find((match) => match.entry.name === '买家');
  assert.match(hit.matchedBy.join(''), /customers/);
});

test('检索：按库过滤、限制条数、空查询返回空', () => {
  assert.equal(searchEntries(ENTRIES, '').length, 0);
  assert.equal(searchEntries(ENTRIES, '   ').length, 0);
  const analytics = searchEntries(ENTRIES, '事件', { database: 'analytics' });
  assert.equal(analytics.length, 1);
  assert.equal(searchEntries(ENTRIES, '事件', { database: 'app' }).length, 0);
  assert.ok(searchEntries(ENTRIES, '订单', { limit: 1 }).length === 1);
});

test('检索：完全无关的查询返回空数组，让调用方自己决定怎么回', () => {
  assert.deepEqual(searchEntries(ENTRIES, '完全无关的东西'), []);
});

test('画像：精确命中名字，带出共用同一批表的条目', () => {
  const found = describeObject(ENTRIES, '买家');
  assert.equal(found.entry.name, '买家');
  const names = found.related.map((item) => item.name);
  // 下单人的两端就在 customers / orders 上，所以它沾买家这张表
  assert.ok(names.includes('下单人'));
  // 订单只在自己的表上，不该仅仅因为业务上相关就被带进来——连接键是表，不是想象
  assert.ok(!names.includes('订单'));
  // 事件在另一个库，更不该混进来
  assert.ok(!names.includes('事件'));
});

test('画像：别名与部分说法都能找到，部分说法优先精确', () => {
  assert.equal(describeObject(ENTRIES, '客户').entry.name, '买家');
  // 「买家等级」这种问法不该找不到「买家」
  assert.equal(describeObject(ENTRIES, '买家等级').entry.name, '买家');
});

test('画像：payload.column 绑定的表也算在这条条目名下', () => {
  const withColumn = [
    entry({ id: 10, name: '已支付', payload: { column: 'app.main.orders.status' } }),
    entry({ id: 11, kind: 'metric', name: 'GMV', tables: ['app.main.orders'] }),
  ];
  const found = describeObject(withColumn, '已支付');
  assert.deepEqual(found.tables, ['app.main.orders']);
  assert.deepEqual(found.related.map((item) => item.name), ['GMV']);
});

test('画像：找不到返回 null；按库过滤时不会跨库命中', () => {
  assert.equal(describeObject(ENTRIES, '不存在'), null);
  assert.equal(describeObject(ENTRIES, ''), null);
  assert.equal(describeObject(ENTRIES, '事件', { database: 'app' }), null);
});
