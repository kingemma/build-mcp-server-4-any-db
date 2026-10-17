'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  ConnectionStore,
  STATUS_CONNECTED,
  STATUS_VERIFIED,
} = require('../src/connections');
const { UserStore } = require('../src/users');
const { createRouter } = require('../src/index');

/** 固定密钥：单测不该往数据目录写 keystore.key */
const SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

const SQLITE_CONFIG = { type: 'sqlite', path: 'app.db', default: true };
const PG_CONFIG = {
  type: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  dbname: 'app',
  user: 'app',
  password: 's3cret',
};

async function withStore(run) {
  const store = new ConnectionStore(':memory:', { secretKey: SECRET_KEY });
  try {
    await run(store);
  } finally {
    store.close();
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcpb-${prefix}-`));
}

test('连接：保存后能列出摘要，且不泄露密码', async () => {
  await withStore(async (store) => {
    const saved = store.save({
      name: 'app',
      projectDir: path.join(os.tmpdir(), 'project'),
      config: PG_CONFIG,
      status: STATUS_VERIFIED,
      origin: 'test',
    });
    assert.deepStrictEqual(saved.config, PG_CONFIG);

    const list = store.list();
    assert.strictEqual(list.length, 1);
    const [row] = list;
    assert.strictEqual(row.id, saved.id);
    assert.strictEqual(row.wireType, 'postgres');
    assert.strictEqual(row.mode, 'fields');
    assert.strictEqual(row.host, '127.0.0.1');
    assert.strictEqual(row.port, 5432);
    assert.strictEqual(row.dbname, 'app');
    assert.strictEqual(row.user, 'app');
    assert.strictEqual(row.hasSecret, true);
    assert.strictEqual(row.readable, true);
    assert.strictEqual(row.config, undefined);
    assert.strictEqual(JSON.stringify(row).includes('s3cret'), false);
  });
});

test('连接：sqlite 路径与连接串的录入方式推断正确', async () => {
  await withStore(async (store) => {
    store.save({ name: 'file', projectDir: 'p', config: SQLITE_CONFIG });
    store.save({
      name: 'dsn',
      projectDir: 'p',
      config: { type: 'postgres', connection_string: 'postgres://u:p@h:5432/db' },
    });

    const byName = Object.fromEntries(store.list().map((row) => [row.name, row]));
    assert.strictEqual(byName.file.mode, 'path');
    assert.strictEqual(byName.file.isDefault, true);
    assert.strictEqual(byName.dsn.mode, 'dsn');
    assert.strictEqual(byName.dsn.hasSecret, true);
    assert.strictEqual(byName.dsn.host, null);
  });
});

test('连接：同名同项目覆盖，同名不同项目并存', async () => {
  await withStore(async (store) => {
    const dirA = path.join(os.tmpdir(), 'proj-a');
    const dirB = path.join(os.tmpdir(), 'proj-b');

    const first = store.save({ name: 'app', projectDir: dirA, config: PG_CONFIG });
    const second = store.save({
      name: 'app',
      projectDir: dirA,
      config: { ...PG_CONFIG, dbname: 'app2' },
      status: STATUS_CONNECTED,
      origin: 'start',
    });

    assert.strictEqual(second.id, first.id);
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.get(first.id).config.dbname, 'app2');
    assert.strictEqual(store.get(first.id).status, STATUS_CONNECTED);
    assert.strictEqual(store.get(first.id).origin, 'start');

    const other = store.save({ name: 'app', projectDir: dirB, config: PG_CONFIG });
    assert.notStrictEqual(other.id, first.id);
    assert.strictEqual(store.list().length, 2);
  });
});

test('连接：相对项目目录与绝对路径归一成同一条', async () => {
  await withStore(async (store) => {
    const relative = store.save({ name: 'app', projectDir: 'projects/app', config: SQLITE_CONFIG });
    const absolute = store.save({
      name: 'app',
      projectDir: path.resolve('projects/app'),
      config: SQLITE_CONFIG,
    });

    assert.strictEqual(absolute.id, relative.id);
    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.get(relative.id).projectDir, path.resolve('projects/app'));
  });
});

test('连接：字段缺失与非法枚举都报错', async () => {
  await withStore(async (store) => {
    assert.throws(
      () => store.save({ name: '  ', projectDir: 'p', config: SQLITE_CONFIG }),
      /连接名 不能为空/
    );
    assert.throws(
      () => store.save({ name: 'app', projectDir: '', config: SQLITE_CONFIG }),
      /项目目录 不能为空/
    );
    assert.throws(
      () => store.save({ name: 'app', projectDir: 'p', config: null }),
      /连接配置必须是对象/
    );
    assert.throws(
      () => store.save({ name: 'app', projectDir: 'p', config: { path: 'a.db' } }),
      /连接类型 不能为空/
    );
    assert.throws(
      () => store.save({ name: 'app', projectDir: 'p', config: SQLITE_CONFIG, status: 'weird' }),
      /status/
    );
    assert.throws(
      () => store.save({ name: 'app', projectDir: 'p', config: SQLITE_CONFIG, origin: 'weird' }),
      /origin/
    );
    assert.throws(() => store.remove('1'), /id 必须是整数/);
    assert.throws(() => store.get(1.5), /id 必须是整数/);
  });
});

test('连接：删除后列表与详情都取不到', async () => {
  await withStore(async (store) => {
    const saved = store.save({ name: 'app', projectDir: 'p', config: SQLITE_CONFIG });
    assert.strictEqual(store.remove(saved.id), true);
    assert.strictEqual(store.remove(saved.id), false);
    assert.deepStrictEqual(store.list(), []);
    assert.strictEqual(store.get(saved.id), null);
  });
});

test('连接：payload 损坏时摘要仍可读，只有 config 丢失', async () => {
  const dir = tempDir('connections');
  const dbPath = path.join(dir, 'store.db');
  const store = new ConnectionStore(dbPath, { secretKey: SECRET_KEY });
  const saved = store.save({ name: 'app', projectDir: dir, config: PG_CONFIG });
  store.close();

  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE connections SET payload = 'broken' WHERE id = ?").run(saved.id);
  raw.close();

  const reopened = new ConnectionStore(dbPath, { secretKey: SECRET_KEY });
  try {
    const [row] = reopened.list();
    assert.strictEqual(row.readable, false);
    assert.strictEqual(row.name, 'app');
    // 摘要字段来自明文列，换 key / payload 坏掉后仍然能显示目标
    assert.strictEqual(row.host, '127.0.0.1');
    assert.strictEqual(row.port, 5432);
    assert.strictEqual(row.dbname, 'app');
    assert.strictEqual(row.hasSecret, true);
    assert.strictEqual(reopened.get(saved.id).config, null);
    assert.strictEqual(reopened.get(saved.id).host, '127.0.0.1');
  } finally {
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('连接：老表结构自动补摘要列', async () => {
  const dir = tempDir('legacy');
  const dbPath = path.join(dir, 'store.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      app_name TEXT NOT NULL,
      wire_type TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      origin TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (name, project_dir)
    );
  `);
  raw.close();

  const store = new ConnectionStore(dbPath, { secretKey: SECRET_KEY });
  try {
    const saved = store.save({ name: 'app', projectDir: dir, config: PG_CONFIG });
    const [row] = store.list();
    assert.strictEqual(row.id, saved.id);
    assert.strictEqual(row.host, '127.0.0.1');
    assert.strictEqual(row.hasSecret, true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC：graphjin.start 成功后自动落盘连接', async () => {
  const dir = tempDir('rpc');
  const users = new UserStore(':memory:');
  const connections = new ConnectionStore(':memory:', { secretKey: SECRET_KEY });
  const supervisor = {
    start: async (params) => ({
      running: true,
      projectDir: path.resolve(params.projectDir),
      baseUrl: 'http://127.0.0.1:1',
      port: 1,
    }),
    stop: async () => ({ running: false }),
    status: () => ({ running: false }),
  };
  const router = createRouter({ store: users, connections, supervisor });

  try {
    const started = await router.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'graphjin.start',
      params: { projectDir: dir, appName: 'Demo', databases: { app: SQLITE_CONFIG } },
    });
    assert.strictEqual(started.result.running, true);

    const listed = await router.dispatch({ jsonrpc: '2.0', id: 2, method: 'connections.list' });
    assert.strictEqual(listed.result.length, 1);
    assert.strictEqual(listed.result[0].status, STATUS_CONNECTED);
    assert.strictEqual(listed.result[0].origin, 'start');
    assert.strictEqual(listed.result[0].appName, 'Demo');
    assert.strictEqual(listed.result[0].projectDir, path.resolve(dir));

    const detail = await router.dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'connections.get',
      params: { id: listed.result[0].id },
    });
    assert.deepStrictEqual(detail.result.config, SQLITE_CONFIG);

    const invalid = await router.dispatch({
      jsonrpc: '2.0',
      id: 4,
      method: 'connections.get',
      params: { id: 'x' },
    });
    assert.strictEqual(invalid.error.code, -32602);

    const removed = await router.dispatch({
      jsonrpc: '2.0',
      id: 5,
      method: 'connections.remove',
      params: { id: listed.result[0].id },
    });
    assert.strictEqual(removed.result.deleted, true);

    const empty = await router.dispatch({ jsonrpc: '2.0', id: 6, method: 'connections.list' });
    assert.deepStrictEqual(empty.result, []);
  } finally {
    connections.close();
    users.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC：启动未成功时不落盘连接', async () => {
  const dir = tempDir('rpc-down');
  const users = new UserStore(':memory:');
  const connections = new ConnectionStore(':memory:', { secretKey: SECRET_KEY });
  const supervisor = {
    start: async () => ({ running: false, projectDir: path.resolve(dir) }),
    stop: async () => ({ running: false }),
    status: () => ({ running: false }),
  };
  const router = createRouter({ store: users, connections, supervisor });

  try {
    await router.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'graphjin.start',
      params: { projectDir: dir, databases: { app: SQLITE_CONFIG } },
    });
    assert.deepStrictEqual(connections.list(), []);
  } finally {
    connections.close();
    users.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC：未装配连接存储时连接类方法返回 INVALID_PARAMS', async () => {
  const users = new UserStore(':memory:');
  const router = createRouter({ store: users, supervisor: { status: () => ({ running: false }) } });
  try {
    const response = await router.dispatch({ jsonrpc: '2.0', id: 1, method: 'connections.list' });
    assert.strictEqual(response.error.code, -32602);
  } finally {
    users.close();
  }
});
