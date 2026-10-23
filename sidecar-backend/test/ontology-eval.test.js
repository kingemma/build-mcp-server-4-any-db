'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTableIndex } = require('../src/ontology-lint');
const {
  MAX_EXAMPLES,
  mentions,
  compareQuery,
  evaluateExamples,
} = require('../src/ontology-eval');

const ORDERS = {
  database: 'app',
  schema: 'main',
  name: 'orders',
  columns: [{ name: 'id' }, { name: 'amount' }, { name: 'status' }],
};
const CUSTOMERS = {
  database: 'app',
  schema: 'main',
  name: 'customers',
  columns: [{ name: 'id' }, { name: 'name' }],
};
const INDEX = buildTableIndex({ tables: [ORDERS, CUSTOMERS], relationships: [] });

const QUERY = '{ orders(where:{status:{eq:"paid"}}) { amount } }';

function example(overrides = {}) {
  return {
    id: 1,
    database: 'app',
    kind: 'example',
    name: '上月各站点的平均履约时长',
    aliases: [],
    definition: '',
    tables: [],
    expression: QUERY,
    severity: 'info',
    payload: {},
    facets: [],
    ...overrides,
  };
}

test('mentions：按词边界匹配，amount 不该命中 total_amount', () => {
  assert.equal(mentions('{ orders { amount } }', 'amount'), true);
  assert.equal(mentions('{ orders { total_amount } }', 'amount'), false);
  // 中文取值没有词边界，不能因为加了边界就永远匹配不上
  assert.equal(mentions('status = "已支付"', '已支付'), true);
});

test('compareQuery：没声明期望时 declared 为 false，不做任何断言', () => {
  const result = compareQuery(QUERY, {});
  assert.equal(result.declared, false);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, { tables: [], columns: [], values: [] });
});

test('compareQuery：期望都出现时通过；规范形式的表名也能对上裸表名', () => {
  const result = compareQuery(QUERY, {
    tables: ['app.main.orders'],
    columns: ['amount', 'status'],
    values: ['paid'],
  });
  assert.equal(result.declared, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, { tables: [], columns: [], values: [] });
});

