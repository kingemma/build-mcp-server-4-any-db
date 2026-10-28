'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createMcpGateway, ONTOLOGY_TOOL_NAME, DESCRIBE_TOOL_NAME } = require('../src/mcp-gateway');
const { parseSseMessages } = require('../src/mcp-client');
const { signToken } = require('../src/jwt');

const SECRET = 'gateway-test-secret-0123456789';

const ONTOLOGY = {
  document: '# 业务本体论\n\n## 数据库 app\n\n## 术语表\n- **买家** — 平台的付费主体',
  // 握手只给目录；目录里不该出现具体条目的正文（那是 D6 的核心）
  catalog: '# 业务本体论（目录）\n\n## 库 app\n术语 2\n\n## 库 analytics\n指标 1',
  databases: ['app', 'analytics'],
  entries: [
    {
      id: 1,
      database: 'app',
      kind: 'term',
      name: '买家',
      aliases: ['客户'],
      definition: '平台的付费主体',
      tables: ['app.main.customers'],
    },
    {
      id: 2,
      database: 'analytics',
      kind: 'metric',
      name: 'GMV',
      definition: '已支付金额合计',
      tables: ['app.main.orders'],
    },
    {
      id: 3,
      database: 'app',
      kind: 'concept',
      name: '客户',
      definition: '会复购的人',
      tables: ['app.main.customers'],
    },
  ],
  render: ({ kind = null, database = null } = {}) => {
    const picked = ONTOLOGY.entries.filter(
      (entry) => (!kind || entry.kind === kind) && (database === null || entry.database === database)
    );
    if (picked.length === 0) return '';
    return `# 业务本体论\n${picked.map((entry) => `- ${entry.name}`).join('\n')}`;
  },
  renderEntries: (list) => `# 业务本体论\n${list.map((entry) => `- ${entry.name}`).join('\n')}`,
};

