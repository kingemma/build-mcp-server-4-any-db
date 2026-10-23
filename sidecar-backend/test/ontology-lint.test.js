'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RULES,
  lintOntology,
  canonicalTableRef,
  buildTableIndex,
  resolveTableRef,
} = require('../src/ontology-lint');

/** 一张有 database + schema 的表：规范形式是三段 */
const TABLE = { database: 'app', schema: 'main', name: 'orders' };
/** 同一个库里的第二张表：用来构造「简写能对上多张表」的歧义 */
const TABLE_SIBLING = { database: 'app', schema: 'archive', name: 'orders' };

function schemaWith(tables) {
  return { tables, relationships: [] };
}

/** 只取某条规则的发现，避免其它规则（如覆盖率）干扰断言 */
function byRule(result, rule) {
  return result.issues.filter((issue) => issue.rule === rule);
}

test('canonicalTableRef：规范形式由 schema 实际拥有的身份段拼成，不硬编码段数', () => {
  assert.equal(canonicalTableRef(TABLE), 'app.main.orders');
  // 有的源没有 database 段（或某个引擎没有 schema 段）：规范形式必须跟着它变
  assert.equal(canonicalTableRef({ schema: 'main', name: 'orders' }), 'main.orders');
  assert.equal(canonicalTableRef({ database: 'app', name: 'orders' }), 'app.orders');
  assert.equal(canonicalTableRef({ name: 'orders' }), 'orders');
  assert.equal(canonicalTableRef({ name: '   ' }), '');
  assert.equal(canonicalTableRef(null), '');
});

test('resolveTableRef：规范形式 exact、简写 partial、多表命中 ambiguous、查无此表 missing', () => {
  const index = buildTableIndex(schemaWith([TABLE]));

  assert.equal(resolveTableRef(index, 'app.main.orders').status, 'exact');

  const partial = resolveTableRef(index, 'app.orders');
  assert.equal(partial.status, 'partial');
  assert.equal(partial.canonical, 'app.main.orders');

  assert.equal(resolveTableRef(index, 'nope.orders').status, 'missing');

  const ambiguousIndex = buildTableIndex(schemaWith([TABLE, TABLE_SIBLING]));
  const ambiguous = resolveTableRef(ambiguousIndex, 'app.orders');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.tables.length, 2);
  // 三段式仍然唯一
  assert.equal(resolveTableRef(ambiguousIndex, 'app.archive.orders').status, 'exact');
});

test('lint：规范引用不报错，简写给出可执行的改法', () => {
  const schema = schemaWith([TABLE, { database: 'app', schema: 'main', name: 'customers' }]);
  const entries = [
    {
      id: 1,
      database: 'app',
      kind: 'term',
      name: '下单',
      aliases: ['购买'],
      definition: '产生一张订单',
      tables: ['app.main.orders'],
      expression: '',
      severity: 'info',
    },
    {
      id: 2,
      database: 'app',
      kind: 'term',
      name: '客户',
      aliases: ['买家'],
      definition: '付费主体',
      tables: ['app.customers'],
      expression: '',
      severity: 'info',
    },
  ];

  const result = lintOntology(entries, { schema });

  assert.equal(byRule(result, 'stale-reference').length, 0);
  const format = byRule(result, 'table-ref-format');
  assert.equal(format.length, 1);
  assert.equal(format[0].entryId, 2);
  // 提示必须直接给到能抄的写法，而不是只说「不规范」
  assert.match(format[0].hint, /app\.main\.customers/);
  // 覆盖率：两张表都被引用到，不该报缺口
  assert.equal(byRule(result, 'coverage-gap').length, 0);
});

test('lint：引用的表不存在时报 stale-reference（本体论腐烂）', () => {
  const entries = [
    {
      id: 3,
      database: 'app',
      kind: 'concept',
      name: '订单',
      aliases: [],
      definition: '购买意图',
      tables: ['app.main.orders_v1'],
      expression: '',
      severity: 'info',
    },
  ];

  const result = lintOntology(entries, { schema: schemaWith([TABLE]) });
  const stale = byRule(result, 'stale-reference');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].level, 'error');
  assert.equal(stale[0].entryName, '订单');
});

