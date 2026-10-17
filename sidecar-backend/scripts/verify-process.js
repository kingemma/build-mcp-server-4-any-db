'use strict';

/**
 * 真机验证：项目脚手架 + 进程托管。
 *
 * 用法：
 *   GRAPHJIN_BIN=D:/.../graphjin.exe node scripts/verify-process.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createProject, renderDevYaml } = require('../src/project');
const { GraphJinProcess, pickFreePort } = require('../src/graphjin-process');
const { GraphJinService } = require('../src/graphjin');

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

async function main() {
  // 渲染层：非法输入应直接抛错，避免产出会 panic 的配置
  record('缺少 databases 时抛错', (() => {
    try {
      renderDevYaml({ appName: 'x', port: 8080, databases: {} });
      return false;
    } catch (error) {
      return /databases 不能为空/.test(error.message);
    }
  })());

  const yaml = renderDevYaml({
    appName: 'Verify App',
    port: 8080,
    databases: {
      app: { type: 'sqlite', path: 'app.db', default: true },
      warehouse: { type: 'postgres', host: '127.0.0.1', port: 5432, dbname: 'wh', user: 'u' },
    },
  });
  record('只输出 databases map，无 sources', !/\bsources:/.test(yaml) && /\ndatabases:/.test(yaml));
  record('不输出单数 database', !/^database:/m.test(yaml));
  record('password 等空字段不落盘', !/password:/.test(yaml));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphjin-process-'));
  const port = await pickFreePort();
  createProject({
    dir,
    appName: 'Verify App',
    port,
    databases: { app: { type: 'sqlite', path: 'app.db', default: true } },
  });

  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'alpha'), (2, 'beta')");
  db.close();

  const process_ = new GraphJinProcess({ binPath: BIN, projectDir: dir });
  try {
    const baseUrl = await process_.start();
    record('进程启动并返回地址', baseUrl !== null, baseUrl);
    record('端口从启动横幅解析得到', process_.port === port, `期望 ${port}，实际 ${process_.port}`);

    const service = new GraphJinService({ baseUrl, role: 'admin' });
    await service.connect();
    const config = await service.assertLegacyMode();
    record('生成的项目通过方案 B 形态校验', Boolean(config.databases), JSON.stringify(Object.keys(config.databases ?? {})));

    await process_.stop();
    record('进程可停止', !process_.isRunning);
  } finally {
    await process_.stop();
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
