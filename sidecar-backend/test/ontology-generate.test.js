'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOntology, buildSchemaDigest, parseModelJson, toEntry } = require('../src/ontology-generate');

const SCHEMA = {
  database: 'shop',
  tables: [
    {
      database: 'shop',
      schema: 'public',
      name: 'orders',
      comment: '订单',
      columns: [
        { name: 'id', type: 'int8' },
        { name: 'customer_id', type: 'int8', comment: '下单人' },
        { name: 'status', type: 'text', comment: '状态' },
      ],
    },
  ],
  relationships: [
    { fromDatabase: 'shop', fromSchema: 'public', fromTable: 'orders', fromColumn: 'customer_id', toDatabase: 'shop', toSchema: 'public', toTable: 'customers', toColumn: 'id' },
  ],
};

const MODEL_CONFIG = { id: 'm1', name: 'Test', kind: 'remote', baseUrl: 'http://llm/v1', model: 'test', apiKey: '' };

// 一段「模型」会返回的 JSON：含一条合法 relation + 一条合法 term + 一条 payload 非法的 rule
const MODEL_JSON = JSON.stringify({
  term: [{ name: '订单状态', definition: '订单的生命周期阶段', tables: ['shop.public.orders'], payload: { column: 'shop.public.orders.status' } }],
  concept: [{ name: '订单', definition: '一次购买行为', tables: ['shop.public.orders'], payload: { pkey: 'id' } }],
  relation: [{ name: '下单人', definition: '订单归属客户', payload: { from: { table: 'shop.public.orders', column: 'customer_id' }, to: { table: 'shop.public.customers', column: 'id' }, cardinality: 'many-to-one' } }],
  rule: [{ name: '已支付才能发货', definition: 'x', payload: { mode: 'filter', on: { table: 'shop.public.orders' }, predicate: 'status = paid', bogus: 'drop-me' } }],
  metric: [],
  example: [],
});

test('parseModelJson: 容忍 ```json 围栏与前后闲话', () => {
  const raw = '好的，这是结果：\n```json\n{"term":[{"name":"x"}]}\n```\n完成';
  const parsed = parseModelJson(raw);
  assert.equal(parsed.term[0].name, 'x');
});

test('parseModelJson: 非 JSON 返回空对象', () => {
  assert.deepEqual(parseModelJson('no json here'), {});
});

test('buildSchemaDigest: 按库过滤表与外键', () => {
  const digest = buildSchemaDigest(SCHEMA, 'shop');
  assert.match(digest.tableText, /表 shop\.public\.orders/);
  assert.match(digest.relText, /外键 shop\.public\.orders\.customer_id → shop\.public\.customers\.id/);
  // 指定别的库时不该出现 shop 的表
  const empty = buildSchemaDigest(SCHEMA, 'other');
  assert.equal(empty.tableText, '');
});

test('toEntry: 非法 payload 的条目被丢弃', () => {
  const bad = toEntry({ name: '坏规则', kind: 'rule', payload: { notAllowed: 1 } }, 'rule', 'shop');
  assert.equal(bad, null);
});

test('toEntry: 合法条目归一化为可落库形状', () => {
  const entry = toEntry(
    { name: '订单', definition: 'x', aliases: ['order'], tables: ['shop.public.orders'], payload: { pkey: 'id' } },
    'concept',
    'shop'
  );
  assert.equal(entry.kind, 'concept');
  assert.equal(entry.database, 'shop');
  assert.deepEqual(entry.aliases, ['order']);
  assert.deepEqual(entry.payload, { pkey: 'id' });
});

test('generateOntology: 调用 chatFn 并产出六类条目（非法 rule 被丢弃）', async () => {
  const chatFn = async () => MODEL_JSON;
  const result = await generateOntology({ schema: SCHEMA, database: 'shop', modelConfig: MODEL_CONFIG, chatFn });
  assert.equal(result.generated, true);
  assert.equal(result.entries.length, 3); // term + concept + relation；rule 因 bogus 键被丢弃
  const kinds = result.entries.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['concept', 'relation', 'term']);
  assert.equal(result.counts.relation, 1);
  assert.equal(result.counts.rule, 0);
});

test('generateOntology: 无 schema 时不调模型，返回 generated=false', async () => {
  let called = false;
  const chatFn = async () => {
    called = true;
    return '{}';
  };
  const result = await generateOntology({ schema: { tables: [] }, database: '', modelConfig: MODEL_CONFIG, chatFn });
  assert.equal(result.generated, false);
  assert.equal(result.schemaSource, 'none');
  assert.equal(called, false);
});

test('generateOntology: 表 / 外键按批次调用模型，不一次吞下全部', async () => {
  const tables = [0, 1, 2].map((i) => ({
    database: 'shop',
    schema: 'public',
    name: `t${i}`,
    columns: [{ name: 'id', type: 'int8' }],
  }));
  const relationships = [0, 1].map((i) => ({
    fromDatabase: 'shop',
    fromSchema: 'public',
    fromTable: `t${i}`,
    fromColumn: 'id',
    toDatabase: 'shop',
    toSchema: 'public',
    toTable: 'x',
    toColumn: 'id',
  }));
  let calls = 0;
  const chatFn = async () => {
    calls += 1;
    return '{}';
  };
  const result = await generateOntology({
    schema: { tables, relationships },
    database: 'shop',
    modelConfig: MODEL_CONFIG,
    chatFn,
    tablesPerBatch: 1,
    relationsPerBatch: 1,
  });
  // 5 个表类别 × 3 个表批次 = 15；2 条外键 × 1 = 2
  assert.equal(calls, 17);
  assert.equal(result.batches.total, 17);
  assert.equal(result.batches.failed, 0);
});

test('generateOntology: 单个批次失败不影响其它类别', async () => {
  const chatFn = async (model, messages) => {
    const prompt = messages[1].content;
    if (prompt.includes('"metric"')) throw new Error('boom');
    if (prompt.includes('"term"')) {
      return JSON.stringify({ term: [{ name: '状态', payload: { column: 'shop.public.orders.status' } }] });
    }
    return '{}';
  };
  const result = await generateOntology({
    schema: SCHEMA,
    database: 'shop',
    modelConfig: MODEL_CONFIG,
    chatFn,
  });
  assert.equal(result.batches.failed, 1);
  assert.equal(result.batches.failures[0].kind, 'metric');
  assert.equal(result.counts.metric, 0);
  assert.ok(result.entries.some((entry) => entry.kind === 'term'));
});

test('generateOntology: 跨批次重复条目按 kind+name 去重', async () => {
  const tables = [0, 1].map((i) => ({
    database: 'shop',
    schema: 'public',
    name: `t${i}`,
    columns: [{ name: 'id', type: 'int8' }],
  }));
  const chatFn = async (model, messages) => {
    const prompt = messages[1].content;
    if (prompt.includes('"term"')) {
      return JSON.stringify({ term: [{ name: '状态', definition: 'x', payload: {} }] });
    }
    return '{}';
  };
  const result = await generateOntology({
    schema: { tables, relationships: [] },
    database: 'shop',
    modelConfig: MODEL_CONFIG,
    chatFn,
    tablesPerBatch: 1,
    relationsPerBatch: 40,
  });
  // term 类别被调用两次，每次返回同名条目 → 去重成 1
  assert.equal(result.counts.term, 1);
});