test('lint：简写能对上多张表时报歧义，而不是猜一个', () => {
  const entries = [
    {
      id: 4,
      database: 'app',
      kind: 'term',
      name: '订单',
      aliases: [],
      definition: 'x',
      tables: ['app.orders'],
      expression: '',
      severity: 'info',
    },
  ];

  const result = lintOntology(entries, { schema: schemaWith([TABLE, TABLE_SIBLING]) });
  const ambiguous = byRule(result, 'ambiguous-reference');
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].level, 'error');
});

test('lint：条目归属的库与引用表所在的库不一致时提示', () => {
  const entries = [
    {
      id: 5,
      database: 'analytics',
      kind: 'term',
      name: '订单',
      aliases: [],
      definition: 'x',
      tables: ['app.main.orders'],
      expression: '',
      severity: 'info',
    },
  ];

  const result = lintOntology(entries, { schema: schemaWith([TABLE]) });
  const cross = byRule(result, 'cross-database-reference');
  assert.equal(cross.length, 1);
  assert.equal(cross[0].level, 'warn');
});

test('lint：强制规则必须能被执行——缺形态 / 缺目标 / 缺判据都算错误', () => {
  const base = {
    database: 'app',
    kind: 'rule',
    aliases: [],
    tables: [],
    expression: '',
    severity: 'enforce',
  };
  const entries = [
    // 只有人话：没有形态
    { ...base, id: 6, name: '金额恒为正', definition: '写入前校验', payload: {} },
    // 形态完整，可以编译
    {
      ...base,
      id: 7,
      name: '只看未作废',
      definition: '',
      payload: {
        mode: 'filter',
        on: { table: 'app.main.orders' },
        predicate: '{ status: { _eq: "voided" } }',
      },
    },
    // 选读筛选却没给判据
    {
      ...base,
      id: 8,
      name: '读筛选缺判据',
      definition: 'x',
      payload: { mode: 'filter', on: { table: 'app.main.orders' } },
    },
    // 选隐藏列却没指定列
    {
      ...base,
      id: 9,
      name: '隐藏列缺列',
      definition: 'x',
      payload: { mode: 'hide-column', on: { table: 'app.main.orders' } },
    },
  ];

  const result = lintOntology(entries);
  const codable = byRule(result, 'enforce-not-codable');
  assert.deepEqual(
    codable.map((item) => item.entryId),
    [6, 8, 9]
  );
  assert.ok(codable.every((item) => item.level === 'error'));
  assert.match(codable[0].hint, /降为「提醒」/);
});

test('lint：指标没有计算式时报错误，有计算式时安静', () => {
  const entries = [
    {
      id: 8,
      database: 'app',
      kind: 'metric',
      name: '均值',
      aliases: [],
      definition: '各行的平均',
      tables: [],
      expression: '',
      severity: 'info',
    },
    {
      id: 9,
      database: 'app',
      kind: 'metric',
      name: '有式子',
      aliases: [],
      definition: '',
      tables: [],
      expression: 'avg(x)',
      severity: 'info',
    },
  ];

  const result = lintOntology(entries);
  const metrics = byRule(result, 'metric-no-formula');
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].entryId, 8);
});

test('lint：同一说法指向两个条目时只报一条冲突', () => {
  const entries = [
    {
      id: 10,
      database: 'app',
      kind: 'term',
      name: '客户',
      aliases: ['买家'],
      definition: 'a',
      tables: [],
      expression: '',
      severity: 'info',
    },
    {
      id: 11,
      database: 'app',
      kind: 'concept',
      name: '客户',
      aliases: [],
      definition: 'b',
      tables: ['app.main.customers'],
      expression: '',
      severity: 'info',
    },
  ];

  const result = lintOntology(entries);
  const conflicts = byRule(result, 'alias-conflict');
  assert.equal(conflicts.length, 1);

  // 别的库里同名不算冲突：跨库不同义是设计允许的
  const otherDatabase = lintOntology([
    { ...entries[0] },
    { ...entries[1], id: 12, database: 'analytics' },
  ]);
  assert.equal(byRule(otherDatabase, 'alias-conflict').length, 0);
});

