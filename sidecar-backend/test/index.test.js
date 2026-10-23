'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createRouter,
  startHttpServer,
  probeDatabases,
  requireGraphqlQuery,
} = require('../src/index');
const { ORIGIN_START, STATUS_CONNECTED, ConnectionStore } = require('../src/connections');
const { UserStore } = require('../src/users');
const { OntologyStore } = require('../src/ontology');

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

test('requireGraphqlQuery: 语句本体原样通过', () => {
  assert.strictEqual(requireGraphqlQuery('{ orders(limit: 5) { id } }'), '{ orders(limit: 5) { id } }');
  assert.strictEqual(requireGraphqlQuery('  { items(limit: 1) { id } }  '), '{ items(limit: 1) { id } }');
});

test('requireGraphqlQuery: 粘成调用示例的 JSON 参数时取出 query', () => {
  const pasted = '{ "query": "{ orders(limit: 5) { id } }" }';
  assert.strictEqual(requireGraphqlQuery(pasted), '{ orders(limit: 5) { id } }');
});

test('requireGraphqlQuery: 空值与粘错的 JSON 都给明确错误', () => {
  assert.throws(() => requireGraphqlQuery(''), /query 不能为空/);
  assert.throws(() => requireGraphqlQuery(null), /query 不能为空/);
  // 是 JSON 但没有 query 字段：粘错了东西，说清楚而不是透传 GraphJin 的语法错误
  assert.throws(() => requireGraphqlQuery('{ "database": "app" }'), /JSON 参数而不是 GraphQL 语句/);
});

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

/**
 * 装一个带本体论存储的路由：本体论相关 RPC 必须能脱离运行中的实例工作。
 *
 * 不传 supervisor 时 createRouter 自己造一个「未运行」的，正好验证降级路径。
 */
async function withOntologyServer(run) {
  const store = new UserStore(':memory:');
  const ontology = new OntologyStore(':memory:');
  const router = createRouter({ store, ontology });
  const server = await startHttpServer({ router, port: 0 });
  const { port } = server.address();
  try {
    await run({ port, ontology });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    ontology.close();
  }
}

test('ontology.list 支持按库过滤：列表与渲染结果都不串库', async () => {
  await withOntologyServer(async ({ port, ontology }) => {
    ontology.save({ database: 'app', kind: 'term', name: '甲', definition: 'app 的说法' });
    ontology.save({ database: 'analytics', kind: 'term', name: '乙', definition: '另一个库' });

    const all = await (await post(port, { jsonrpc: '2.0', id: 20, method: 'ontology.list' })).json();
    assert.strictEqual(all.result.entries.length, 2);

    const scoped = await (
      await post(port, {
        jsonrpc: '2.0',
        id: 21,
        method: 'ontology.list',
        params: { database: 'app' },
      })
    ).json();
    assert.deepStrictEqual(scoped.result.entries.map((entry) => entry.name), ['甲']);
    // 渲染也跟着过滤：拿错库的语境比拿不到更危险
    assert.match(scoped.result.rendered, /甲/);
    assert.doesNotMatch(scoped.result.rendered, /乙/);
  });
});

test('ontology.lint 在实例未运行时仍跑结构规则，并说明跳过了哪些', async () => {
  await withOntologyServer(async ({ port, ontology }) => {
    ontology.save({
      database: 'app',
      kind: 'rule',
      name: '只有人话的强制规则',
      definition: '写入前必须校验',
      severity: 'enforce',
    });

    const response = await post(port, { jsonrpc: '2.0', id: 22, method: 'ontology.lint', params: {} });
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body));

    // 没有 schema：需要 schema 的规则进 skipped，而不是静默不跑
    assert.strictEqual(body.result.schemaSource, 'none');
    assert.ok(body.result.skipped.some((item) => item.id === 'stale-reference'));

    // 不依赖 schema 的规则照跑
    const issues = body.result.issues;
    const codable = issues.find((issue) => issue.rule === 'enforce-not-codable');
    assert.ok(codable, '强制规则没有表达式时应当报错');
    assert.strictEqual(codable.level, 'error');
  });
});

test('ontology.lint 接受调用方传入的 schema，能查出引用腐烂的表', async () => {
  await withOntologyServer(async ({ port, ontology }) => {
    ontology.save({
      database: 'app',
      kind: 'concept',
      name: '订单',
      definition: '购买意图',
      tables: ['app.main.orders'],
    });

    const response = await post(port, {
      jsonrpc: '2.0',
      id: 23,
      method: 'ontology.lint',
      params: {
        schema: {
          tables: [{ database: 'app', schema: 'main', name: 'orders_v2' }],
          relationships: [],
        },
      },
    });
    const body = await response.json();
    assert.strictEqual(body.result.schemaSource, 'provided');
    const stale = body.result.issues.find((issue) => issue.rule === 'stale-reference');
    assert.ok(stale, '引用不存在的表必须报 stale-reference');
    assert.match(stale.message, /app\.main\.orders/);
  });
});

test('ontology.propose 从传入的 schema 起草候选，且已覆盖的表不再出现', async () => {
  await withOntologyServer(async ({ port, ontology }) => {
    ontology.save({ database: 'app', kind: 'concept', name: '订单', tables: ['app.main.orders'] });

    const response = await post(port, {
      jsonrpc: '2.0',
      id: 24,
      method: 'ontology.propose',
      params: {
        schema: {
          tables: [
            { database: 'app', schema: 'main', name: 'orders', columns: [] },
            { database: 'app', schema: 'main', name: 'customers', columns: [] },
          ],
          relationships: [],
        },
      },
    });
    const body = await response.json();
    assert.strictEqual(body.result.schemaSource, 'provided');
    assert.deepStrictEqual(
      body.result.concepts.map((item) => item.name),
      ['Customers']
    );
  });
});

