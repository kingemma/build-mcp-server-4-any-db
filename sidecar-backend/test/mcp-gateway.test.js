'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createMcpGateway } = require('../src/mcp-gateway');
const { signToken } = require('../src/jwt');

const SECRET = 'gateway-test-secret-0123456789';

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
