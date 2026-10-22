'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createMcpGateway, ONTOLOGY_TOOL_NAME } = require('../src/mcp-gateway');
const { parseSseMessages } = require('../src/mcp-client');
const { signToken } = require('../src/jwt');

const SECRET = 'gateway-test-secret-0123456789';

const ONTOLOGY = {
  document: '# 业务本体论\n\n## 数据库 app\n\n## 术语表\n- **买家** — 平台的付费主体',
  entries: [
    { id: 1, database: 'app', kind: 'term', name: '买家', definition: '平台的付费主体' },
    { id: 2, database: 'analytics', kind: 'metric', name: 'GMV', definition: '已支付金额合计' },
  ],
  render: ({ kind = null, database = null } = {}) => {
    const picked = ONTOLOGY.entries.filter(
      (entry) => (!kind || entry.kind === kind) && (database === null || entry.database === database)
    );
    if (picked.length === 0) return '';
    return `# 业务本体论\n${picked.map((entry) => `- ${entry.name}`).join('\n')}`;
  },
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
        'tools/list': { tools: [{ name: 'execute_graphql', description: 'run graphql' }] },
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

test('网关：initialize 合并 instructions，模型不调用也能拿到业务语境', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('initialize', {});
    assert.match(message.result.instructions, /业务本体论/);
    assert.match(message.result.instructions, /买家/);
    // 上游原有字段不能被抹掉
    assert.equal(message.result.serverInfo.name, 'graphjin');
  } finally {
    await ctx.close();
  }
});

test('网关：tools/list 追加本体论工具，上游工具一个不少', async () => {
  const ctx = await setupWithOntology();
  try {
    const message = await ctx.call('tools/list');
    const names = message.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ['execute_graphql', ONTOLOGY_TOOL_NAME]);
    const injected = message.result.tools.find((tool) => tool.name === ONTOLOGY_TOOL_NAME);
    assert.match(injected.description, /business ontology/i);
    assert.ok(injected.inputSchema.properties.kind);
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
    assert.equal(message.result.structuredContent.count, 2);
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
