'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseSseMessages } = require('../src/mcp-client');

test('parseSseMessages: 解析多帧 SSE 响应', () => {
  const body = [
    'event: message',
    '',
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    '',
    'event: message',
    '',
    'data: {"jsonrpc":"2.0","id":2,"result":{"ok":false}}',
    '',
  ].join('\n');

  assert.deepStrictEqual(parseSseMessages(body), [
    { jsonrpc: '2.0', id: 1, result: { ok: true } },
    { jsonrpc: '2.0', id: 2, result: { ok: false } },
  ]);
});

test('parseSseMessages: 忽略空 data 与非 data 行', () => {
  const body = ['event: message', 'data:', 'data: {"id":1}', ': keep-alive'].join('\n');
  assert.deepStrictEqual(parseSseMessages(body), [{ id: 1 }]);
});

test('parseSseMessages: 空响应体返回空数组', () => {
  assert.deepStrictEqual(parseSseMessages(''), []);
});

test('McpClient: 缺少 baseUrl 时构造失败', () => {
  const { McpClient } = require('../src/mcp-client');
  assert.throws(() => new McpClient({}), /baseUrl 不能为空/);
});

test('McpClient: endpoint 去掉结尾斜杠后拼接', () => {
  const { McpClient } = require('../src/mcp-client');
  const client = new McpClient({ baseUrl: 'http://127.0.0.1:8085/' });
  assert.strictEqual(client.endpoint, 'http://127.0.0.1:8085/api/v1/mcp');
  assert.strictEqual(client.isConnected, false);
});

/** 构造一个最小的 fetch 响应，够 #send 解析即可 */
function fakeResponse(status, body, sessionId = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'mcp-session-id' ? sessionId : null) },
    text: async () => body,
  };
}

test('McpClient: session 失效后自动重连并重试一次', async () => {
  const { McpClient } = require('../src/mcp-client');
  const client = new McpClient({ baseUrl: 'http://127.0.0.1:9' });
  client.sessionId = 'stale';

  const methods = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    methods.push(payload.method);
    if (payload.method === 'tools/call' && methods.filter((m) => m === 'tools/call').length === 1) {
      return fakeResponse(404, 'session not found');
    }
    if (payload.method === 'initialize') return fakeResponse(200, '', 'fresh-session');
    if (payload.method === 'notifications/initialized') return fakeResponse(202, '');
    return fakeResponse(
      200,
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { content: [{ type: 'text', text: '{"ok":true}' }] },
      })}`
    );
  };

  try {
    const result = await client.callTool('query_catalog', {});
    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(methods, [
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    assert.strictEqual(client.sessionId, 'fresh-session');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('McpClient: 并发请求遇到 session 失效时只重连一次', async () => {
  const { McpClient } = require('../src/mcp-client');
  const client = new McpClient({ baseUrl: 'http://127.0.0.1:9' });
  client.sessionId = 'stale';

  let initializes = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.method === 'tools/call') {
      if (options.headers['Mcp-Session-Id'] === 'stale') return fakeResponse(404, 'session not found');
      return fakeResponse(
        200,
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: { content: [{ type: 'text', text: '{"ok":true}' }] },
        })}`
      );
    }
    if (payload.method === 'initialize') {
      initializes += 1;
      return fakeResponse(200, '', 'fresh-session');
    }
    return fakeResponse(202, '');
  };

  try {
    const results = await Promise.all([client.callTool('a'), client.callTool('b')]);
    assert.deepStrictEqual(results, [{ ok: true }, { ok: true }]);
    assert.strictEqual(initializes, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('McpClient: 非 session 失效的 404 不重试', async () => {
  const { McpClient } = require('../src/mcp-client');
  const client = new McpClient({ baseUrl: 'http://127.0.0.1:9' });
  client.sessionId = 'stale';

  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    return fakeResponse(404, 'something else');
  };

  try {
    await assert.rejects(() => client.callTool('query_catalog', {}), /MCP HTTP 404/);
    assert.strictEqual(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
