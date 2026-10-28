import test from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_TOOL_ORDER, MAX_DEMO_ATTEMPTS, buildDemoArgs, repairAttempt } from './mcp-demo.js';

const CONTEXT = { database: 'finance', table: 'accounts', column: 'id', concept: '会计科目' };

test('AI Demo：测试数据用当前项目的真实表名，不写死表', () => {
  const gql = buildDemoArgs('execute_graphql', CONTEXT);
  assert.equal(gql.query, '{ accounts(limit: 1) { id } }');

  assert.deepEqual(buildDemoArgs('validate_where_clause', CONTEXT), {
    table: 'accounts',
    where: { id: { gt: 0 } },
  });
  assert.deepEqual(buildDemoArgs('query_catalog', CONTEXT), { search: 'accounts' });
  assert.deepEqual(buildDemoArgs('describe_business_object', CONTEXT), { name: '会计科目' });
});

test('AI Demo：没有 schema 时不编造表名，交给报错去修', () => {
  assert.deepEqual(buildDemoArgs('execute_graphql', {}), {});
  assert.deepEqual(buildDemoArgs('query_catalog', {}), {});
  assert.deepEqual(buildDemoArgs('describe_business_object', {}), { name: '' });
});

test('AI Demo：目录外的新工具给空参数，不猜', () => {
  assert.deepEqual(buildDemoArgs('some_new_tool', CONTEXT), {});
  assert.deepEqual(buildDemoArgs('validate_config', CONTEXT), {});
  assert.deepEqual(buildDemoArgs('graphql_help', CONTEXT), { for: 'discovery' });
  // 只问 sources 一节：整份配置里有库连接串，不该倒进面板
  assert.deepEqual(buildDemoArgs('get_current_config', CONTEXT), { section: 'sources' });
});

test('AI Demo：目录里列出的工具顺序稳定，且都是已知形态', () => {
  assert.equal(new Set(DEMO_TOOL_ORDER).size, DEMO_TOOL_ORDER.length);
  for (const name of DEMO_TOOL_ORDER) {
    assert.equal(typeof buildDemoArgs(name, CONTEXT), 'object', `${name} 没有测试数据`);
  }
  assert.ok(MAX_DEMO_ATTEMPTS >= 2);
});

test('AI Demo：角色不存在时换 admin', () => {
  const fix = repairAttempt({
    args: { search: 'accounts' },
    role: 'writer',
    error: "roles 'writer' not defined in c.gj.config",
  });
  assert.equal(fix.role, 'admin');
  assert.equal(fix.reason, 'roleFallback');
});

test('AI Demo：缺必填参数时按 schema 枚举补上', () => {
  const fix = repairAttempt({
    args: {},
    role: 'admin',
    error: 'validating "arguments": validating root: required: missing properties: ["for"]',
    context: CONTEXT,
    inputSchema: { properties: { for: { type: 'string', enum: ['discovery', 'query'] } } },
  });
  assert.deepEqual(fix.args, { for: 'discovery' });
  assert.equal(fix.reason, 'addedRequired');
});

test('AI Demo：缺必填参数时也能按当前 schema 造出 table / where', () => {
  const fix = repairAttempt({
    args: {},
    role: 'admin',
    error: 'validating root: missing properties: ["table", "where"]',
    context: CONTEXT,
  });
  assert.deepEqual(fix.args, { table: 'accounts', where: { id: { gt: 0 } } });
});

test('AI Demo：补不出必填参数时宁可放弃，不瞎填', () => {
  const fix = repairAttempt({
    args: {},
    role: 'admin',
    error: 'validating root: missing properties: ["user"]',
    context: CONTEXT,
    inputSchema: { properties: { user: { type: 'object' } } },
  });
  assert.equal(fix, null);
});

test('AI Demo：多余参数按报错删掉', () => {
  const fix = repairAttempt({
    args: { kind: 'metric', nope: 1 },
    role: 'admin',
    error: 'validating "arguments": additional properties \'nope\' not allowed',
  });
  assert.deepEqual(fix.args, { kind: 'metric' });
  assert.equal(fix.reason, 'droppedUnknown');
});

test('AI Demo：查无此表时换成真实表名', () => {
  const unknownField = repairAttempt({
    args: { query: '{ orders(limit: 1) { id } }' },
    role: 'admin',
    error: 'Cannot query field "orders" on type "Query".',
    context: CONTEXT,
  });
  assert.equal(unknownField.args.query, '{ accounts(limit: 1) { id } }');
  assert.equal(unknownField.reason, 'tableFallback');

  const sqlError = repairAttempt({
    args: { table: 'orders', where: { id: { gt: 0 } } },
    role: 'admin',
    error: 'no such table: orders',
    context: CONTEXT,
  });
  assert.equal(sqlError.args.table, 'accounts');
});

test('AI Demo：GraphJin 的 table not found 用报错自带的可用表清单兜底', () => {
  // 没有加载 schema（context 里没表名）时，只能靠报错清单
  const fix = repairAttempt({
    args: { query: '{ no_such_table(limit: 1) { id } }' },
    role: 'admin',
    error:
      'table not found: main.no_such_table; available tables: accounts, invoices, payments; suggestion: check spelling',
    context: {},
  });
  assert.equal(fix.args.query, '{ accounts(limit: 1) { id } }');
  assert.equal(fix.reason, 'tableFallback');
  assert.deepEqual(fix.detail, { from: 'no_such_table', to: 'accounts' });
});

test('AI Demo：查无此列时换成主键列', () => {
  const fix = repairAttempt({
    args: { query: '{ accounts(limit: 1) { account_no } }' },
    role: 'admin',
    error: 'Cannot query field "account_no" on type "accounts".',
    context: CONTEXT,
  });
  assert.equal(fix.args.query, '{ accounts(limit: 1) { id } }');
  assert.equal(fix.reason, 'columnFallback');
});

test('AI Demo：报错读不出确定答案时返回 null（保持原始失败）', () => {
  assert.equal(
    repairAttempt({ args: {}, role: 'admin', error: 'failed to connect: dial tcp 127.0.0.1:1' }),
    null
  );
  assert.equal(repairAttempt({ args: {}, role: 'admin', error: '   ' }), null);
  // 表名已经就是真实表：没有可改的，别伪装成修过
  assert.equal(
    repairAttempt({
      args: { query: '{ accounts(limit: 1) { id } }' },
      role: 'admin',
      error: 'Cannot query field "accounts" on type "Query".',
      context: CONTEXT,
    }),
    null
  );
});