test('lint：术语没别名、概念没表各自提示，级别不同', () => {
  const result = lintOntology([
    {
      id: 13,
      database: 'app',
      kind: 'term',
      name: '孤词',
      aliases: [],
      definition: 'x',
      tables: [],
      expression: '',
      severity: 'info',
    },
    {
      id: 14,
      database: 'app',
      kind: 'concept',
      name: '悬空概念',
      aliases: [],
      definition: 'x',
      tables: [],
      expression: '',
      severity: 'info',
    },
  ]);

  assert.equal(byRule(result, 'term-no-alias')[0].level, 'info');
  assert.equal(byRule(result, 'concept-no-table')[0].level, 'warn');
});

test('lint：覆盖率缺口聚合成一条，不按表刷屏', () => {
  const tables = Array.from({ length: 20 }, (_, index) => ({
    database: 'app',
    schema: 'main',
    name: `t${index}`,
  }));
  const entries = [
    {
      id: 15,
      database: 'app',
      kind: 'term',
      name: '只引用一张',
      aliases: [],
      definition: 'x',
      tables: ['app.main.t0'],
      expression: '',
      severity: 'info',
    },
  ];

  const result = lintOntology(entries, { schema: schemaWith(tables) });
  const gaps = byRule(result, 'coverage-gap');
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].message, /19 张表/);
});

test('lint：没有 schema 时跳过依赖 schema 的规则，并说明跳过了什么', () => {
  const result = lintOntology(
    [
      {
        id: 16,
        database: 'app',
        kind: 'term',
        name: 'x',
        aliases: [],
        definition: 'y',
        tables: ['whatever'],
        expression: '',
        severity: 'info',
      },
    ],
    { schema: null }
  );

  const skippedIds = result.skipped.map((item) => item.id);
  assert.ok(skippedIds.includes('stale-reference'));
  assert.ok(skippedIds.includes('coverage-gap'));
  // 不依赖 schema 的规则照跑
  assert.ok(!skippedIds.includes('term-no-alias'));
  assert.equal(byRule(result, 'term-no-alias').length, 1);
  // 跳过必须有理由，否则「没报错」会被读成「没问题」
  assert.match(result.skipped[0].reason, /schema/);
  // rules 里带上 active 标记，UI 才能把「没跑」和「跑了没问题」区分开
  const stale = result.rules.find((rule) => rule.id === 'stale-reference');
  assert.equal(stale.active, false);
});

test('lint：按级别排序，避免错误被埋在提示后面', () => {
  const result = lintOntology(
    [
      {
        id: 17,
        database: 'app',
        kind: 'term',
        name: '甲',
        aliases: [],
        definition: 'x',
        tables: [],
        expression: '',
        severity: 'info',
      },
      {
        id: 18,
        database: 'app',
        kind: 'metric',
        name: '乙',
        aliases: [],
        definition: '',
        tables: [],
        expression: '',
        severity: 'info',
      },
    ],
    { schema: null }
  );

  assert.equal(result.issues[0].level, 'error');
  assert.equal(result.summary.error, 1);
  assert.equal(result.summary.info, 1);
  assert.equal(result.summary.total, 2);
});

/**
 * 反形状 fixture：故意不像任何具体行业，也不像「交易型数据库」的标准形状。
 *
 * 目的不是测某条规则，而是守住通用性：没有外键、没有日期列、没有金额列、
 * 表名是中文、列名不叫 id、跨 12 个库——render 与 lint 都必须照常工作。
 * 一条会失败的测试，比一句「支持任意行业」的承诺硬。
 */
const ANTI_SHAPE_SCHEMA = schemaWith(
  Array.from({ length: 12 }, (_, index) => ({
    database: `库${index}`,
    schema: index % 3 === 0 ? '' : '主',
    name: index % 2 === 0 ? `观测记录${index}` : `sample_${index}`,
    columns: [{ name: '读数', type: 'text', comment: '' }],
  }))
);

const ANTI_SHAPE_ENTRIES = ANTI_SHAPE_SCHEMA.tables.slice(0, 4).map((table, index) => ({
  id: index + 1,
  database: table.database,
  kind: index % 2 === 0 ? 'term' : 'concept',
  name: `说法${index}`,
  aliases: [`别名${index}`],
  definition: '一句不含任何行业惯例的说明',
  tables: [canonicalTableRef(table)],
  expression: '',
  severity: 'info',
}));

