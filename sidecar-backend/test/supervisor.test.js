'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GraphJinSupervisor, SupervisorError, resolveGraphJinBinary } = require('../src/supervisor');

/** 注入用的假进程工厂，可手动触发崩溃 */
function fakeFactory(state) {
  return ({ projectDir, onUnexpectedExit }) => {
    const proc = {
      projectDir,
      isRunning: false,
      baseUrl: null,
      port: null,
      pid: 4321,
      async start() {
        this.isRunning = true;
        this.port = 1234;
        this.baseUrl = 'http://127.0.0.1:1234';
        state.started += 1;
        return this.baseUrl;
      },
      async stop() {
        this.isRunning = false;
        state.stopped += 1;
      },
      crash(code = 1) {
        this.isRunning = false;
        state.crashes += 1;
        onUnexpectedExit(code, null);
      },
    };
    state.processes.push(proc);
    return proc;
  };
}

function makeSupervisor(overrides = {}) {
  const state = { started: 0, stopped: 0, crashes: 0, processes: [] };
  const supervisor = new GraphJinSupervisor({
    binPath: 'fake-graphjin',
    createProcess: fakeFactory(state),
    ...overrides,
  });
  return { supervisor, state };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-'));
}

const DATABASES = { app: { type: 'sqlite', path: 'app.db', default: true } };

test('resolveGraphJinBinary：显式入参优先', () => {
  assert.strictEqual(resolveGraphJinBinary('/x/graphjin'), '/x/graphjin');
});

test('resolveGraphJinBinary：默认指向 src-tauri/binaries 下的当前平台产物', () => {
  const saved = process.env.GRAPHJIN_BIN;
  delete process.env.GRAPHJIN_BIN;
  try {
    const resolved = resolveGraphJinBinary();
    assert.match(resolved, /src-tauri/);
    assert.match(resolved, /binaries/);
    assert.match(resolved, /graphjin-/);
  } finally {
    if (saved !== undefined) process.env.GRAPHJIN_BIN = saved;
  }
});

test('未启动时 status 显示未运行', () => {
  const { supervisor } = makeSupervisor();
  const status = supervisor.status();
  assert.strictEqual(status.running, false);
  assert.strictEqual(status.baseUrl, null);
  assert.strictEqual(status.restarts, 0);
});

test('start 会初始化项目目录并返回运行状态', async () => {
  const dir = tempDir();
  const { supervisor, state } = makeSupervisor();
  const status = await supervisor.start({ projectDir: dir, databases: DATABASES });

  assert.strictEqual(status.running, true);
  assert.strictEqual(status.port, 1234);
  assert.strictEqual(state.started, 1);
  assert.ok(fs.existsSync(path.join(dir, 'dev.yml')));

  await supervisor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重复 start 不会启第二个进程', async () => {
  const dir = tempDir();
  const { supervisor, state } = makeSupervisor();
  await supervisor.start({ projectDir: dir, databases: DATABASES });
  const again = await supervisor.start({ projectDir: dir, databases: DATABASES });

  assert.strictEqual(state.started, 1);
  assert.strictEqual(again.running, true);

  await supervisor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺少 dev.yml 且未给 databases 时报错', async () => {
  const dir = tempDir();
  const { supervisor } = makeSupervisor();
  await assert.rejects(() => supervisor.start({ projectDir: dir }), /databases/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺少 projectDir 时报错', async () => {
  const { supervisor } = makeSupervisor();
  await assert.rejects(() => supervisor.start({}), SupervisorError);
});

test('stop 后回到未运行状态', async () => {
  const dir = tempDir();
  const { supervisor, state } = makeSupervisor();
  await supervisor.start({ projectDir: dir, databases: DATABASES });
  const stopped = await supervisor.stop();

  assert.strictEqual(stopped.running, false);
  assert.strictEqual(state.stopped, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('崩溃后自动重启', async () => {
  const dir = tempDir();
  const { supervisor, state } = makeSupervisor();
  await supervisor.start({ projectDir: dir, databases: DATABASES });

  state.processes[0].crash(1);
  // 重启是异步的，等它完成
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.strictEqual(state.started, 2);
  assert.strictEqual(supervisor.status().running, true);
  assert.strictEqual(supervisor.status().restarts, 1);

  await supervisor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('窗口内崩溃超过上限则放弃重启并记录原因', async () => {
  const dir = tempDir();
  const { supervisor, state } = makeSupervisor({ maxRestarts: 2 });
  await supervisor.start({ projectDir: dir, databases: DATABASES });

  state.processes[0].crash(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  state.processes[1].crash(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  state.processes[2].crash(1);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.strictEqual(supervisor.status().restarts, 2);
  assert.match(supervisor.status().lastError, /崩溃过于频繁/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('health：未运行时直接判定不健康', async () => {
  const { supervisor } = makeSupervisor();
  const result = await supervisor.health();
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, '服务未运行');
});

test('health：运行中但连不上时给出原因而不是抛异常', async () => {
  const dir = tempDir();
  const { supervisor } = makeSupervisor();
  await supervisor.start({ projectDir: dir, databases: DATABASES });

  const result = await supervisor.health();
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(typeof result.reason, 'string');

  await supervisor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
