'use strict';

/**
 * 真机验证：GraphJin 进程编排（启动 / 探活 / 崩溃自动重启 / 停止）。
 *
 * 用法：
 *   GRAPHJIN_BIN=D:/.../graphjin.exe node scripts/verify-supervisor.js
 *   GRAPHJIN_BIN=D:/.../graphjin.exe node scripts/verify-supervisor.js --crash
 *
 * 默认只验证启动 / 探活 / 停止。加 --crash 会额外杀掉进程验证自动重启，
 * 该过程需要多等约半分钟，故设为可选。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { GraphJinSupervisor, resolveGraphJinBinary } = require('../src/supervisor');

const BIN = process.env.GRAPHJIN_BIN;
if (!BIN) {
  console.error('请设置 GRAPHJIN_BIN 指向 graphjin 可执行文件');
  process.exit(2);
}

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待超时：${label}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphjin-supervisor-'));
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT)');
  db.close();

  const supervisor = new GraphJinSupervisor({ binPath: BIN });
  try {
    record('解析到的二进制存在', fs.existsSync(resolveGraphJinBinary(BIN)));

    const started = await supervisor.start({
      projectDir: dir,
      appName: 'Supervisor Verify',
      databases: { app: { type: 'sqlite', path: 'app.db', default: true } },
    });
    record('start 后处于运行态', started.running === true, `port=${started.port} pid=${started.pid}`);
    record('自动生成 dev.yml', fs.existsSync(path.join(dir, 'dev.yml')));
    record('基础状态干净', started.restarts === 0 && started.lastError === null);

    const healthy = await supervisor.health();
    record('health 探活成功', healthy.healthy === true, `httpStatus=${healthy.httpStatus}`);

    if (process.argv.includes('--crash')) {
      const killedPid = started.pid;
      process.kill(killedPid, 'SIGKILL');

      const restarted = await waitUntil(
        async () => {
          const status = supervisor.status();
          return status.running && status.restarts >= 1 ? status : null;
        },
        90_000,
        '崩溃后自动重启'
      );
      record('崩溃后自动重启', restarted.restarts >= 1, `restarts=${restarted.restarts}`);
      record('重启后换了新进程', restarted.pid !== killedPid, `${killedPid} → ${restarted.pid}`);

      const healthyAgain = await waitUntil(
        async () => (await supervisor.health()).healthy,
        60_000,
        '重启后探活'
      );
      record('重启后仍可探活', healthyAgain === true);
    } else {
      console.log('（跳过崩溃重启验证，加 --crash 启用）');
    }

    const stopped = await supervisor.stop();
    record('stop 后回到未运行', stopped.running === false);
  } finally {
    await supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`验证异常: ${error.stack ?? error.message}`);
  process.exit(1);
});
