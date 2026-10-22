'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRouter, startHttpServer, probeDatabases } = require('../src/index');
const { ORIGIN_START, STATUS_CONNECTED, ConnectionStore } = require('../src/connections');
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

const SOURCES_YAML = `sources:
  - name: app
    type: sqlite
    path: app.db
`;

function tempProject(yaml = SOURCES_YAML) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-live-'));
  fs.writeFileSync(path.join(dir, 'dev.yml'), yaml, 'utf8');
  return dir;
}

const GRANTED_YAML = `sources:
  - name: app
    type: sqlite
    path: app.db
    access:
      read: authenticated
      grants:
        - role: analyst
          tables:
            - name: orders
              columns: ["id"]
roles:
  - name: admin
  - name: analyst
`;

test('config.file: 实例未运行时从 dev.yml 读出权限与角色', async () => {
  const dir = tempProject(GRANTED_YAML);
  const router = createRouter({ store: new UserStore(':memory:') });

  const response = await router.dispatch({
    jsonrpc: '2.0', id: 1, method: 'config.file', params: { projectDir: dir },
  });

  // 形态要和 config.current 一致，前端 normalizeCurrentRoles 才能共用一条解析路径
  assert.strictEqual(response.result.sources[0].name, 'app');
  assert.strictEqual(response.result.sources[0].access.grants[0].role, 'analyst');
  assert.deepStrictEqual(response.result.roles, [{ name: 'admin' }, { name: 'analyst' }]);
});

test('config.file: 缺参数 / 缺 dev.yml 时报明确错误', async () => {
  const router = createRouter({ store: new UserStore(':memory:') });

  const noParam = await router.dispatch({
    jsonrpc: '2.0', id: 1, method: 'config.file', params: {},
  });
  assert.strictEqual(noParam.error.code, -32602);
  assert.match(noParam.error.message, /projectDir/);

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-empty-'));
  const noFile = await router.dispatch({
    jsonrpc: '2.0', id: 2, method: 'config.file', params: { projectDir: emptyDir },
  });
  assert.match(noFile.error.message, /dev\.yml/);
});

/**
 * 造一份「都已经启动成功过」的连接记录，再配一个假的 supervisor。
 * status 故意写成 connected，用来验证历史值不会冒充运行态。
 */
function connectionRouter({ dir, running = true, runDir = dir }) {
  const connections = new ConnectionStore(':memory:', {
    secretKey: crypto.randomBytes(32).toString('base64'),
  });
  for (const name of ['app', 'other']) {
    connections.save({
      name,
      projectDir: dir,
      config: { type: 'sqlite', path: `${name}.db` },
      status: STATUS_CONNECTED,
      origin: ORIGIN_START,
    });
  }
  const supervisor = { status: () => ({ running, projectDir: runDir }) };
  return createRouter({ store: new UserStore(':memory:'), connections, supervisor });
}

/** @returns {Promise<Object>} { name: active } */
async function activeByName(router) {
  const response = await router.dispatch({ jsonrpc: '2.0', id: 1, method: 'connections.list' });
  return Object.fromEntries(response.result.map((row) => [row.name, row.active]));
}

test('connections.list 的 active 只由当前运行实例决定', async () => {
  const dir = tempProject();

  // 在跑，dev.yml 里只有 app
  assert.deepStrictEqual(await activeByName(connectionRouter({ dir })), { app: true, other: false });

  // 已停止：历史 status=connected 仍不能算已连接
  assert.deepStrictEqual(await activeByName(connectionRouter({ dir, running: false })), {
    app: false,
    other: false,
  });

  // 跑的是另一个项目目录，库名相同也不算
  assert.deepStrictEqual(await activeByName(connectionRouter({ dir, runDir: tempProject() })), {
    app: false,
    other: false,
  });
});

const TWO_SOURCES_YAML = `sources:
  - name: app
    type: sqlite
    path: app.db
  - name: other
    type: sqlite
    path: other.db
`;

