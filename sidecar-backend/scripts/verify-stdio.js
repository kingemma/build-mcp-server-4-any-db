'use strict';

/**
 * 验证 Tauri ↔ 后端的 stdin/stdout JSON-RPC 契约。
 *
 * 后端启动后应主动推一条 ready 通知（带实际端口），之后逐行响应请求。
 *
 * 用法：node scripts/verify-stdio.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-builder-')), 'users.db');

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function waitFor(predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error('等待响应超时'));
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function main() {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, MCP_BUILDER_DB: dbPath },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  const received = [];
  readline
    .createInterface({ input: child.stdout })
    .on('line', (line) => received.push(JSON.parse(line)));

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  try {
    const ready = await waitFor(() => received.find((m) => m.method === 'ready'));
    record('启动后推送 ready 通知', Number.isInteger(ready.params.port), `port=${ready.params.port}`);

    send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const pong = await waitFor(() => received.find((m) => m.id === 1));
    record('ping 返回结果', pong.result === 'pong', JSON.stringify(pong.result));

    send({ jsonrpc: '2.0', id: 2, method: 'users.createOrganization', params: { name: 'Acme' } });
    const org = await waitFor(() => received.find((m) => m.id === 2));
    record('创建组织', org.result?.name === 'Acme', JSON.stringify(org.result));

    send({
      jsonrpc: '2.0', id: 3, method: 'users.create',
      params: { organizationId: org.result.id, name: 'Alice', email: 'a@acme.test', role: 'admin' },
    });
    const user = await waitFor(() => received.find((m) => m.id === 3));
    record('创建用户', user.result?.role === 'admin', JSON.stringify(user.result));

    send({ jsonrpc: '2.0', id: 4, method: 'users.listRoles' });
    const roles = await waitFor(() => received.find((m) => m.id === 4));
    record('列出角色', JSON.stringify(roles.result) === '["admin"]', JSON.stringify(roles.result));

    const before = received.length;
    send({ jsonrpc: '2.0', method: 'note', params: {} });
    await new Promise((resolve) => setTimeout(resolve, 500));
    record('通知（无 id）不回响应', received.length === before, `新增 ${received.length - before} 条`);

    send({ jsonrpc: '2.0', id: 6, method: 'users.setRole', params: { userId: 'x', role: 'admin' } });
    const invalid = await waitFor(() => received.find((m) => m.id === 6));
    record('参数非法返回 INVALID_PARAMS', invalid.error?.code === -32602, JSON.stringify(invalid.error));

    child.stdin.write('{ not json\n');
    const parseError = await waitFor(() => received.find((m) => m.error?.code === -32700));
    record('非法 JSON 返回 parse error', parseError.error.code === -32700);
  } finally {
    // 必须等进程真正退出，否则 SQLite 文件仍被占用，删除会 EPERM
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    console.error(stderr.join(''));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`验证异常: ${error.stack ?? error.message}`);
  process.exit(1);
});
