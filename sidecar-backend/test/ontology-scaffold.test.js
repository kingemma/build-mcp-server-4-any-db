'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PER_KIND,
  humanizeName,
  relationNameFromColumn,
  proposeEntries,
  summarizeValues,
} = require('../src/ontology-scaffold');

const ORDERS = {
  database: 'app',
  schema: 'main',
  name: 'orders',
  comment: '',
  columns: [{ name: 'id' }, { name: 'customer_id' }, { name: 'status', comment: '订单状态' }],
};
const CUSTOMERS = {
  database: 'app',
  schema: 'main',
  name: 'customers',
  comment: '付费主体',
  columns: [{ name: 'id' }, { name: 'name', comment: '名称' }],
};
const FK = {
  fromDatabase: 'app',
  fromSchema: 'main',
  fromTable: 'orders',
  fromColumn: 'customer_id',
  toDatabase: 'app',
  toSchema: 'main',
  toTable: 'customers',
  toColumn: 'id',
};
const SCHEMA = { tables: [ORDERS, CUSTOMERS], relationships: [FK] };

const entry = (overrides) => ({
  id: 1,
  database: 'app',
  kind: 'term',
  name: 'x',
  aliases: [],
  definition: 'd',
  tables: [],
  expression: '',
  severity: 'info',
  payload: {},
  facets: [],
  ...overrides,
});

test('命名建议：分隔符换空格、ASCII 首字母大写、中文原样', () => {
  assert.equal(humanizeName('order_items'), 'Order items');
  assert.equal(humanizeName('入库时间'), '入库时间');
  assert.equal(humanizeName('  '), '');
  assert.equal(relationNameFromColumn('customer_id'), 'Customer');
  // 整列就叫 id 时不能去成空串
  assert.equal(relationNameFromColumn('id'), 'Id');
});

test('起草：没有条目时，表 / 外键 / 有注释的列都被提出来', () => {
  const result = proposeEntries({ schema: SCHEMA, entries: [] });

  assert.deepEqual(result.counts, { concepts: 2, relations: 1, terms: 2 });

  const concepts = result.concepts.map((item) => [item.name, item.definition, item.tables[0]]);
  assert.deepEqual(concepts, [
    ['Orders', '', 'app.main.orders'],
    // 表注释直接变成概念的定义：这是库里唯一已经存在的业务知识
    ['Customers', '付费主体', 'app.main.customers'],
  ]);

  const relation = result.relations[0];
  assert.equal(relation.name, 'Customer');
  assert.deepEqual(relation.from, { table: 'app.main.orders', column: 'customer_id' });
  assert.deepEqual(relation.to, { table: 'app.main.customers', column: 'id' });
  assert.equal(relation.cardinality, 'many-to-one');

  // 没有注释的列不给候选：名字已经在 schema 里，再抄一遍没有信息增量
  assert.deepEqual(
    result.terms.map((item) => [item.name, item.column, item.definition]),
    [
      ['Status', 'app.main.orders.status', '订单状态'],
      ['Name', 'app.main.customers.name', '名称'],
    ]
  );
});

test('起草：已覆盖的东西不再出现——按解析后的表身份比对，而不是字符串相等', () => {
  const result = proposeEntries({
    schema: SCHEMA,
    entries: [
      // 简写引用 orders：也算覆盖，否则用户会看到一个已经写过的表又冒出来
      entry({ kind: 'concept', name: '订单', tables: ['app.orders'] }),
      // 关系从反方向写：同一条边，不该重复起草
      entry({
        kind: 'relation',
        name: '订单',
        payload: {
          from: { table: 'app.main.customers', column: 'id' },
          to: { table: 'app.main.orders', column: 'customer_id' },
        },
      }),
      // 术语绑定了 status 列
      entry({ kind: 'term', name: '状态', payload: { column: 'app.main.orders.status' } }),
    ],
  });

  assert.deepEqual(result.counts, { concepts: 1, relations: 0, terms: 1 });
  assert.deepEqual(result.concepts.map((item) => item.name), ['Customers']);
  assert.deepEqual(result.terms.map((item) => item.name), ['Name']);
});

test('起草：按库过滤，别的库的表不会混进来', () => {
  const schema = {
    tables: [ORDERS, { ...CUSTOMERS, database: 'analytics' }],
    relationships: [FK],
  };
  const result = proposeEntries({ schema, entries: [], database: 'analytics' });
  assert.deepEqual(result.concepts.map((item) => item.name), ['Customers']);
  // 外键属于 app，按 analytics 过滤后不该出现
  assert.equal(result.relations.length, 0);
});

test('起草：候选有上限，总数照实报——一次给 90 条等于什么都没给', () => {
  const tables = Array.from({ length: MAX_PER_KIND + 5 }, (_, index) => ({
    database: 'app',
    schema: 'main',
    name: `t${index}`,
  }));
  const result = proposeEntries({ schema: { tables, relationships: [] }, entries: [] });
  assert.equal(result.concepts.length, MAX_PER_KIND);
  assert.equal(result.counts.concepts, MAX_PER_KIND + 5);
  assert.equal(result.truncated.concepts, true);
});

test('起草：没有 schema 时安静返回空结果，不抛错', () => {
  for (const schema of [null, {}, { tables: [] }]) {
    const result = proposeEntries({ schema, entries: [] });
    assert.deepEqual(result.counts, { concepts: 0, relations: 0, terms: 0 });
    assert.deepEqual(result.concepts, []);
  }
});

test('值域：低基数列给出按频率排序的取值', () => {
  const rows = [
    { status: 'paid' },
    { status: 'paid' },
    { status: 'pending' },
    { status: null },
    { status: 'paid' },
    { status: 'refunded' },
  ];
  const result = summarizeValues(rows, 'status');
  assert.equal(result.suitable, true);
  assert.equal(result.sampled, 6);
  assert.equal(result.distinct, 3);
  assert.deepEqual(result.values, ['paid', 'pending', 'refunded']);
});

test('值域：取值太多直接拒绝——这列不是字典', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ id: index }));
  const result = summarizeValues(rows, 'id');
  assert.equal(result.suitable, false);
  assert.equal(result.distinct, 60);
  assert.match(result.reason, /不是低基数列/);
  assert.deepEqual(result.values, []);
});

test('值域：自由文本（很长 / 含等号 / 含换行）也拒绝', () => {
  const long = summarizeValues([{ note: 'x'.repeat(200) }], 'note');
  assert.equal(long.suitable, false);
  assert.match(long.reason, /自由文本/);

  const kv = summarizeValues([{ cfg: 'a=1' }, { cfg: 'b=2' }], 'cfg');
  assert.equal(kv.suitable, false);
  assert.match(kv.reason, /等号/);

  const multiline = summarizeValues([{ text: '第一行\n第二行' }], 'text');
  assert.equal(multiline.suitable, false);
});

test('值域：空表与全是 null 时给出可读原因，不抛错', () => {
  const empty = summarizeValues([], 'status');
  assert.equal(empty.suitable, false);
  assert.match(empty.reason, /没有取到数据/);

  const nulls = summarizeValues([{ status: null }, { status: null }], 'status');
  assert.equal(nulls.distinct, 0);
  assert.equal(nulls.suitable, true);
  assert.deepEqual(nulls.values, []);
});
