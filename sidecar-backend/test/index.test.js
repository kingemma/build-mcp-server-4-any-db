'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createRouter, startHttpServer } = require('../src/index');
const { UserStore } = require('../src/users');

async function withServer(run) {
  const store = new UserStore(':memory:');
  const router = createRouter({ store });
  const server = await startHttpServer({ router, port: 0 });
  const { port } = server.address();
  try {
    await run({ port, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

function post(port, body) {
  return fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('端口由系统动态分配', async () => {
  await withServer(async ({ port }) => {
    assert.ok(port > 0);
  });
});

test('GET /health 返回 ok', async () => {
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).ok, true);
  });
});

test('POST /rpc 可以调用用户接口', async () => {
  await withServer(async ({ port }) => {
    const created = await (await post(port, {
      jsonrpc: '2.0', id: 1, method: 'users.createOrganization', params: { name: 'Acme' },
    })).json();
    const orgId = created.result.id;
    assert.strictEqual(created.result.name, 'Acme');

    const user = await (await post(port, {
      jsonrpc: '2.0', id: 2, method: 'users.create',
      params: { organizationId: orgId, name: 'Alice', email: 'a@acme.test', role: 'admin' },
    })).json();
    assert.strictEqual(user.result.role, 'admin');

    const roles = await (await post(port, { jsonrpc: '2.0', id: 3, method: 'users.listRoles' })).json();
    assert.deepStrictEqual(roles.result, ['admin']);
  });
});

test('POST /rpc 参数非法时返回 INVALID_PARAMS', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, {
      jsonrpc: '2.0', id: 4, method: 'users.setRole', params: { userId: 'x', role: 'admin' },
    })).json();
    assert.strictEqual(response.error.code, -32602);
  });
});

test('POST /rpc 未知方法返回 METHOD_NOT_FOUND', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, { jsonrpc: '2.0', id: 5, method: 'nope' })).json();
    assert.strictEqual(response.error.code, -32601);
  });
});

test('POST /rpc 非法 JSON 返回 400 与 parse error', async () => {
  await withServer(async ({ port }) => {
    const response = await post(port, '{oops');
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await response.json()).error.code, -32700);
  });
});

test('未知路径返回 404', async () => {
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.strictEqual(response.status, 404);
  });
});

test('users.syncRoles 缺少 baseUrl 时报错而不访问网络', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, {
      jsonrpc: '2.0', id: 6, method: 'users.syncRoles', params: {},
    })).json();
    assert.strictEqual(response.error.code, -32602);
  });
});

test('graphjin.status 在未启动时报告未运行', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, { jsonrpc: '2.0', id: 8, method: 'graphjin.status' })).json();
    assert.strictEqual(response.result.running, false);
    assert.strictEqual(response.result.baseUrl, null);
  });
});

test('graphjin.start 缺少 projectDir 时返回错误而不是崩溃', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, { jsonrpc: '2.0', id: 9, method: 'graphjin.start', params: {} })).json();
    assert.ok(response.error);
    assert.match(response.error.message, /projectDir/);
  });
});

test('graphjin.health 在未运行时返回 healthy=false', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, { jsonrpc: '2.0', id: 10, method: 'graphjin.health' })).json();
    assert.strictEqual(response.result.healthy, false);
  });
});

test('schema.discover 与 schema.tables 缺少 baseUrl 时报错而不访问网络', async () => {
  await withServer(async ({ port }) => {
    for (const method of ['schema.discover', 'schema.tables']) {
      const response = await (await post(port, { jsonrpc: '2.0', id: 7, method, params: {} })).json();
      assert.strictEqual(response.error.code, -32602, `${method} 应返回 INVALID_PARAMS`);
    }
  });
});

test('permissions.snapshots 未装配快照存储时返回空列表', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, {
      jsonrpc: '2.0', id: 11, method: 'permissions.snapshots', params: { projectDir: 'p' },
    })).json();
    assert.deepStrictEqual(response.result, []);
  });
});

test('permissions.rollback 未装配快照存储时返回明确错误', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, {
      jsonrpc: '2.0', id: 12, method: 'permissions.rollback',
      params: { baseUrl: 'http://127.0.0.1:1', projectDir: 'p' },
    })).json();
    assert.strictEqual(response.error.code, -32602);
    assert.match(response.error.message, /快照存储未初始化/);
  });
});

test('connections.test 对驱动未实现的类型直接返回 unsupported，不拉起进程', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, {
      jsonrpc: '2.0', id: 13, method: 'connections.test',
      params: { name: 'x', connection: { type: 'clickhouse' } },
    })).json();
    assert.strictEqual(response.result.success, false);
    assert.strictEqual(response.result.unsupported, true);
    assert.match(response.result.errors[0], /clickhouse/);
  });
});

test('connections.test 缺必填字段时直接报错，不拉起临时实例', async () => {
  await withServer(async ({ port }) => {
    const missingPath = await (await post(port, {
      jsonrpc: '2.0', id: 15, method: 'connections.test',
      params: { name: 'app', connection: { type: 'sqlite' } },
    })).json();
    assert.strictEqual(missingPath.result.success, false);
    assert.match(missingPath.result.errors[0], /path 或 connection_string/);

    const missingType = await (await post(port, {
      jsonrpc: '2.0', id: 16, method: 'connections.test',
      params: { name: 'app', connection: {} },
    })).json();
    assert.match(missingType.result.errors[0], /type 不能为空/);
  });
});

test('graphjin.start 对驱动未实现的类型提前报错', async () => {
  await withServer(async ({ port }) => {
    const response = await (await post(port, {
      jsonrpc: '2.0', id: 14, method: 'graphjin.start',
      params: {
        projectDir: 'temp-project',
        databases: { chip: { type: 'clickhouse', host: '127.0.0.1' } },
      },
    })).json();
    assert.strictEqual(response.error.code, -32602);
    assert.match(response.error.message, /unsupported database type/);
  });
});