/** 让假上游按 JSON-RPC 方法返回对应结果，方便验证合并逻辑 */
function startRpcUpstream() {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let method = 'unknown';
      try {
        method = JSON.parse(Buffer.concat(chunks).toString('utf8')).method ?? 'unknown';
      } catch {
        // 非 JSON 请求体：按 unknown 处理
      }
      const results = {
        initialize: { protocolVersion: '2025-06-18', serverInfo: { name: 'graphjin' }, capabilities: {} },
        'tools/list': {
          tools: [
            { name: 'execute_graphql', description: 'run graphql' },
            { name: 'ask_graphjin_agent', description: 'Ask GraphJin to answer a question' },
          ],
        },
      };
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: results[method] ?? { ok: true },
      });
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Mcp-Session-Id': 'session-from-graphjin',
      });
      response.end(`event: message\ndata: ${payload}\n\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * 起一个假的 GraphJin：把收到的请求头和请求体原样回显。
 *
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>}
 */
function startUpstream() {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = JSON.stringify({
        headers: request.headers,
        method: request.method,
        body,
      });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-from-graphjin' });
      response.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** 起一个只转发到网关的本地服务，模拟平台对外的 /api/v1/mcp */
function startDownstream(gateway) {
  const server = http.createServer((request, response) => {
    if ((request.url ?? '').startsWith(gateway.path)) {
      gateway.handle(request, response).catch(() => response.end());
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}/api/v1/mcp`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function setup({ targetUrl = null } = {}) {
  const upstream = await startUpstream();
  const gateway = createMcpGateway({
    secret: SECRET,
    resolveTarget: () => targetUrl ?? upstream.baseUrl,
  });
  const downstream = await startDownstream(gateway);
  return {
    upstream,
    downstream,
    async close() {
      await downstream.close();
      await upstream.close();
    },
  };
}

test('网关：没有令牌返回 401', async () => {
  const ctx = await setup();
  try {
    const response = await fetch(ctx.downstream.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.match(body.error.message, /缺少令牌/);
  } finally {
    await ctx.close();
  }
});

test('网关：签名不对返回 401', async () => {
  const ctx = await setup();
  try {
    const forged = signToken({ role: 'admin' }, 'wrong-secret', 60);
    const response = await fetch(ctx.downstream.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${forged}` },
      body: '{}',
    });
    assert.equal(response.status, 401);
  } finally {
    await ctx.close();
  }
});

test('网关：有效令牌被翻译成 GraphJin 的身份头', async () => {
  const ctx = await setup();
  try {
    const token = signToken(
      { sub: '1', role: 'customer', user_code: 'user-a@demo.local' },
      SECRET,
      60
    );
    const response = await fetch(ctx.downstream.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        // 客户端自带的身份头必须被丢弃，否则等于可以自称 admin
        'X-User-Role': 'admin',
        'X-User-Code': 'user-b@demo.local',
        'Mcp-Session-Id': 'session-1',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 200);
    // 上游设的会话头要回传给客户端，否则后续调用接不上
    assert.equal(response.headers.get('mcp-session-id'), 'session-from-graphjin');

    const echoed = await response.json();
    assert.equal(echoed.headers['x-user-role'], 'customer');
    assert.equal(echoed.headers['x-user-code'], 'user-a@demo.local');
    assert.equal(echoed.headers.authorization, undefined);
    assert.equal(echoed.headers['mcp-session-id'], 'session-1');
  } finally {
    await ctx.close();
  }
});

test('网关：GraphJin 未运行时返回 503', async () => {
  const ctx = await setup();
  try {
    const gateway = createMcpGateway({ secret: SECRET, resolveTarget: () => null });
    const downstream = await startDownstream(gateway);
    const token = signToken({ role: 'customer' }, SECRET, 60);
    const response = await fetch(downstream.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    assert.equal(response.status, 503);
    await downstream.close();
  } finally {
    await ctx.close();
  }
});

test('网关：GET（SSE）也能透传', async () => {
  const ctx = await setup();
  try {
    const token = signToken({ role: 'customer', user_code: 'user-a@demo.local' }, SECRET, 60);
    const response = await fetch(ctx.downstream.baseUrl, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const echoed = await response.json();
    assert.equal(echoed.method, 'GET');
    assert.equal(echoed.headers['x-user-role'], 'customer');
  } finally {
    await ctx.close();
  }
});

/** 起一个带本体论的网关 + JSON-RPC 假上游。target: 'upstream' | 'none' | URL */
async function setupWithOntology({ ontology = ONTOLOGY, target = 'upstream' } = {}) {
  const upstream = await startRpcUpstream();
  const gateway = createMcpGateway({
    secret: SECRET,
    // 不能用 `??`：null ?? upstream.baseUrl 会回落到上游，表达不出「GraphJin 不在线」
    resolveTarget: () =>
      target === 'none' ? null : target === 'upstream' ? upstream.baseUrl : target,
    ontology: () => ontology,
  });
  const downstream = await startDownstream(gateway);
  const token = signToken({ role: 'customer', user_code: 'user-a@demo.local' }, SECRET, 60);
  return {
    upstream,
    downstream,
    token,
    /** 发一条 JSON-RPC，读回合并后的消息 */
    async call(method, params = {}) {
      const response = await fetch(downstream.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
      });
      assert.equal(response.status, 200);
      const frames = parseSseMessages(await response.text());
      return frames[0];
    },
    async close() {
      await downstream.close();
      await upstream.close();
    },
  };
}

test('网关：没有维护本体论时完全透传，不追加工具', async () => {
  const ctx = await setup();
  try {
    const token = signToken({ role: 'customer' }, SECRET, 60);
    const response = await fetch(ctx.downstream.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const echoed = await response.json();
    // 假上游回显的是请求体，不该被改过
    assert.equal(JSON.parse(echoed.body).method, 'tools/list');
  } finally {
    await ctx.close();
  }
});

test('网关：initialize 只下发目录，不下发全文', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('initialize', {});
    assert.match(message.result.instructions, /业务本体论/);
    // 目录带库名与计数
    assert.match(message.result.instructions, /库 app/);
    // 但全文的细节不进握手：那才是每次会话都要付的固定成本
    assert.ok(!message.result.instructions.includes('平台的付费主体'));
    // 上游原有字段不能被抹掉
    assert.equal(message.result.serverInfo.name, 'graphjin');
  } finally {
    await ctx.close();
  }
});

test('网关：tools/list 追加两个平台工具，上游工具一个不少', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/list');
    const names = message.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'execute_graphql',
      'ask_graphjin_agent',
      ONTOLOGY_TOOL_NAME,
      DESCRIBE_TOOL_NAME,
    ]);
    const injected = message.result.tools.find((tool) => tool.name === ONTOLOGY_TOOL_NAME);
    assert.match(injected.description, /business ontology/i);
    assert.ok(injected.inputSchema.properties.kind);
    // 检索是新增的第三档：不带它，模型只能拉全文或什么都不拉
    assert.ok(injected.inputSchema.properties.query);
    // 类别白名单是「工具描述 = 实际行为」的唯一来源，加一类忘了改这里，模型就看不到它
    assert.deepEqual(injected.inputSchema.properties.kind.enum, [
      'term',
      'concept',
      'relation',
      'rule',
      'metric',
      'example',
    ]);
  } finally {
    await ctx.close();
  }
});

test('网关：上游 agent 工具的描述被补上「看不到本体论」', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/list');
    const agent = message.result.tools.find((tool) => tool.name === 'ask_graphjin_agent');
    // 不移除它（有客户端就是冲它来的），但必须让模型知道它看不到平台注入的语境
    assert.match(agent.description, /does not see the platform/);
    assert.match(agent.description, /Ask GraphJin/);
  } finally {
    await ctx.close();
  }
});

test('网关：本体论工具由平台自己答，不转发上游', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/call', { name: ONTOLOGY_TOOL_NAME, arguments: {} });
    assert.equal(message.result.isError, false);
    assert.match(message.result.content[0].text, /业务本体论/);
    assert.equal(message.result.structuredContent.count, 3);
  } finally {
    await ctx.close();
  }
});

test('网关：本体论工具支持按 kind / database 过滤', async () => {
  const ctx = await setupWithOntology();
  try {
    const byKind = await ctx.call('tools/call', {
      name: ONTOLOGY_TOOL_NAME,
      arguments: { kind: 'term' },
    });
    assert.match(byKind.result.content[0].text, /买家/);
    assert.ok(!byKind.result.content[0].text.includes('GMV'));
    assert.equal(byKind.result.structuredContent.count, 1);

    const byDatabase = await ctx.call('tools/call', {
      name: ONTOLOGY_TOOL_NAME,
      arguments: { database: 'analytics' },
    });
    assert.match(byDatabase.result.content[0].text, /GMV/);
    assert.ok(!byDatabase.result.content[0].text.includes('买家'));

    const empty = await ctx.call('tools/call', { name: ONTOLOGY_TOOL_NAME, arguments: { kind: 'rule' } });
    assert.equal(empty.result.structuredContent.count, 0);
  } finally {
    await ctx.close();
  }
});

test('网关：平台代答的工具结果带 resultType', async () => {
  const ctx = await setupWithOntology();
  try {
    // 新版客户端按 2026-07-28 的 schema 校验，缺 resultType 会整条拒收
    const ok = await ctx.call('tools/call', { name: ONTOLOGY_TOOL_NAME, arguments: {} });
    assert.equal(ok.result.resultType, 'complete');

    // 工具执行失败也仍是 complete：错误由 isError 表达，不是 input_required
    const failed = await ctx.call('tools/call', {
      name: ONTOLOGY_TOOL_NAME,
      arguments: { kind: 'no-such-kind' },
    });
    assert.equal(failed.result.resultType, 'complete');
    assert.equal(failed.result.isError, true);

    const described = await ctx.call('tools/call', {
      name: DESCRIBE_TOOL_NAME,
      arguments: { name: '不存在的对象' },
    });
    assert.equal(described.result.resultType, 'complete');
  } finally {
    await ctx.close();
  }
});

test('网关：GraphJin 不在线时本体论工具仍答得出来', async () => {
  const ctx = await setupWithOntology({ target: 'none' });
  try {
    const message = await ctx.call('tools/call', { name: ONTOLOGY_TOOL_NAME, arguments: {} });
    assert.match(message.result.content[0].text, /业务本体论/);
    // 但别的工具照实报服务未运行
    const response = await fetch(ctx.downstream.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
    });
    assert.equal(response.status, 503);
  } finally {
    await ctx.close();
  }
});

/**
 * 参数非法必须是「工具错误」，不能是 HTTP 502。
 *
 * 之前 render() 对未知 kind 直接抛 OntologyError，异常冒到 index.js 的网关兜底，
 * 客户端收到的是一句「MCP 网关转发失败」——而模型真正需要的是「可用的类别是这些」。
 * setupWithOntology 的 call() 内部断言了 HTTP 200，所以这条测试同时锁住了传输层。
 */
test('网关：未知类别返回工具错误，并列出可用类别', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/call', {
      name: ONTOLOGY_TOOL_NAME,
      arguments: { kind: 'tables' },
    });
    assert.equal(message.result.isError, true);
    assert.match(message.result.content[0].text, /未知类别/);
    assert.deepEqual(message.result.structuredContent.availableKinds, [
      'term',
      'concept',
      'relation',
      'rule',
      'metric',
      'example',
    ]);
  } finally {
    await ctx.close();
  }
});

/**
 * 空答案不能是空字符串。
 *
 * 空文本对模型的含义是「这里没有任何约束」，正好诱导它违反本来存在的规则；
 * 所以必须说清「问的是哪个库」「哪些库有本体论」「结构该去哪拿」。
 */
test('网关：问一个没维护本体论的库，答出「没有」与「哪些有」', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/call', {
      name: ONTOLOGY_TOOL_NAME,
      arguments: { database: 'nope' },
    });
    assert.equal(message.result.isError, false);
    const text = message.result.content[0].text;
    assert.ok(text.length > 0, '空结果不能回空字符串');
    assert.match(text, /nope/);
    assert.match(text, /app/);
    assert.match(text, /query_catalog/);
    assert.equal(message.result.structuredContent.count, 0);
    assert.deepEqual(message.result.structuredContent.maintainedDatabases, ['app', 'analytics']);
  } finally {
    await ctx.close();
  }
});

test('网关：有效类别但没有条目时，也要说清过滤条件', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/call', {
      name: ONTOLOGY_TOOL_NAME,
      arguments: { kind: 'rule' },
    });
    assert.equal(message.result.isError, false);
    const text = message.result.content[0].text;
    assert.ok(text.length > 0);
    assert.match(text, /类别=rule/);
    assert.equal(message.result.structuredContent.count, 0);
  } finally {
    await ctx.close();
  }
});

test('网关：query 走检索，命中理由可解释', async () => {
  const ctx = await setupWithOntology();
  try {
    // 「客户」是「买家」的别名：检索必须靠别名命中，而不是靠全文里恰好有这两个字
    const message = await ctx.call('tools/call', {
      name: ONTOLOGY_TOOL_NAME,
      arguments: { query: '客户' },
    });
    assert.equal(message.result.isError, false);
    const text = message.result.content[0].text;
    assert.match(text, /检索：客户/);
    assert.match(text, /命中理由/);
    assert.ok(message.result.structuredContent.count >= 1);
    const names = message.result.structuredContent.matches.map((item) => item.name);
    assert.ok(names.includes('买家') || names.includes('客户'));
  } finally {
    await ctx.close();
  }
});

test('网关：检索不到时给出下一步，而不是回空串', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/call', {
      name: ONTOLOGY_TOOL_NAME,
      arguments: { query: '完全不存在的说法' },
    });
    assert.equal(message.result.isError, false);
    const text = message.result.content[0].text;
    assert.ok(text.length > 0);
    assert.match(text, /没有匹配/);
    assert.match(text, /app/);
    assert.equal(message.result.structuredContent.count, 0);
  } finally {
    await ctx.close();
  }
});

test('网关：describe_business_object 返回对象本身与它涉及的条目', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/call', {
      name: DESCRIBE_TOOL_NAME,
      arguments: { name: '买家' },
    });
    assert.equal(message.result.isError, false);
    assert.match(message.result.content[0].text, /业务对象：买家/);
    assert.equal(message.result.structuredContent.found, true);
    // 客户（概念）与买家共用 app.main.customers 这张表，应被一起带出来
    const relatedNames = message.result.structuredContent.related.map((item) => item.name);
    assert.ok(relatedNames.includes('客户'));
    // GMV 在另一张表上，不该混进来
    assert.ok(!relatedNames.includes('GMV'));
  } finally {
    await ctx.close();
  }
});

test('网关：describe 找不到时给出候选，允许模型自我纠错', async () => {
  const ctx = await setupWithOntology();
  try {
    // 「付费主体」不在任何名字/别名里，但出现在买家的说明里：describe 拒绝，
    // 检索却能给出候选——这正是「找不到也别让模型卡住」的路径
    const message = await ctx.call('tools/call', {
      name: DESCRIBE_TOOL_NAME,
      arguments: { name: '付费主体' },
    });
    assert.equal(message.result.isError, false);
    assert.match(message.result.content[0].text, /没有名为/);
    assert.equal(message.result.structuredContent.found, false);
    assert.ok(message.result.structuredContent.suggestions.length > 0);
  } finally {
    await ctx.close();
  }
});

test('网关：describe 完全找不到时指向目录，still 不回空串', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/call', {
      name: DESCRIBE_TOOL_NAME,
      arguments: { name: '完全不存在的对象' },
    });
    assert.equal(message.result.isError, false);
    const text = message.result.content[0].text;
    assert.ok(text.length > 0);
    assert.match(text, /可以先调 business_ontology/);
    assert.deepEqual(message.result.structuredContent.suggestions, []);
  } finally {
    await ctx.close();
  }
});

test('网关：describe 缺 name 时是工具错误，不是 502', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/call', {
      name: DESCRIBE_TOOL_NAME,
      arguments: {},
    });
    assert.equal(message.result.isError, true);
    assert.match(message.result.content[0].text, /需要 name/);
  } finally {
    await ctx.close();
  }
});

test('网关：上游已有 instructions 时追加而不是覆盖', async () => {
  const upstream = await startRpcUpstream();
  // 换一个会返回 instructions 的上游
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { instructions: 'GraphJin 自己的说明', capabilities: {} },
      })}\n\n`
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gateway = createMcpGateway({
    secret: SECRET,
    resolveTarget: () => `http://127.0.0.1:${server.address().port}`,
    ontology: () => ONTOLOGY,
  });
  const downstream = await startDownstream(gateway);
  const token = signToken({ role: 'customer' }, SECRET, 60);
  try {
    const response = await fetch(downstream.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const frames = parseSseMessages(await response.text());
    assert.match(frames[0].result.instructions, /GraphJin 自己的说明/);
    assert.match(frames[0].result.instructions, /业务本体论/);
  } finally {
    await downstream.close();
    await upstream.close();
    await new Promise((done) => server.close(done));
  }
});

test('网关：把调用者的角色传给本体论提供方', async () => {
  const seen = [];
  const upstream = await startRpcUpstream();
  const gateway = createMcpGateway({
    secret: SECRET,
    resolveTarget: () => upstream.baseUrl,
    // 按角色裁剪的前提：网关必须把 claims.role 交出去
    ontology: (role) => {
      seen.push(role);
      return ONTOLOGY;
    },
  });
  const downstream = await startDownstream(gateway);
  const token = signToken({ role: 'customer' }, SECRET, 60);
  try {
    await fetch(downstream.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.deepEqual(seen, ['customer']);
  } finally {
    await downstream.close();
    await upstream.close();
  }
});