test('反形状 fixture：无外键 / 无时间 / 无金额 / 中文名 / 12 个库，lint 与引用解析都不出错', () => {
  const result = lintOntology(ANTI_SHAPE_ENTRIES, { schema: ANTI_SHAPE_SCHEMA });

  // 引用都是规范形式，一条 stale / format / ambiguous 都不该有
  assert.equal(byRule(result, 'stale-reference').length, 0);
  assert.equal(byRule(result, 'table-ref-format').length, 0);
  assert.equal(byRule(result, 'ambiguous-reference').length, 0);
  // schema 有 12 张表，条目只引用了 4 张：覆盖率应当报缺口，且只有一条
  assert.equal(byRule(result, 'coverage-gap').length, 1);
  // 没有任何「必须有某列」之类的假设，所以不该凭空产生错误
  assert.equal(result.summary.error, 0);
});

test('反形状 fixture：规则集本身不含任何行业假设', () => {
  // 这条断言防的是「顺手加一条规则」：规则文案里一旦出现某个行业的概念，
  // 别的行业就会被这套体检全红
  const forbidden = /amount|currency|fiscal|revenue|status|created_at|patient|order/i;
  for (const rule of RULES) {
    assert.ok(
      !forbidden.test(rule.id) && !forbidden.test(rule.title),
      `规则 ${rule.id} / ${rule.title} 里出现了行业假设`
    );
  }
  // 每条规则都要说明它需不需要 schema，否则降级时会静默跳过
  for (const rule of RULES) {
    assert.equal(typeof rule.needsSchema, 'boolean', `${rule.id} 缺少 needsSchema`);
    assert.ok(['error', 'warn', 'info'].includes(rule.level), `${rule.id} 级别非法`);
  }
});

test('反形状 fixture：空输入与脏输入不炸', () => {
  assert.doesNotThrow(() => lintOntology([]));
  assert.doesNotThrow(() => lintOntology([null, undefined, {}, 1]));
  const dirty = lintOntology([{ id: 1, database: 'x', kind: 'term', name: 'n', tables: 'not-an-array' }]);
  assert.ok(Array.isArray(dirty.issues));
});

// ---------------------------------------------------------------------------
// P1：关系 / 样例 / 列绑定 / 指标可执行片段
// ---------------------------------------------------------------------------

const ORDERS = {
  database: 'app',
  schema: 'main',
  name: 'orders',
  columns: [{ name: 'id' }, { name: 'customer_id' }, { name: 'amount' }],
};
const CUSTOMERS = {
  database: 'app',
  schema: 'main',
  name: 'customers',
  columns: [{ name: 'id' }, { name: 'name' }],
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

function relationEntry(payload, overrides = {}) {
  return {
    id: 100,
    database: 'app',
    kind: 'relation',
    name: '下单人',
    aliases: [],
    definition: '把订单归到买家名下',
    tables: [],
    expression: '',
    severity: 'info',
    payload,
    facets: [],
    ...overrides,
  };
}

test('lint：关系缺一端时报 relation-incomplete，并列出缺了什么', () => {
  const result = lintOntology([relationEntry({ from: { table: 'app.main.orders' } })]);
  const incomplete = byRule(result, 'relation-incomplete');
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0].message, /起点列/);
  assert.match(incomplete[0].message, /目标表/);
});

test('lint：关系两端都能对上 schema 与外键时不报错', () => {
  const result = lintOntology(
    [
      relationEntry({
        from: { table: 'app.main.orders', column: 'customer_id' },
        to: { table: 'app.main.customers', column: 'id' },
        cardinality: 'many-to-one',
      }),
    ],
    { schema: { tables: [ORDERS, CUSTOMERS], relationships: [FK] } }
  );
  assert.equal(byRule(result, 'relation-edge').length, 0);
});

test('lint：schema 有外键信息时，对不上的关系要报错', () => {
  const wrongPair = relationEntry({
    from: { table: 'app.main.orders', column: 'amount' },
    to: { table: 'app.main.customers', column: 'id' },
  });
  const result = lintOntology([wrongPair], {
    schema: { tables: [ORDERS, CUSTOMERS], relationships: [FK] },
  });
  const edges = byRule(result, 'relation-edge');
  assert.equal(edges.length, 1);
  assert.match(edges[0].message, /没有/);
});