test('ontology.propose 在没有 schema 时安静返回空结果', async () => {
  await withOntologyServer(async ({ port }) => {
    const response = await post(port, {
      jsonrpc: '2.0',
      id: 25,
      method: 'ontology.propose',
      params: {},
    });
    const body = await response.json();
    assert.strictEqual(body.result.schemaSource, 'none');
    assert.strictEqual(body.result.counts.concepts, 0);
  });
});

test('ontology.scanValues 把表名列名拼进查询前先校验，非法值不触网', async () => {  await withOntologyServer(async ({ port }) => {
    const missingBase = await (
      await post(port, { jsonrpc: '2.0', id: 26, method: 'ontology.scanValues', params: {} })
    ).json();
    assert.strictEqual(missingBase.error.code, -32602);

    // 带点号的表名会被拼进选择集，必须先拒掉：这里报错就说明没有走到网络
    const badTable = await (
      await post(port, {
        jsonrpc: '2.0',
        id: 27,
        method: 'ontology.scanValues',
        params: { baseUrl: 'http://127.0.0.1:1', table: 'app.orders', column: 'status' },
      })
    ).json();
    assert.strictEqual(badTable.error.code, -32602);
    assert.match(badTable.error.message, /table/);

    const badColumn = await (
      await post(port, {
        jsonrpc: '2.0',
        id: 28,
        method: 'ontology.scanValues',
        params: { baseUrl: 'http://127.0.0.1:1', table: 'orders', column: 'status;drop' },
      })
    ).json();
    assert.strictEqual(badColumn.error.code, -32602);
    assert.match(badColumn.error.message, /column/);
  });
});

test('ontology.eval 核对样例的结构与覆盖；没给实例时不跑查询', async () => {
  await withOntologyServer(async ({ port, ontology }) => {
    // 一张被讲过的表：覆盖检查才不会把「没人讲」误报成问题
    ontology.save({ database: 'app', kind: 'concept', name: '订单', tables: ['app.main.orders'] });
    ontology.save({
      database: 'app',
      kind: 'example',
      name: '按状态看订单金额',
      expression: '{ orders(where:{status:{eq:"paid"}}) { amount } }',
      payload: { expect: { tables: ['orders'], columns: ['amount'], values: ['paid'] } },
    });

    const response = await post(port, {
      jsonrpc: '2.0',
      id: 29,
      method: 'ontology.eval',
      params: {
        schema: {
          tables: [
            { database: 'app', schema: 'main', name: 'orders', columns: [{ name: 'amount' }] },
          ],
          relationships: [],
        },
      },
    });
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body));
    assert.strictEqual(body.result.schemaSource, 'provided');
    // 没传 baseUrl：不跑查询，但结构与覆盖照做
    assert.strictEqual(body.result.ranQueries, false);
    assert.match(body.result.note, /只做了结构与覆盖检查/);
    assert.strictEqual(body.result.summary.pass, 1);
    const [result] = body.result.results;
    assert.strictEqual(result.checks.structure.status, 'pass');
    assert.strictEqual(result.checks.grounded.status, 'pass');
    assert.strictEqual(result.checks.runs.status, 'skipped');
  });
});

test('ontology.eval 对缺查询的样例直接判失败', async () => {  await withOntologyServer(async ({ port, ontology }) => {
    ontology.save({ database: 'app', kind: 'example', name: '只有问题' });

    const response = await post(port, {
      jsonrpc: '2.0',
      id: 30,
      method: 'ontology.eval',
      params: {},
    });
    const body = await response.json();
    assert.strictEqual(body.result.summary.fail, 1);
    assert.match(body.result.results[0].messages.join(''), /没有查询/);
  });
});

test('ontology.compileRules 在没有实例与 dev.yml 时从空现状编译，并报出冲突', async () => {
  await withOntologyServer(async ({ port, ontology }) => {
    ontology.save({
      database: 'app',
      kind: 'rule',
      name: '只看未作废',
      definition: '作废的单据不该进统计',
      severity: 'enforce',
      payload: {
        mode: 'filter',
        on: { table: 'app.main.orders' },
        predicate: '{ status: { _eq: "voided" } }',
      },
    });

    const response = await post(port, {
      jsonrpc: '2.0',
      id: 31,
      method: 'ontology.compileRules',
      params: { database: 'app' },
    });
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body));
    // 没有实例也没有项目目录：现状为空，但规则本身照样编译
    assert.strictEqual(body.result.accessSource, 'none');
    assert.strictEqual(body.result.summary.rules, 1);
    assert.strictEqual(body.result.summary.compiled, 1);
    // 空现状里没有任何 grant：这条读筛选无处可挂，必须明确报出来而不是静默成功
    assert.strictEqual(body.result.changes.length, 0);
    assert.match(body.result.conflicts[0].reason, /没有任何角色的读规则覆盖/);
  });
});

test('ontology.compileRules 缺 database 时报错', async () => {
  await withOntologyServer(async ({ port }) => {
    const response = await post(port, {
      jsonrpc: '2.0',
      id: 32,
      method: 'ontology.compileRules',
      params: {},
    });
    const body = await response.json();
    assert.strictEqual(body.error.code, -32602);
  });
});