/** 带 dev.yml 与可计数 supervisor 的 router，用来验证删除时的停 / 重启分支 */
function removalRouter({ devYaml, names = ['app', 'other'], running = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-remove-'));
  fs.writeFileSync(path.join(dir, 'dev.yml'), devYaml, 'utf8');
  const connections = new ConnectionStore(':memory:', {
    secretKey: crypto.randomBytes(32).toString('base64'),
  });
  for (const name of names) {
    connections.save({ name, projectDir: dir, config: { type: 'sqlite', path: `${name}.db` } });
  }
  const calls = { start: 0, stop: 0 };
  const supervisor = {
    status: () => ({ running, projectDir: dir }),
    stop: async () => {
      calls.stop += 1;
      return { running: false };
    },
    start: async () => {
      calls.start += 1;
      return { running: true, baseUrl: null, projectDir: dir };
    },
  };
  const router = createRouter({ store: new UserStore(':memory:'), connections, supervisor });
  const ids = Object.fromEntries(connections.list().map((row) => [row.name, row.id]));
  return { dir, ids, calls, router, connections };
}

test('connections.remove 在实例未运行时只删记录', async () => {
  const { router, ids, calls } = removalRouter({ devYaml: TWO_SOURCES_YAML, running: false });

  const response = await router.dispatch({
    jsonrpc: '2.0', id: 1, method: 'connections.remove', params: { id: ids.app },
  });

  assert.strictEqual(response.result.action, 'record');
  assert.deepStrictEqual(calls, { start: 0, stop: 0 });
});

test('connections.remove 删掉运行中实例的库后重启，dev.yml 同步移除', async () => {
  const { dir, router, ids, calls } = removalRouter({ devYaml: TWO_SOURCES_YAML });

  const response = await router.dispatch({
    jsonrpc: '2.0', id: 2, method: 'connections.remove', params: { id: ids.app },
  });

  assert.strictEqual(response.result.action, 'restarted');
  assert.strictEqual(response.result.deleted, true);
  // 先停再起，重启后库清单以 dev.yml 为准
  assert.deepStrictEqual(calls, { start: 1, stop: 1 });
  const text = fs.readFileSync(path.join(dir, 'dev.yml'), 'utf8');
  assert.doesNotMatch(text, /- name: app/);
  assert.match(text, /- name: other/);
});

test('connections.remove 删掉最后一个库时停止服务', async () => {
  const single = `sources:
  - name: app
    type: sqlite
    path: app.db
`;
  const { router, ids, calls } = removalRouter({ devYaml: single, names: ['app'] });

  const response = await router.dispatch({
    jsonrpc: '2.0', id: 3, method: 'connections.remove', params: { id: ids.app },
  });

  assert.strictEqual(response.result.action, 'stopped');
  assert.deepStrictEqual(calls, { start: 0, stop: 1 });
});

/** 造 query_catalog 的卡片：表 + 每列的 id 形如 column:<db>:main.<table>.<column> */
function catalogOf(database, tables) {
  const cards = [];
  for (const [table, columns] of Object.entries(tables)) {
    cards.push({ kind: 'table', name: table });
    for (const column of columns) {
      cards.push({ kind: 'column', id: `column:${database}:main.${table}.${column}`, name: table });
    }
  }
  return { cards };
}

/**
 * 假 service：只实现 mcp.probe 用到的两个调用。
 * execute_graphql 走 query 回调，便于模拟成功 / 报错。
 */
function fakeService({ catalogs, query }) {
  return {
    readConfig: async () => ({ sources: Object.keys(catalogs).map((name) => ({ name })) }),
    mcp: {
      callTool: async (name, args) => {
        if (name === 'query_catalog') {
          const catalog = catalogs[args.database];
          if (catalog instanceof Error) throw catalog;
          return catalog;
        }
        return query(args.query);
      },
    },
  };
}

test('probeDatabases 对每个库跑一次真实查询', async () => {
  const service = fakeService({
    catalogs: {
      app: catalogOf('app', { users: ['id', 'email'] }),
      analytics: catalogOf('analytics', { events: ['id', 'kind'] }),
    },
    query: () => ({ data: { users: [] } }),
  });

  const out = await probeDatabases(service, 'admin');
  assert.deepStrictEqual(
    out.databases.map((row) => [row.database, row.ok, row.mode, row.table]),
    [
      ['app', true, 'query', 'users'],
      ['analytics', true, 'query', 'events'],
    ]
  );
});

test('probeDatabases 遇到跨库重名表时只看 catalog，不误报通过', async () => {
  const service = fakeService({
    catalogs: {
      app: catalogOf('app', { users: ['id'] }),
      analytics: catalogOf('analytics', { users: ['id'] }),
    },
    query: () => ({ data: { users: [] } }),
  });

  const out = await probeDatabases(service, 'admin');
  // 纯表名会落到默认库，查出来的是别人的表，所以只能算 catalog 可读
  assert.deepStrictEqual(
    out.databases.map((row) => [row.ok, row.mode, row.table]),
    [
      [true, 'catalog', null],
      [true, 'catalog', null],
    ]
  );
});

test('probeDatabases 把查询报错记在该库上', async () => {
  const service = fakeService({
    catalogs: { app: catalogOf('app', { users: ['id'] }) },
    query: () => ({ data: null, errors: [{ message: 'no such table' }] }),
  });

  const out = await probeDatabases(service, 'admin');
  assert.strictEqual(out.databases[0].ok, false);
  assert.strictEqual(out.databases[0].error, 'no such table');
});

test('probeDatabases 把 catalog 读不到记在该库上，不影响其它库', async () => {
  const service = fakeService({
    catalogs: {
      app: new Error('database unreachable'),
      analytics: catalogOf('analytics', { events: ['id'] }),
    },
    query: () => ({ data: { events: [] } }),
  });

  const out = await probeDatabases(service, 'admin');
  assert.strictEqual(out.databases[0].ok, false);
  assert.match(out.databases[0].error, /unreachable/);
  assert.strictEqual(out.databases[1].ok, true);
});
