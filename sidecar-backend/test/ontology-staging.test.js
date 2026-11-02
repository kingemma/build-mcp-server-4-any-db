'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { OntologyStore, OntologyStagingStore } = require('../src/ontology');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-staging-'));
const dbPath = path.join(tmp, 'test.db');
const ontology = new OntologyStore(dbPath);
const staging = new OntologyStagingStore(dbPath);

const sample = [
  {
    kind: 'term',
    name: '买家',
    definition: '付费方',
    aliases: ['客户'],
    tables: ['app.main.customers'],
    payload: { column: 'app.main.customers.id' },
    severity: 'info',
    facets: [],
  },
  {
    kind: 'concept',
    name: '订单',
    definition: '交易',
    aliases: [],
    tables: ['app.main.orders'],
    payload: { pkey: 'id' },
    severity: 'info',
    facets: [],
  },
];

test('staging: stage 后 list 返回带 batchId 的整齐条目', () => {
  staging.clearDatabase('app');
  staging.stage('b1', 'app', sample);
  const list = staging.list({ database: 'app' });
  assert.strictEqual(list.length, 2);
  const buyer = list.find((e) => e.name === '买家');
  assert.ok(buyer, '应找到「买家」草稿');
  assert.strictEqual(buyer.batchId, 'b1');
  assert.strictEqual(buyer.database, 'app');
  assert.deepStrictEqual(buyer.aliases, ['客户']);
});

test('staging: list 按库过滤', () => {
  staging.clearDatabase('other');
  staging.stage('b2', 'other', [{ kind: 'term', name: 'x', payload: {} }]);
  assert.strictEqual(staging.list({ database: 'app' }).length, 2);
  assert.strictEqual(staging.list({ database: 'other' }).length, 1);
});

test('staging: approve 升舱进 ontology 并从草稿移除', () => {
  const buyer = staging.list({ database: 'app' }).find((e) => e.name === '买家');
  assert.ok(buyer, '应找到「买家」草稿');
  const before = staging.list({ database: 'app' }).length;
  const saved = ontology.save({
    database: buyer.database,
    kind: buyer.kind,
    name: buyer.name,
    aliases: buyer.aliases,
    tables: buyer.tables,
    definition: buyer.definition,
    expression: buyer.expression,
    severity: buyer.severity,
    payload: buyer.payload,
    facets: buyer.facets,
  });
  staging.remove(buyer.id);
  assert.ok(saved.id);
  assert.strictEqual(staging.list({ database: 'app' }).length, before - 1);
  const inOnt = ontology.list().find((e) => e.name === '买家');
  assert.ok(inOnt);
});

test('staging: approveAll 升舱全部待审', () => {
  for (const row of staging.list({ database: 'app' })) {
    ontology.save({
      database: row.database,
      kind: row.kind,
      name: row.name,
      aliases: row.aliases,
      tables: row.tables,
      definition: row.definition,
      severity: row.severity,
      payload: row.payload,
      facets: row.facets,
    });
    staging.remove(row.id);
  }
  assert.strictEqual(staging.list({ database: 'app' }).length, 0);
  assert.strictEqual(ontology.list().length, 2);
});

test('staging: reject 移除一条草稿', () => {
  staging.clearDatabase('r');
  staging.stage('b3', 'r', [{ kind: 'term', name: 'z', payload: {} }]);
  const [one] = staging.list({ database: 'r' });
  assert.strictEqual(staging.remove(one.id), true);
  assert.strictEqual(staging.list({ database: 'r' }).length, 0);
});

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不阻塞 */
  }
});
