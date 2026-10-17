'use strict';

/**
 * 方案 B 完整验证（运行时行为）。
 *
 * 自建一个双库 SQLite 项目，拉起 GraphJin，写入角色权限，然后以不同角色
 * 真实执行查询与变更，断言权限是否按配置生效。
 *
 * 用法：
 *   GRAPHJIN_BIN=D:/.../graphjin.exe node scripts/verify-plan-b.js
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { McpClient } = require('../src/mcp-client');
const { GraphJinService } = require('../src/graphjin');
const { buildRoleTableConfig } = require('../src/permissions');

const BIN = process.env.GRAPHJIN_BIN;
if (!BIN) {
  console.error('请设置 GRAPHJIN_BIN 指向 graphjin 可执行文件');
  process.exit(2);
}

const QUERY_ACCOUNTS = 'query { accounts(limit: 50) { id name } }';
// 不写 limit 时，role 的 query.limit 才会作为默认值生效
const QUERY_ACCOUNTS_NO_LIMIT = 'query { accounts { id name } }';
const QUERY_REGIONS = 'query { regions(limit: 50) { id name } }';
const INSERT_ACCOUNT =
  'mutation { accounts(insert: { name: "verify-co", plan: "free", status: "active", mrr_cents: 1 }) { id name } }';
const UPDATE_ACCOUNT =
  'mutation { accounts(update: { status: "churned" }, where: { id: { _eq: 1 } }) { id status } }';
const DELETE_ACCOUNT = 'mutation { accounts(delete: true, where: { id: { _eq: 99999 } }) { id } }';

const DEV_YML = (port) => `app_name: Plan B Verify
mode: dev
host_port: 0.0.0.0:${port}
web_ui: false
log_level: "warn"
production: false
default_block: false
secret_key: verify-secret

identity:
  role_claims: ["roles"]
  admin_roles: ["admin"]

auth:
  type: none
  development: true

mcp:
  allow_config_updates: true
  allow_dev_tools: true

system:
  root_access:
    gj_config: admin
  capabilities:
    catalog.read: true
    config.read: true
    config.write: true
    dev_tools.read: true
    security.read: true

artifacts:
  auto_init: true
  globals_path: ./config
  poll_seconds: 15
  schema: _graphjin

# 方案 B：databases map，不配 sources
databases:
  app:
    type: sqlite
    path: app.db
    default: true
  analytics:
    type: sqlite
    path: analytics.db
`;

function createDatabase(file, statements) {
  const db = new DatabaseSync(file);
  for (const sql of statements) db.exec(sql);
  db.close();
}

function createProject(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dev.yml'), DEV_YML(port), 'utf8');

  createDatabase(path.join(dir, 'app.db'), [
    'CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, plan TEXT, status TEXT, mrr_cents INTEGER)',
    'CREATE TABLE invoices (id INTEGER PRIMARY KEY, account_id INTEGER, amount_cents INTEGER)',
    `INSERT INTO accounts (id, name, plan, status, mrr_cents) VALUES
      (1, 'alpha', 'free', 'active', 100),
      (2, 'beta', 'pro', 'active', 200),
      (3, 'gamma', 'pro', 'active', 300),
      (4, 'delta', 'free', 'churned', 0)`,
  ]);

  createDatabase(path.join(dir, 'analytics.db'), [
    'CREATE TABLE regions (id INTEGER PRIMARY KEY, name TEXT)',
    "INSERT INTO regions (id, name) VALUES (1, 'apac'), (2, 'emea')",
  ]);
}

/** 占用一个空闲端口再释放，降低与 GraphJin 抢端口的概率 */
async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitReady(baseUrl, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      });
      if (response.ok) return;
    } catch {
      // 服务还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`GraphJin 在 ${timeoutMs}ms 内未就绪`);
}

async function callAsRole(baseUrl, role, query) {
  const client = new McpClient({ baseUrl, role });
  await client.connect();
  return client.callTool('execute_graphql', { query });
}

function errorMessage(result) {
  const first = result?.errors?.[0];
  return typeof first === 'string' ? first : (first?.message ?? '');
}

function isBlocked(result, verb, table, role) {
  return errorMessage(result) === `${verb} blocked: ${table} (role: ${role})`;
}

function rowsOf(result, root) {
  return result?.data?.[root] ?? [];
}

/**
 * query 被 block 时 GraphJin 不报错，而是静默把该 root 返回为 null。
 * 实测：{"data":{"accounts":null},"next":{"state_code":"graphql_execution_success"}}
 */
