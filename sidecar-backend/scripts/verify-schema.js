'use strict';

/**
 * 真机验证：Schema 发现。
 *
 * 建一个带外键的 SQLite 库，拉起 GraphJin，用 query_catalog 发现表 / 列 / 关系，
 * 断言结果符合预期。
 *
 * 用法：
 *   GRAPHJIN_BIN=D:/.../graphjin.exe node scripts/verify-schema.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createProject } = require('../src/project');
const { GraphJinProcess, pickFreePort } = require('../src/graphjin-process');
const { GraphJinService } = require('../src/graphjin');
const { discoverSchema, listTables } = require('../src/schema');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphjin-schema-'));
  const port = await pickFreePort();
  createProject({
    dir,
    appName: 'Schema Verify',
    port,
    databases: { app: { type: 'sqlite', path: 'app.db', default: true } },
  });

  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, plan TEXT, mrr_cents INTEGER);
    CREATE TABLE users (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id), email TEXT);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id), amount_cents INTEGER);
  `);
  db.close();

  const gj = new GraphJinProcess({ binPath: BIN, projectDir: dir });
  try {
    await gj.start();
    const service = new GraphJinService({ baseUrl: gj.baseUrl, role: 'admin' });
    await service.connect();

    const schema = await discoverSchema(service.mcp);
    const names = schema.tables.map((t) => t.name).sort();
    record('发现 3 张表', names.length === 3, names.join(', '));
    record('带出 catalog revision', typeof schema.revision === 'string' && schema.revision.length > 0,
      String(schema.revision).slice(0, 16));

    const accounts = schema.tables.find((t) => t.name === 'accounts');
    record('accounts 主键识别正确', accounts?.primaryKey === 'id', String(accounts?.primaryKey));
    record('accounts 列完整', accounts?.columns.map((c) => c.name).join(',') === 'id,name,plan,mrr_cents',
      accounts?.columns.map((c) => c.name).join(','));
    record('列类型带出', accounts?.columns.find((c) => c.name === 'name')?.type === 'text',
      accounts?.columns.find((c) => c.name === 'name')?.type);
    record('主键列 marked', accounts?.columns.find((c) => c.name === 'id')?.primaryKey === true);

    record('发现 2 条外键关系', schema.relationships.length === 2,
      schema.relationships.map((r) => `${r.fromTable}->${r.toTable}`).join(', '));
    const rel = schema.relationships.find((r) => r.fromTable === 'invoices');
    record('关系字段完整',
      rel?.fromColumn === 'account_id' && rel?.toTable === 'accounts' && rel?.toColumn === 'id',
      JSON.stringify(rel));
    record('关系类型带出', rel?.relType === 'one_to_many', String(rel?.relType));

    const tables = await listTables(service.mcp);
    record('listTables 返回 3 条', tables.length === 3, tables.map((t) => t.name).join(', '));
    record('listTables 按库名+表名排序',
      tables.map((t) => t.name).join(',') === [...tables.map((t) => t.name)].sort().join(','),
      tables.map((t) => t.name).join(','));

    const scoped = await listTables(service.mcp, { database: 'app' });
    record('按库名过滤生效', scoped.length === 3, String(scoped.length));
  } finally {
    await gj.stop();
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
