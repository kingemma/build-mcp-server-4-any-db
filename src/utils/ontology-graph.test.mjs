import test from 'node:test';
import assert from 'node:assert';

import { bareTable, buildOntologyGraph, edgeSag, layoutOntologyGraph } from './ontology-graph.js';

/** 一个库里有概念（含多表概念）、术语、关系（跨概念 / 概念内 / 落空）、规则、指标 */
const ENTRIES = [
  {
    id: 1,
    database: 'demo',
    kind: 'concept',
    name: '客户',
    aliases: ['买家'],
    definition: '付钱的人',
    tables: ['demo.main.customers'],
    payload: { pkey: 'id' },
  },
  {
    id: 2,
    database: 'demo',
    kind: 'concept',
    name: '订单',
    tables: ['orders', 'demo.main.order_items'],
    payload: {},
  },
  {
    id: 3,
    database: 'demo',
    kind: 'term',
    name: '成交单',
    tables: ['demo.main.orders'],
    payload: { column: 'status' },
  },
  {
    id: 4,
    database: 'demo',
    kind: 'relation',
    name: '下单',
    payload: {
      from: { table: 'orders', column: 'user_id' },
      to: { table: 'customers', column: 'id' },
      cardinality: 'many-to-one',
    },
  },
  {
    id: 5,
    database: 'demo',
    kind: 'relation',
    name: '订单明细',
    payload: { from: { table: 'order_items' }, to: { table: 'orders' } },
  },
  {
    // 对端没有概念：不该悄悄消失，要能报出来
    id: 6,
    database: 'demo',
    kind: 'relation',
    name: '发货',
    payload: { from: { table: 'orders' }, to: { table: 'shipments' } },
  },
  {
    id: 7,
    database: 'demo',
    kind: 'rule',
    name: '不看作废单',
    severity: 'enforce',
    payload: { mode: 'filter', on: { table: 'demo.main.orders' }, predicate: '{ status: { _eq: "voided" } }' },
  },
  {
    id: 8,
    database: 'demo',
    kind: 'metric',
    name: 'GMV',
    tables: ['demo.main.orders'],
    expression: 'sum(amount)',
  },
  // 另一个库的条目不该出现在这棵树里
  { id: 9, database: 'other', kind: 'concept', name: '事件', tables: ['events'], payload: {} },
];

test('bareTable 取最后一段，空值返回空串', () => {
  assert.strictEqual(bareTable('app.main.orders'), 'orders');
  assert.strictEqual(bareTable('orders'), 'orders');
  assert.strictEqual(bareTable('  '), '');
  assert.strictEqual(bareTable(null), '');
});

test('概念是节点：多表概念合并成一个，其它库的条目被过滤', () => {
  const graph = buildOntologyGraph(ENTRIES, { database: 'demo' });
  assert.strictEqual(graph.nodes.length, 2);

  const order = graph.nodes.find((node) => node.name === '订单');
  assert.deepStrictEqual(order.tables, ['orders', 'demo.main.order_items']);
  assert.ok(order.keys.has('order_items'), '多表概念的第二张表也要参与对齐');
  assert.strictEqual(graph.counts.concepts, 2);
});

test('术语 / 规则 / 指标挂到覆盖它们的节点上', () => {
  const graph = buildOntologyGraph(ENTRIES, { database: 'demo' });
  const order = graph.nodes.find((node) => node.name === '订单');
  const customer = graph.nodes.find((node) => node.name === '客户');

  assert.deepStrictEqual(order.terms.map((item) => item.name), ['成交单']);
  assert.deepStrictEqual(order.rules.map((item) => item.name), ['不看作废单']);
  assert.deepStrictEqual(order.metrics.map((item) => item.name), ['GMV']);
  assert.deepStrictEqual(customer.terms, []);
  assert.deepStrictEqual(customer.aliases, ['买家']);
});

test('跨概念的关系成为连线，带基数与业务叫法', () => {
  const graph = buildOntologyGraph(ENTRIES, { database: 'demo' });
  assert.strictEqual(graph.edges.length, 1);

  const [edge] = graph.edges;
  const order = graph.nodes.find((node) => node.name === '订单');
  const customer = graph.nodes.find((node) => node.name === '客户');
  assert.strictEqual(edge.from, order.id);
  assert.strictEqual(edge.to, customer.id);
  assert.strictEqual(edge.name, '下单');
  assert.strictEqual(edge.cardinality, 'many-to-one');
});

test('概念内部的关系不画连线，但要在详情里查得到', () => {
  const graph = buildOntologyGraph(ENTRIES, { database: 'demo' });
  assert.ok(!graph.edges.some((edge) => edge.name === '订单明细'));

  const order = graph.nodes.find((node) => node.name === '订单');
  assert.ok(order.relations.some((item) => item.name === '订单明细'));
});

test('两端落到概念之外的关系单独回收，不静默丢弃', () => {
  const graph = buildOntologyGraph(ENTRIES, { database: 'demo' });
  assert.strictEqual(graph.unmatched.length, 1);
  assert.strictEqual(graph.unmatched[0].relation.name, '发货');
  assert.strictEqual(graph.unmatched[0].toTable, 'shipments');
  assert.strictEqual(graph.unmatched[0].to, null);
});

test('没有概念时返回空图而不是报错', () => {
  const graph = buildOntologyGraph(ENTRIES, { database: 'empty' });
  assert.deepStrictEqual(graph.nodes, []);
  assert.deepStrictEqual(graph.edges, []);
  assert.strictEqual(graph.counts.concepts, 0);
});

test('环形布局：坐标稳定、互不重叠、落在画布内', () => {
  const graph = buildOntologyGraph(ENTRIES, { database: 'demo' });
  const first = layoutOntologyGraph(graph, { width: 760, height: 440 });
  const second = layoutOntologyGraph(graph, { width: 760, height: 440 });

  assert.deepStrictEqual(
    first.nodes.map((node) => [node.id, node.x, node.y]),
    second.nodes.map((node) => [node.id, node.x, node.y]),
    '同样的输入必须给出同样的坐标，否则截图与断言都不稳'
  );

  for (const node of first.nodes) {
    assert.ok(node.x > 0 && node.x < first.width, `${node.name} 的 x 落在画布内`);
    assert.ok(node.y > 0 && node.y < first.height, `${node.name} 的 y 落在画布内`);
  }
  const unique = new Set(first.nodes.map((node) => `${Math.round(node.x)},${Math.round(node.y)}`));
  assert.strictEqual(unique.size, first.nodes.length);
});

test('单个概念居中显示', () => {
  const graph = buildOntologyGraph([ENTRIES[0]], { database: 'demo' });
  const laid = layoutOntologyGraph(graph, { width: 760, height: 440 });
  assert.strictEqual(laid.nodes[0].x, 380);
  assert.strictEqual(laid.nodes[0].y, 220);
});

test('同一对节点之间的多条关系用不同弧度错开', () => {
  const graph = {
    nodes: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', name: '一' },
      { id: 'e2', from: 'a', to: 'b', name: '二' },
    ],
  };
  const laid = layoutOntologyGraph(graph);
  const sags = laid.edges.map((edge) => edge.sag);
  assert.strictEqual(sags[0], 0);
  assert.notStrictEqual(sags[1], 0);
  assert.strictEqual(edgeSag(2), -0.14);
  assert.strictEqual(edgeSag(3), 0.28);
});