function isSilentlyBlocked(result, root) {
  return result?.data?.[root] === null && !result?.errors;
}

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphjin-plan-b-'));
  const port = await pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  createProject(dir, port);

  const child = spawn(BIN, ['serve', '--path', dir], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = [];
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  console.log(`项目目录 ${dir}，端口 ${port}`);

  try {
    await waitReady(baseUrl);

    const service = new GraphJinService({ baseUrl, role: 'admin' });
    await service.connect();
    await service.assertLegacyMode();

    const patch = buildRoleTableConfig('app', {
      admin: {
        accounts: {
          query: { enabled: true, limit: 100 },
          insert: { enabled: true },
          update: { enabled: true },
          delete: { enabled: true },
        },
      },
      readonly: {
        accounts: {
          // limit 2 + 行过滤 id > 2，用于验证两者都真的生效
          query: { enabled: true, limit: 2, filters: ['{ id: { _gt: 2 } }'] },
          insert: { enabled: false },
          update: { enabled: false },
          delete: { enabled: false },
        },
      },
      no_access: {
        accounts: {
          query: { enabled: false },
          insert: { enabled: false },
          update: { enabled: false },
          delete: { enabled: false },
        },
      },
    });
    // 第二个库上的角色，验证 database 字段确实把规则路由到 analytics
    const analyticsPatch = buildRoleTableConfig('analytics', {
      bi: {
        regions: {
          query: { enabled: true, limit: 5 },
          insert: { enabled: false },
          update: { enabled: false },
          delete: { enabled: false },
        },
      },
    });

    const applied = await service.applyConfig({
      roles: [...patch.roles, ...analyticsPatch.roles],
    });
    record('配置写入成功', applied?.success === true, JSON.stringify(applied?.changes));

    // 1. admin 全通
    const adminQuery = await callAsRole(baseUrl, 'admin', QUERY_ACCOUNTS);
    record('admin 可查询 accounts', rowsOf(adminQuery, 'accounts').length === 4,
      `返回 ${rowsOf(adminQuery, 'accounts').length} 行`);

    const adminInsert = await callAsRole(baseUrl, 'admin', INSERT_ACCOUNT);
    record('admin 可 insert', Array.isArray(rowsOf(adminInsert, 'accounts')),
      errorMessage(adminInsert) || 'ok');

    const adminUpdate = await callAsRole(baseUrl, 'admin', UPDATE_ACCOUNT);
    record('admin 可 update', Array.isArray(rowsOf(adminUpdate, 'accounts')),
      errorMessage(adminUpdate) || 'ok');

    const adminDelete = await callAsRole(baseUrl, 'admin', DELETE_ACCOUNT);
    record('admin 可 delete', !isBlocked(adminDelete, 'Delete', 'accounts', 'admin'),
      errorMessage(adminDelete) || 'ok');

    // 2. readonly：查询可用，写操作全拦
    // admin 上一步 insert 了一行，所以符合 id > 2 的有 3 行
    const roQuery = await callAsRole(baseUrl, 'readonly', QUERY_ACCOUNTS_NO_LIMIT);
    const roRows = rowsOf(roQuery, 'accounts');
    record('readonly 可查询 accounts', roRows.length > 0, `返回 ${roRows.length} 行`);
    record('readonly 的 limit 作为默认值生效', roRows.length === 2,
      `期望 2 行，实际 ${roRows.length}`);
    record('readonly 的行过滤生效', roRows.length > 0 && roRows.every((row) => row.id > 2),
      `ids=${JSON.stringify(roRows.map((r) => r.id))}`);

    // 反向确认：显式 limit 会覆盖 role 的 limit，它不是强制上限
    const roExplicit = await callAsRole(baseUrl, 'readonly', QUERY_ACCOUNTS);
    const roExplicitRows = rowsOf(roExplicit, 'accounts');
    record('显式 limit 可覆盖 role limit（role limit 非强制上限）',
      roExplicitRows.length > 2,
      `显式 limit:50 返回 ${roExplicitRows.length} 行，超过 role 的 2`);

    const roInsert = await callAsRole(baseUrl, 'readonly', INSERT_ACCOUNT);
    record('readonly 的 insert 被拦', isBlocked(roInsert, 'Insert', 'accounts', 'readonly'),
      errorMessage(roInsert));

    const roUpdate = await callAsRole(baseUrl, 'readonly', UPDATE_ACCOUNT);
    record('readonly 的 update 被拦', isBlocked(roUpdate, 'Update', 'accounts', 'readonly'),
      errorMessage(roUpdate));

    const roDelete = await callAsRole(baseUrl, 'readonly', DELETE_ACCOUNT);
    record('readonly 的 delete 被拦', isBlocked(roDelete, 'Delete', 'accounts', 'readonly'),
      errorMessage(roDelete));

    // 3. no_access：连查询也被拦（表现为静默返回 null，而不是报错）
    const naQuery = await callAsRole(baseUrl, 'no_access', QUERY_ACCOUNTS);
    record('no_access 的 query 被拦（静默返回 null）',
      isSilentlyBlocked(naQuery, 'accounts'),
      JSON.stringify(naQuery?.data ?? naQuery?.errors));

    const naInsert = await callAsRole(baseUrl, 'no_access', INSERT_ACCOUNT);
    record('no_access 的 insert 被拦', isBlocked(naInsert, 'Insert', 'accounts', 'no_access'),
      errorMessage(naInsert));

    // 4. 多库：bi 角色只看得到 analytics 的 regions
    const biRegions = await callAsRole(baseUrl, 'bi', QUERY_REGIONS);
    record('多库：bi 可查询 analytics.regions', rowsOf(biRegions, 'regions').length === 2,
      errorMessage(biRegions) || `返回 ${rowsOf(biRegions, 'regions').length} 行`);

    const biInsert = await callAsRole(baseUrl, 'bi', 'mutation { regions(insert: { name: "latam" }) { id } }');
    record('多库：bi 的 insert 被拦', isBlocked(biInsert, 'Insert', 'regions', 'bi'),
      errorMessage(biInsert));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    for (const check of failed) console.log(`  FAIL ${check.name}: ${check.detail ?? ''}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`验证异常: ${error.stack ?? error.message}`);
  process.exit(1);
});
