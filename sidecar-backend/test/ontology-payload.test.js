'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PayloadError,
  PAYLOAD_KEYS,
  RULE_MODES,
  CARDINALITIES,
  normalizePayload,
  normalizeFacets,
  normalizeValues,
  normalizeWindow,
} = require('../src/ontology-payload');

test('payload：未知键一律拒收，并列出该类可用的键', () => {
  // 允许塞任意键 = payload 退化成第二个 definition，lint 与渲染永远追不上
  assert.throws(
    () => normalizePayload('metric', { currency: 'CNY' }),
    (error) => {
      assert.ok(error instanceof PayloadError);
      assert.match(error.message, /currency/);
      for (const key of PAYLOAD_KEYS.metric) assert.ok(error.message.includes(key));
      return true;
    }
  );

  // 各类之间不能串：term 的键不能给 metric 用
  assert.throws(() => normalizePayload('metric', { values: [] }), PayloadError);
  assert.throws(() => normalizePayload('term', { graphql: '{}' }), PayloadError);
});

test('payload：没有内容时返回空对象，不写一堆空字段', () => {
  assert.deepEqual(normalizePayload('metric', null), {});
  assert.deepEqual(normalizePayload('metric', {}), {});
  assert.deepEqual(normalizePayload('term', { column: '   ' }), {});
  assert.deepEqual(normalizePayload('relation', { from: {}, to: null }), {});
});

test('payload：term 的值域接受纯字符串数组与带标签的对象，去重去空', () => {
  const values = normalizeValues(['paid', ' paid ', '', null, { value: 'refunded', label: '已退款' }]);
  assert.deepEqual(values, [
    { value: 'paid' },
    { value: 'refunded', label: '已退款' },
  ]);
});

test('payload：values / window 形状不对时报错而不是静默忽略', () => {
  assert.throws(() => normalizeValues('paid'), PayloadError);
  assert.throws(() => normalizeWindow('created_at'), PayloadError);
  assert.deepEqual(normalizeWindow({ column: 'created_at', tz: '', period: 'month' }), {
    column: 'created_at',
    period: 'month',
  });
});

test('payload：relation 允许只填一半（先记下来再补），但不认识非法基数', () => {
  // 只填起点是常见的中间状态：拦住它等于逼人现在就编一个假列名
  assert.deepEqual(normalizePayload('relation', { from: { table: 'app.main.orders' } }), {
    from: { table: 'app.main.orders' },
  });

  assert.deepEqual(
    normalizePayload('relation', {
      from: { table: 'app.main.orders', column: 'customer_id' },
      to: { table: 'app.main.customers', column: 'id' },
      cardinality: 'many-to-one',
      alias: 'customer',
    }),
    {
      from: { table: 'app.main.orders', column: 'customer_id' },
      to: { table: 'app.main.customers', column: 'id' },
      cardinality: 'many-to-one',
      alias: 'customer',
    }
  );

  assert.throws(
    () => normalizePayload('relation', { cardinality: 'n-to-m' }),
    new RegExp(CARDINALITIES.join('|'))
  );
});

test('payload：规则的形态只认四种可执行形态，强度只由 severity 说', () => {
  assert.deepEqual(normalizePayload('rule', {}), {});
  assert.deepEqual(
    normalizePayload('rule', {
      mode: 'filter',
      on: { table: 'app.main.orders' },
      predicate: '{ status: { _eq: "voided" } }',
    }),
    { mode: 'filter', on: { table: 'app.main.orders' }, predicate: '{ status: { _eq: "voided" } }' }
  );
  assert.throws(() => normalizePayload('rule', { mode: 'block-writes' }), /mode 只能是/);

  // 早期版本的 scope / effect 现在会被拒：它们与 mode 描述同一件事，混着存必然自相矛盾
  assert.throws(() => normalizePayload('rule', { scope: 'read' }), /不支持扩展字段/);
  assert.throws(() => normalizePayload('rule', { effect: 'deny' }), /不支持扩展字段/);
});

test('payload：metric 的粒度 / 单位 / 窗口 / 可执行片段都可缺省', () => {
  assert.deepEqual(normalizePayload('metric', { grain: '每运单', unit: '小时' }), {
    grain: '每运单',
    unit: '小时',
  });
  assert.deepEqual(
    normalizePayload('metric', {
      graphql: '{ orders { amount } }',
      window: { column: 'created_at', tz: 'Asia/Shanghai' },
    }),
    { graphql: '{ orders { amount } }', window: { column: 'created_at', tz: 'Asia/Shanghai' } }
  );
});

test('payload：example 只有 notes 与期望结构两个字段', () => {
  assert.deepEqual(normalizePayload('example', { notes: '按 tier 分组' }), { notes: '按 tier 分组' });
  assert.throws(() => normalizePayload('example', { graphql: '{}' }), PayloadError);
});

test('payload：样例的期望结构按白名单校验，去空白去重', () => {
  assert.deepEqual(
    normalizePayload('example', {
      expect: {
        tables: ['app.main.orders', 'orders'],
        columns: [' amount ', 'amount'],
        values: ['paid'],
        mustNot: ['order_items'],
      },
    }),
    {
      expect: {
        tables: ['app.main.orders', 'orders'],
        columns: ['amount'],
        values: ['paid'],
        mustNot: ['order_items'],
      },
    }
  );

  // 未知键必须拒收：expect 里塞别的键，评测就会对一份它并不理解的基准做断言
  assert.throws(() => normalizePayload('example', { expect: { joins: ['x'] } }), /expect 不支持/);
  assert.throws(() => normalizePayload('example', { expect: { tables: 'orders' } }), /必须是数组/);
  assert.throws(() => normalizePayload('example', { expect: [] }), /必须是对象/);
  // 空对象等于没写，不落库
  assert.deepEqual(normalizePayload('example', { expect: {} }), {});
});

test('payload：未知 kind 直接报错（自定义 kind 的门在 save 那层已经关了）', () => {
  assert.throws(() => normalizePayload('diagnosis', {}), /未知类别/);
});

test('facets：只做形状校验——键非空、值必须是标量、键不重复', () => {
  assert.deepEqual(
    normalizeFacets([
      { key: '编码体系', value: 'ICD-10' },
      { key: '版本', value: 2024, label: '年度' },
      { key: '', value: 'x' },
      null,
    ]),
    [
      { key: '编码体系', value: 'ICD-10' },
      { key: '版本', value: 2024, label: '年度' },
    ]
  );

  assert.throws(() => normalizeFacets([{ key: 'a', value: { deep: 1 } }]), /只能是文本、数字或真假/);
  assert.throws(
    () => normalizeFacets([{ key: 'a', value: 1 }, { key: 'a', value: 2 }]),
    /重复/
  );
  assert.throws(() => normalizeFacets('x=1'), /必须是数组/);
});