test('lint：没有外键信息的库只校验列，不硬要求外键——否则这类库会全红', () => {
  const edge = relationEntry({
    from: { table: 'app.main.orders', column: 'customer_id' },
    to: { table: 'app.main.customers', column: 'id' },
  });
  const withoutRelationships = lintOntology([edge], {
    schema: { tables: [ORDERS, CUSTOMERS], relationships: [] },
  });
  assert.equal(byRule(withoutRelationships, 'relation-edge').length, 0);

  // 但列真的不存在时照样报——这不是「姑且放过」
  const badColumn = relationEntry({
    from: { table: 'app.main.orders', column: 'nope' },
    to: { table: 'app.main.customers', column: 'id' },
  });
  const strict = lintOntology([badColumn], {
    schema: { tables: [ORDERS, CUSTOMERS], relationships: [] },
  });
  assert.equal(byRule(strict, 'relation-edge').length, 1);
});

test('lint：关系指向不存在的表时直接报错', () => {
  const result = lintOntology(
    [
      relationEntry({
        from: { table: 'app.main.nope', column: 'id' },
        to: { table: 'app.main.customers', column: 'id' },
      }),
    ],
    { schema: { tables: [ORDERS, CUSTOMERS], relationships: [FK] } }
  );
  assert.equal(byRule(result, 'relation-edge').length, 1);
});

test('lint：术语绑定的列要能解析，格式不对也给明确提示', () => {
  const good = {
    id: 101,
    database: 'app',
    kind: 'term',
    name: '成交额',
    aliases: ['金额'],
    definition: '订单金额',
    tables: ['app.main.orders'],
    expression: '',
    severity: 'info',
    payload: { column: 'app.main.orders.amount' },
  };
  const badFormat = { ...good, id: 102, name: '只说列名', payload: { column: 'amount' } };
  const badColumn = { ...good, id: 103, name: '列不存在', payload: { column: 'app.main.orders.nope' } };

  const result = lintOntology([good, badFormat, badColumn], {
    schema: { tables: [ORDERS, CUSTOMERS], relationships: [FK] },
  });
  const issues = byRule(result, 'term-column');
  assert.equal(issues.length, 2);
  assert.ok(issues.some((issue) => /不是「表\.列」的形式/.test(issue.message)));
  assert.ok(issues.some((issue) => /nope/.test(issue.message)));
});

test('lint：样例没有查询时报警——只有问题等于零样本', () => {
  const base = {
    id: 104,
    database: 'app',
    kind: 'example',
    name: '上月各站点平均履约时长是多少？',
    aliases: [],
    definition: '',
    tables: [],
    severity: 'info',
  };
  const empty = lintOntology([{ ...base, expression: '' }]);
  assert.equal(byRule(empty, 'example-without-query').length, 1);

  const filled = lintOntology([{ ...base, expression: '{ shipments { hub_id } }' }]);
  assert.equal(byRule(filled, 'example-without-query').length, 0);
});

test('lint：指标给了可执行片段就不算「没有计算式」', () => {
  const entry = {
    id: 105,
    database: 'app',
    kind: 'metric',
    name: '平均履约时长',
    aliases: [],
    definition: '从揽收到签收',
    tables: [],
    expression: '',
    severity: 'info',
    payload: { graphql: '{ shipments { delivered_at picked_up_at } }' },
  };
  const result = lintOntology([entry]);
  assert.equal(byRule(result, 'metric-no-formula').length, 0);
});

test('lint：正文超过上限时提醒拆分（渲染会截断）', () => {
  // 渲染时超过 1000 字会截断；截断意味着「写进去的没送达」，所以要在体检里先说
  const result = lintOntology([
    {
      id: 70,
      database: 'app',
      kind: 'term',
      name: '长条目',
      aliases: ['长'],
      definition: 'x'.repeat(1200),
      tables: [],
      expression: '',
      severity: 'info',
      payload: {},
      facets: [],
    },
  ]);
  const tooLong = byRule(result, 'entry-too-long');
  assert.equal(tooLong.length, 1);
  assert.match(tooLong[0].message, /超过 1000 字上限/);
  assert.match(tooLong[0].hint, /拆成多条/);
});