test('compareQuery：缺什么就报什么，多出来的 forbidden 也算失败', () => {
  const missing = compareQuery(QUERY, {
    tables: ['orders', 'order_items'],
    columns: ['amount', 'tier'],
    values: ['refunded'],
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing.tables, ['order_items']);
  assert.deepEqual(missing.missing.columns, ['tier']);
  assert.deepEqual(missing.missing.values, ['refunded']);

  const leaked = compareQuery(QUERY, { mustNot: ['order_items', 'orders'] });
  assert.equal(leaked.ok, false);
  assert.deepEqual(leaked.leaked, ['orders']);
});

test('评测：样例没有查询直接判失败', async () => {
  const report = await evaluateExamples({ entries: [example({ expression: '' })], index: INDEX });
  assert.equal(report.summary.fail, 1);
  assert.equal(report.results[0].status, 'fail');
  assert.match(report.results[0].messages.join(''), /没有查询/);
});

test('评测：没给 runner 时只做结构与覆盖，可执行项跳过', async () => {
  // 先有一条非样例条目讲 orders，覆盖检查才不会因为「只有样例自己引用」而报警
  const documented = {
    id: 2,
    database: 'app',
    kind: 'concept',
    name: '订单',
    aliases: [],
    definition: 'x',
    tables: ['app.main.orders'],
    expression: '',
    severity: 'info',
    payload: {},
    facets: [],
  };
  const report = await evaluateExamples({
    entries: [
      example({
        payload: { expect: { tables: ['orders'], columns: ['amount'] } },
      }),
      documented,
    ],
    index: INDEX,
    runQuery: null,
  });
  const [result] = report.results;
  assert.equal(result.checks.structure.status, 'pass');
  assert.equal(result.checks.runs.status, 'skipped');
  assert.equal(result.checks.grounded.status, 'pass');
  assert.equal(report.ranQueries, false);
  // 结构与覆盖都过了 → 整体通过
  assert.equal(result.status, 'pass');
});

test('评测：runner 抛错时判失败，并带上错误原文', async () => {
  const report = await evaluateExamples({
    entries: [example()],
    index: INDEX,
    runQuery: async () => {
      throw new Error('no such column: amount');
    },
  });
  const [result] = report.results;
  assert.equal(result.checks.runs.status, 'fail');
  assert.equal(result.status, 'fail');
  assert.match(result.messages.join(''), /no such column/);
});

test('评测：结构没声明时跳过结构检查，但可执行照样跑', async () => {
  const report = await evaluateExamples({
    entries: [example()],
    index: INDEX,
    runQuery: async () => {},
  });
  const [result] = report.results;
  assert.equal(result.checks.structure.status, 'skipped');
  assert.equal(result.checks.runs.status, 'pass');
  assert.equal(result.status, 'pass');
  assert.match(result.messages.join(''), /没有声明期望结构/);
});

test('评测：写操作不执行——评测不该有副作用', async () => {
  let called = false;
  const report = await evaluateExamples({
    entries: [example({ expression: 'mutation { delete_orders { id } }' })],
    index: INDEX,
    runQuery: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.equal(report.results[0].checks.runs.status, 'skipped');
  assert.match(report.results[0].messages.join(''), /写操作/);
});

test('评测：问题需要的表没人讲时给警告——模型只能猜', async () => {
  const documented = {
    id: 2,
    database: 'app',
    kind: 'term',
    name: '订单',
    aliases: [],
    definition: 'x',
    tables: ['app.main.orders'],
    expression: '',
    severity: 'info',
    payload: {},
    facets: [],
  };

  const warnReport = await evaluateExamples({
    entries: [
      example({
        // 查询确实用到了两张表，期望与文本一致，问题只剩「有没有人讲」
        expression: '{ orders { amount customers { name } } }',
        payload: { expect: { tables: ['orders', 'customers'] } },
      }),
    ],
    index: INDEX,
  });
  assert.equal(warnReport.results[0].checks.structure.status, 'pass');
  assert.equal(warnReport.results[0].checks.grounded.status, 'warn');
  // 样例自己引用不算数：两张表都没有别的条目讲过
  assert.deepEqual(warnReport.results[0].checks.grounded.uncovered, ['orders', 'customers']);
  assert.equal(warnReport.results[0].status, 'warn');

  const passReport = await evaluateExamples({
    entries: [example({ payload: { expect: { tables: ['orders'] } } }), documented],
    index: INDEX,
  });
  assert.equal(passReport.results[0].checks.grounded.status, 'pass');
});

test('评测：没有 schema 时跳过覆盖检查，而不是瞎报未覆盖', async () => {
  const report = await evaluateExamples({
    entries: [example({ payload: { expect: { tables: ['orders'] } } })],
    index: null,
  });
  assert.equal(report.results[0].checks.grounded.status, 'skipped');
});

test('评测：条目自带 tables 时，没写 expect 也能判覆盖', async () => {
  const documented = {
    id: 3,
    database: 'app',
    kind: 'concept',
    name: '客户',
    aliases: [],
    definition: 'x',
    tables: ['app.main.customers'],
    expression: '',
    severity: 'info',
    payload: {},
    facets: [],
  };
  const report = await evaluateExamples({
    entries: [example({ tables: ['app.main.customers'] }), documented],
    index: INDEX,
  });
  assert.equal(report.results[0].checks.grounded.status, 'pass');
});

test('评测：按库过滤，别的库的样例不进来', async () => {
  const report = await evaluateExamples({
    entries: [example(), example({ id: 2, database: 'analytics' })],
    index: INDEX,
    database: 'app',
  });
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].database, 'app');
});

test('评测：超过上限时截断，并把「还剩多少条」说清楚', async () => {
  const entries = Array.from({ length: MAX_EXAMPLES + 3 }, (_, index) =>
    example({ id: index + 1, name: `样例 ${index + 1}` })
  );
  const report = await evaluateExamples({ entries, index: INDEX });
  assert.equal(report.results.length, MAX_EXAMPLES);
  assert.equal(report.truncated, true);
  assert.equal(report.skippedExamples, 3);
});

test('评测：示例自己引用的表不能自我证明覆盖', async () => {
  // 只有样例自己引用 orders，没有别的条目讲它 → 仍算「没人讲」
  const report = await evaluateExamples({
    entries: [example({ tables: ['app.main.orders'] })],
    index: INDEX,
  });
  assert.equal(report.results[0].checks.grounded.status, 'warn');
});
