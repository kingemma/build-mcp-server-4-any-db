const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDemoProject, FINANCE_DATABASE, INVENTORY_DATABASE } = require('../src/demo');
const { buildDemoOntology, seedDemoOntology } = require('../src/demo-ontology');
const { OntologyStore } = require('../src/ontology');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-demo-ontology-'));
}

/** 建一次演示项目，返回目录与条目；后面几个用例共用这一份，省得反复建库 */
const demoDir = tempDir();
createDemoProject({ dir: demoDir, port: 45124 });
const ENTRIES = buildDemoOntology({ dir: demoDir });

const bare = (table) => String(table).split('.').pop();
const ofKind = (kind) => ENTRIES.filter((entry) => entry.kind === kind);
const conceptTables = new Set(
  ofKind('concept').flatMap((entry) => entry.tables.map(bare))
);

test('每张演示表都有一个概念，条目只引用真实存在的表', () => {
  assert.deepStrictEqual(
    [...conceptTables].sort(),
    [
      'accounts',
      'inbound_items',
      'inbound_orders',
      'invoices',
      'outbound_items',
      'outbound_orders',
      'payments',
      'products',
      'stock_levels',
      'voucher_entries',
      'vouchers',
      'warehouses',
    ].sort()
  );

  for (const entry of ENTRIES) {
    assert.ok(['finance', 'inventory'].includes(entry.database), `${entry.name} 属于演示库`);
    assert.ok(entry.name, '条目必须有名字');
    for (const table of entry.tables ?? []) {
      assert.ok(
        conceptTables.has(bare(table)),
        `${entry.name} 引用的 ${table} 必须是一张真实存在的演示表`
      );
    }
  }
});

test('外键都变成关系，两端都落在概念覆盖的表上', () => {
  const relations = ofKind('relation');
  assert.strictEqual(relations.length, 12);

  for (const relation of relations) {
    const { from, to, cardinality } = relation.payload;
    assert.ok(conceptTables.has(bare(from.table)), `${relation.name} 的起点表存在`);
    assert.ok(conceptTables.has(bare(to.table)), `${relation.name} 的终点表存在`);
    assert.strictEqual(cardinality, 'many-to-one');
    assert.ok(from.column && to.column, `${relation.name} 要带两端列`);
  }

  const names = relations.map((relation) => relation.name);
  assert.ok(names.includes('记入科目'), '人工命名的关系要保留业务叫法');
  assert.ok(names.includes('所属入库单'), '明细 → 单据的关系要能认出来');
});

test('术语绑定到列，取值域来自库里的真实数据', () => {
  const terms = ofKind('term');
  const tableTerms = terms.filter((term) => !term.payload?.column);
  assert.strictEqual(tableTerms.length, conceptTables.size, '每张表至少一个叫法');

  const status = terms.find((term) => term.name === '凭证状态');
  assert.strictEqual(status.payload.column, 'status');
  assert.deepStrictEqual([...status.payload.values].sort(), ['draft', 'posted', 'voided']);

  const direction = terms.find((term) => term.name === '借贷方向');
  assert.deepStrictEqual([...direction.payload.values].sort(), ['credit', 'debit']);
});

test('规则与指标都能在 schema 上落地，规则形态都是可编译的', () => {
  const rules = ofKind('rule');
  assert.ok(rules.length >= 3);
  for (const rule of rules) {
    assert.ok(
      ['filter', 'hide-column', 'block-table', 'read-only'].includes(rule.payload.mode),
      `${rule.name} 的形态合法`
    );
    assert.ok(conceptTables.has(bare(rule.payload.on.table)), `${rule.name} 落在真实表上`);
    if (rule.payload.mode === 'filter') {
      assert.ok(rule.payload.predicate, `${rule.name} 是 filter，必须有谓词`);
    }
    assert.ok(['info', 'warn', 'enforce'].includes(rule.severity));
  }

  const metrics = ofKind('metric');
  assert.ok(metrics.length >= 4);
  for (const metric of metrics) {
    assert.ok(metric.expression, `${metric.name} 要写口径`);
    assert.ok(metric.tables.length > 0, `${metric.name} 要挂到表上`);
  }
});

test('seedDemoOntology 幂等，并按库返回分类计数', () => {
  const dbFile = path.join(tempDir(), 'mcp-builder.db');
  const store = new OntologyStore(dbFile);
  try {
    const first = seedDemoOntology({ dir: demoDir, store });
    const second = seedDemoOntology({ dir: demoDir, store });

    assert.strictEqual(first.total, ENTRIES.length);
    assert.strictEqual(second.total, first.total, '重复点「一键演示」不能把条目翻倍');
    assert.strictEqual(store.list().length, ENTRIES.length);

    assert.strictEqual(first.byDatabase.finance.concept, 5);
    assert.strictEqual(first.byDatabase.inventory.concept, 7);
    assert.ok(first.byDatabase.finance.relation >= 4);
    assert.ok(first.byDatabase.inventory.metric >= 3);

    // 存进去的条目要能原样读回来（payload 是 JSON 列，形状错了这里会挂）
    const saved = store.list({ kind: 'relation' });
    assert.ok(saved.every((entry) => entry.payload?.from?.table && entry.payload?.to?.table));
  } finally {
    store.close();
  }
});

test('库文件不存在时产出空列表，不抛错', () => {
  const empty = buildDemoOntology({ dir: path.join(tempDir(), 'not-created') });
  assert.deepStrictEqual(empty, []);
});

test('演示库文件名与目录约定一致', () => {
  assert.ok(fs.existsSync(path.join(demoDir, FINANCE_DATABASE)));
  assert.ok(fs.existsSync(path.join(demoDir, INVENTORY_DATABASE)));
});
