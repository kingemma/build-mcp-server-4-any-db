'use strict';

/**
 * 端到端验证（Plan 任务 4.1 + 4.2）。
 *
 * 全链路都走平台真实的入口：拉起后端 → HTTP /rpc 建库、发现 Schema、配权限、
 * 起 GraphJin → 用生成的客户端配置真实建立 MCP 会话 → 以不同角色执行 GraphQL，
 * 断言只读角色无法写、列管控生效。
 *
 * 用法：node scripts/verify-e2e.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { McpClient } = require('../src/mcp-client');

const ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-builder-e2e-'));
const PROJECT_DIR = path.join(WORK_DIR, 'project');
const USER_DB = path.join(WORK_DIR, 'users.db');

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function waitFor(predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error('等待超时'));
      setTimeout(poll, 50);
    };
    poll();
  });
}

function createDatabase() {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(PROJECT_DIR, 'app.db'));
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, plan TEXT, mrr_cents INTEGER);
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY,
      account_id INTEGER REFERENCES accounts(id),
      amount_cents INTEGER
    );
  `);
  db.exec(`INSERT INTO accounts (id, name, plan, mrr_cents) VALUES
    (1, 'alpha', 'free', 100),
    (2, 'beta', 'pro', 200),
    (3, 'gamma', 'pro', 300)`);
  db.close();
}

function errorMessage(result) {
  const first = result?.errors?.[0];
  return typeof first === 'string' ? first : (first?.message ?? '');
}

async function main() {
  createDatabase();

  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, MCP_BUILDER_DB: USER_DB },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  const received = [];
  readline
    .createInterface({ input: child.stdout })
    .on('line', (line) => received.push(JSON.parse(line)));

  let port = 0;
  const rpc = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const payload = await response.json();
    if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
    return payload.result;
  };

  try {
    const ready = await waitFor(() => received.find((m) => m.method === 'ready'));
    port = ready.params.port;
    record('后端启动并推送 ready 端口', Number.isInteger(port), `port=${port}`);

    // 1. 建库 + 启动 GraphJin
    const started = await rpc('graphjin.start', {
      projectDir: PROJECT_DIR,
      appName: 'E2E',
      databases: { app: { type: 'sqlite', path: 'app.db', default: true } },
    });
    const baseUrl = started.baseUrl;
    record('GraphJin 启动', started.running === true, baseUrl);
    record('启动时补齐 admin 角色', started.adminRole?.created?.includes('admin') === true ||
      started.adminRole?.existing?.includes('admin') === true,
    JSON.stringify(started.adminRole ?? started.adminRoleError));

    // 2. Schema 发现
    const schema = await rpc('schema.discover', { baseUrl });
    const tableNames = schema.tables.map((table) => table.name).sort();
    record('发现 2 张表', tableNames.length === 2, tableNames.join(','));
    const accounts = schema.tables.find((table) => table.name === 'accounts');
    record('accounts 带出列定义', (accounts?.columns.length ?? 0) === 4,
      (accounts?.columns ?? []).map((column) => column.name).join(','));
    record('发现外键关系', schema.relationships.length >= 1,
      JSON.stringify(schema.relationships.map((rel) => `${rel.fromTable}->${rel.toTable}`)));

    // 3. 配权限：readonly 查询可读（带行过滤 + 列白名单），写全拦
    const applied = await rpc('permissions.apply', {
      baseUrl,
      database: 'app',
      matrix: {
        admin: {
          accounts: {
            query: { enabled: true },
            insert: { enabled: true },
            update: { enabled: true },
            delete: { enabled: true },
          },
        },
        readonly: {
          accounts: {
            query: {
              enabled: true,
              filters: ['{ id: { _gt: 1 } }'],
              columns: ['id', 'name'],
              limit: 50,
            },
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
      },
    });
    record('权限写入成功', applied.applied.success === true,
      (applied.applied.changes ?? []).join(' | '));
    record('写入前自动保存快照', Number.isInteger(applied.snapshot?.id),
      JSON.stringify(applied.snapshot ?? null));

    // 4. 以角色执行：查询通过、行过滤生效
    const readonlyQuery = await rpc('graphql.execute', {
      baseUrl,
      role: 'readonly',
      query: 'query { accounts { id name } }',
    });
    const rows = readonlyQuery?.data?.accounts ?? [];
    record('readonly 可查询', rows.length === 2, JSON.stringify(rows));
    record('readonly 行过滤生效', rows.every((row) => row.id > 1));

    // 5. 列管控：读被屏蔽的列要报错（不是静默）
    const blockedColumn = await rpc('graphql.execute', {
      baseUrl,
      role: 'readonly',
      query: 'query { accounts { id mrr_cents } }',
    });
    record('列白名单生效', errorMessage(blockedColumn).includes('db column blocked'),
      errorMessage(blockedColumn));

    // 6. 写操作全拦
    const insert = await rpc('graphql.execute', {
      baseUrl,
      role: 'readonly',
      query: 'mutation { accounts(insert: { name: "x", plan: "free", mrr_cents: 0 }) { id } }',
    });
    record('readonly 的 insert 被拦', errorMessage(insert).includes('Insert blocked: accounts'),
      errorMessage(insert));

    const update = await rpc('graphql.execute', {
      baseUrl,
      role: 'readonly',
      query: 'mutation { accounts(update: { plan: "pro" }, where: { id: { _eq: 2 } }) { id } }',
    });
    record('readonly 的 update 被拦', errorMessage(update).includes('Update blocked: accounts'),
      errorMessage(update));

    const remove = await rpc('graphql.execute', {
      baseUrl,
      role: 'readonly',
      query: 'mutation { accounts(delete: true, where: { id: { _eq: 9999 } }) { id } }',
    });
    record('readonly 的 delete 被拦', errorMessage(remove).includes('Delete blocked: accounts'),
      errorMessage(remove));

    // 7. source 模式没有「按角色屏蔽表」：grants 是加法，未列出的表对已认证角色全开。
    // no_access 的 query 虽然被关掉，但它仍然能读到 accounts —— 这是决策 A 接受的降级，
    // 记录成断言，避免以后误以为是回归。
    const none = await rpc('graphql.execute', {
      baseUrl,
      role: 'no_access',
      query: 'query { accounts { id } }',
    });
    record('无 grant 的角色仍可读（source 模式限制）',
      (none?.data?.accounts ?? []).length === 3,
      JSON.stringify(none?.data ?? none?.errors));

    // 8. 客户端配置 → 真实建一次 MCP 会话（模拟外部客户端接入）
    const config = await rpc('mcp.clientConfig', { baseUrl });
    const serverUrl = config.mcpServers?.GraphJin?.url ?? '';
    record('客户端配置指向 /api/v1/mcp', serverUrl.endsWith('/api/v1/mcp'), serverUrl);

    const client = new McpClient({ baseUrl, role: 'readonly' });
    await client.connect();
    const tools = (await client.listTools()).map((tool) => tool.name);
    record('外部客户端可握手并列出工具', tools.includes('execute_graphql'), tools.join(','));
    const viaClient = await client.callTool('execute_graphql', {
      query: 'query { accounts { id name } }',
    });
    record('外部客户端执行的查询受角色约束',
      (viaClient?.data?.accounts ?? []).length === 2,
      JSON.stringify(viaClient?.data ?? viaClient?.errors));

    // 9. 写入历史与回滚：恢复到写入前快照，本次新增的角色应被移除
    const history = await rpc('permissions.snapshots', { baseUrl, projectDir: PROJECT_DIR });
    record('写入历史可查询', history.length >= 1, JSON.stringify(history.map((item) => item.id)));

    const rolled = await rpc('permissions.rollback', {
      baseUrl,
      projectDir: PROJECT_DIR,
      id: applied.snapshot.id,
    });
    record('回滚成功', rolled.applied.success === true,
      (rolled.applied.changes ?? []).join(' | '));
    record('回滚移除了本次新增的角色', rolled.removed.includes('readonly') &&
      rolled.removed.includes('no_access'), JSON.stringify(rolled.removed));
    record('回滚前再次保存快照（回滚本身可撤销）', rolled.before.reason === 'before-rollback',
      JSON.stringify(rolled.before));

    const afterRollback = await rpc('config.current', { baseUrl });
    const roleNames = (afterRollback.roles ?? []).map((role) => role.name).sort();
    record('回滚后只剩 admin（受保护角色）', roleNames.includes('admin') &&
      !roleNames.includes('readonly') && !roleNames.includes('no_access'), roleNames.join(','));

    // 10. 停止
    const stopped = await rpc('graphjin.stop');
    record('GraphJin 已停止', stopped.running === false);
  } finally {
    child.stdin.end();
    await waitFor(() => child.exitCode !== null, 10_000).catch(() => {});
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    for (const check of failed) console.log(`  FAIL ${check.name}: ${check.detail ?? ''}`);
    if (stderr.length > 0) console.log(`\n后端 stderr:\n${stderr.join('').slice(-1500)}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`验证异常: ${error.stack ?? error.message}`);
  process.exit(1);
});
