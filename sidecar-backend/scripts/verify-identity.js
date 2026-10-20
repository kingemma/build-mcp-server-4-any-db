'use strict';

/**
 * 用户级身份真机验证。
 *
 * 目标：让「user-a 只看到自己的订单、user-b 看到全部」这类规则真正按「人」生效，
 * 而不是按「角色」生效（同一角色下所有人看到同一份数据）。
 *
 * 三条实测结论（2026-10-19，v3.21.14）：
 * 1. `auth.type: jwt` 的角色 claim 在 legacy `roles[].tables` 模式下不生效：
 *    token 能过签名校验（无 token / 伪造签名都 401），但 roles / role 两种 claim、
 *    MCP 与 HTTP GraphQL 两个端点都拿不到角色，请求一律按 anon 执行；
 * 2. `auth.type: none + auth.development: true` 下，`X-User-Role` 能定角色；
 * 3. `header_variables` 能把 `X-User-Code` 变成过滤器变量 `$user_code`，
 *    但**只有 HTTP GraphQL 端点透传自定义头**，MCP 的 execute_graphql 不透传 ——
 *    所以数据查询必须走 /api/v1/graphql，MCP 只用来写配置。
 *
 * 用法：
 *   GRAPHJIN_BIN=../binaries/graphjin-x86_64-pc-windows-msvc.exe node scripts/verify-identity.js
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { McpClient } = require('../src/mcp-client');

// spawn 的 cwd 会切到临时项目目录，相对路径会找不到，这里先解析成绝对路径
const BIN = process.env.GRAPHJIN_BIN ? path.resolve(process.env.GRAPHJIN_BIN) : null;
if (!BIN || !fs.existsSync(BIN)) {
  console.error(`请设置 GRAPHJIN_BIN 指向 graphjin 可执行文件（当前：${BIN ?? '未设置'}）`);
  process.exit(2);
}

const JWT_SECRET = 'verify-jwt-secret-0123456789abcdefghijklmnop';

const checks = [];
/** 实测确认的产品限制，不算失败但必须记录 */
const limitations = [];
/** GraphJin 子进程输出；401 这类问题只能从服务端日志看出来 */
const serverLogs = [];

function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function note(name, detail) {
  console.log(`NOTE  ${name}${detail ? `  — ${detail}` : ''}`);
}

const BASE_YML = (port, authBlock, failBlock, mode = 'dev') => `app_name: Identity Verify
mode: ${mode}
host_port: 0.0.0.0:${port}
web_ui: false
log_level: "warn"
production: false
default_block: false
secret_key: verify-secret
# dev 头模式下开这个会把 X-User-Role 请求一起拦成 401，只有 jwt 场景需要
auth_fail_block: ${failBlock}

identity:
  role_claims: ["roles"]
  user_id_claim: "sub"
  role_mode: "union"
  admin_roles: ["admin"]

${authBlock}

header_variables:
  user_code: "X-User-Code"

mcp:
  allow_config_updates: true
  allow_mutations: true
  allow_raw_queries: true
  allow_dev_tools: true

system:
  root_access:
    gj_config: admin
  capabilities:
    catalog.read: true
    config.read: true
    config.write: true

databases:
  app:
    type: sqlite
    path: app.db
    default: true
`;

const AUTH_DEV_HEADER = `auth:
  type: none
  development: true`;

const AUTH_JWT = `auth:
  type: jwt
  jwt:
    provider: other
    secret: ${JWT_SECRET}`;

// 官方文档里「按用户查库决定角色」的机制：JWT 的 sub 变成 $user_id 参与这条查询
const AUTH_JWT_ROLES_QUERY = `${AUTH_JWT}

roles_query: "select role_name from app.user_roles where user_id = $user_id"`;

/** 建库：orders 一张表，6 行分属 user-a / user-b，internal_note 用于验证列白名单 */
function createProject(dir, port, authBlock, failBlock, mode) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dev.yml'), BASE_YML(port, authBlock, failBlock, mode), 'utf8');

  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      order_no TEXT NOT NULL,
      owner_code TEXT NOT NULL,
      status TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      internal_note TEXT
    );
    INSERT INTO orders (id, order_no, owner_code, status, amount_cents, internal_note) VALUES
      (1, 'A-1001', 'user-a', 'paid',     19900, 'a 的内部备注 1'),
      (2, 'A-1002', 'user-a', 'pending',   9900, 'a 的内部备注 2'),
      (3, 'A-1003', 'user-a', 'paid',      4500, 'a 的内部备注 3'),
      (4, 'B-2001', 'user-b', 'paid',     32000, 'b 的内部备注 1'),
      (5, 'B-2002', 'user-b', 'refunded',  7800, 'b 的内部备注 2'),
      (6, 'B-2003', 'user-b', 'paid',     15600, 'b 的内部备注 3');

    -- roles_query 实验用：user_id -> 角色
    CREATE TABLE user_roles (
      user_id TEXT NOT NULL,
      role_name TEXT NOT NULL
    );
    INSERT INTO user_roles (user_id, role_name) VALUES
      ('user-a', 'customer'),
      ('user-b', 'customer');
  `);
  db.close();
}

/** 角色矩阵：customer 按 $user_code 过滤 + 列白名单；ops 全量读、可改可删 */
const ROLES_PATCH = {
  roles: [
    {
      name: 'customer',
      tables: [
        {
          name: 'orders',
          database: 'app',
          query: {
            block: false,
            filters: ['{ owner_code: { _eq: $user_code } }'],
            columns: ['id', 'order_no', 'owner_code', 'status', 'amount_cents'],
          },
          insert: { block: true },
          update: { block: true },
          delete: { block: true },
        },
      ],
    },
    {
      name: 'ops',
      tables: [
        {
          name: 'orders',
          database: 'app',
          query: { block: false },
          insert: { block: true },
          update: { block: false },
          delete: { block: false },
        },
      ],
    },
  ],
};

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

/** 任何 HTTP 响应都说明进程已经监听；未带 token 会返回 401，不能当成没起来 */
async function waitReady(baseUrl, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      });
      if (response.status > 0) return;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`GraphJin 在 ${timeoutMs}ms 内未就绪`);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/** 自签 HS256 JWT，供 JWT 路径实验用 */
function mintJwt(claims, secret = JWT_SECRET) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims }));
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function errorMessage(result) {
  const first = result?.errors?.[0];
  return typeof first === 'string' ? first : (first?.message ?? '');
}

/**
 * 走 HTTP GraphQL 端点执行数据查询。
 *
 * 必须走这个端点：MCP 的 execute_graphql 不透传自定义头，
 * header_variables 拿不到值，行过滤会退化成「匹配 0 行」。
 *
 * @param {string} baseUrl
 * @param {{role: string, userCode?: string}} identity
 * @param {string} query
 * @returns {Promise<Object>} { status, body }
 */
async function runGraphql(baseUrl, identity, query) {
  const headers = { 'Content-Type': 'application/json' };
  if (identity.role) headers['X-User-Role'] = identity.role;
  if (identity.userCode) headers['X-User-Code'] = identity.userCode;
  const response = await fetch(`${baseUrl}/api/v1/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function startServer(authBlock, label, failBlock = true, mode = 'dev') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphjin-identity-'));
  const port = await pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  createProject(dir, port, authBlock, failBlock, mode);

  const child = spawn(BIN, ['serve', '--path', dir], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
  child.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));
  console.log(`\n[${label}] 项目目录 ${dir}，端口 ${port}`);

  await waitReady(baseUrl);
  return {
    baseUrl,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (!child.killed) child.kill('SIGKILL');
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 句柄可能还占着
      }
    },
  };
}

/** 主场景：dev 头身份 —— X-User-Role 定角色，X-User-Code 定人 */
async function probeHeaderIdentity() {
  const server = await startServer(AUTH_DEV_HEADER, 'dev 头身份', false);
  try {
    const { baseUrl } = server;
    const admin = new McpClient({ baseUrl, role: 'admin' });
    await admin.connect();
    const applied = await admin.callTool('update_current_config', ROLES_PATCH);
    record('写入角色配置', applied?.success === true, JSON.stringify(applied?.errors ?? applied?.changes));

    // ---- 按人隔离：同一个 customer 角色，两个用户看到各自的行 ----
    const asA = await runGraphql(baseUrl, { role: 'customer', userCode: 'user-a' }, 'query { orders { id owner_code status } }');
    const rowsA = asA.body?.data?.orders ?? [];
    note('user-a 原始返回', JSON.stringify(asA.body).slice(0, 300));
    record(
      'user-a 只看到自己的 3 行',
      rowsA.length === 3 && rowsA.every((row) => row.owner_code === 'user-a'),
      `${rowsA.length} 行`
    );

    const asB = await runGraphql(baseUrl, { role: 'customer', userCode: 'user-b' }, 'query { orders { id owner_code status } }');
    const rowsB = asB.body?.data?.orders ?? [];
    record(
      'user-b 用同一角色也只看到自己的 3 行',
      rowsB.length === 3 && rowsB.every((row) => row.owner_code === 'user-b'),
      `${rowsB.length} 行`
    );
    record(
      '两个用户的行集不重叠',
      rowsA.length > 0 && !rowsA.some((row) => rowsB.some((other) => other.id === row.id))
    );

    // ---- 缺 X-User-Code 时的行为（记录，不判失败）----
    const noCode = await runGraphql(baseUrl, { role: 'customer' }, 'query { orders { id } }');
    note('只有角色、没有 X-User-Code 的返回', JSON.stringify(noCode.body).slice(0, 200));

    // ---- 列白名单 ----
    const withNote = await runGraphql(baseUrl, { role: 'customer', userCode: 'user-a' }, 'query { orders { id internal_note } }');
    note('customer 查 internal_note 的返回', JSON.stringify(withNote.body).slice(0, 300));
    record(
      'customer 查被屏蔽的列会报错',
      /blocked/i.test(errorMessage(withNote.body)),
      errorMessage(withNote.body)
    );

    // ---- user-b：全部订单 + 可更新 + 可删除 ----
    const opsAll = await runGraphql(baseUrl, { role: 'ops', userCode: 'user-b' }, 'query { orders { id owner_code internal_note } }');
    const opsRows = opsAll.body?.data?.orders ?? [];
    record(
      'user-b 看到全部 6 行且列不受限',
      opsRows.length === 6 && opsRows.every((row) => row.internal_note != null),
      `${opsRows.length} 行`
    );

    const updated = await runGraphql(
      baseUrl,
      { role: 'ops', userCode: 'user-b' },
      'mutation { orders(where: { id: { eq: 4 } }, update: { status: "refunded" }) { id status } }'
    );
    note('user-b 更新订单的返回', JSON.stringify(updated.body).slice(0, 300));
    const afterUpdate = await runGraphql(baseUrl, { role: 'ops' }, 'query { orders(where: { id: { eq: 4 } }) { id status } }');
    record(
      'user-b 能更新订单',
      afterUpdate.body?.data?.orders?.[0]?.status === 'refunded',
      JSON.stringify(afterUpdate.body?.data?.orders)
    );

    const deleted = await runGraphql(
      baseUrl,
      { role: 'ops', userCode: 'user-b' },
      'mutation { orders(where: { id: { eq: 6 } }, delete: true) { id } }'
    );
    note('user-b 删除订单的返回', JSON.stringify(deleted.body).slice(0, 300));
    const afterDelete = await runGraphql(baseUrl, { role: 'ops' }, 'query { orders { id } }');
    record(
      'user-b 能删除订单',
      (afterDelete.body?.data?.orders ?? []).length === 5,
      `${(afterDelete.body?.data?.orders ?? []).length} 行`
    );

    // ---- user-a 不该能改 ----
    const aUpdate = await runGraphql(
      baseUrl,
      { role: 'customer', userCode: 'user-a' },
      'mutation { orders(where: { id: { eq: 1 } }, update: { status: "cancelled" }) { id } }'
    );
    record('user-a 无法更新订单', /blocked/i.test(errorMessage(aUpdate.body)), errorMessage(aUpdate.body));

    const aDelete = await runGraphql(
      baseUrl,
      { role: 'customer', userCode: 'user-a' },
      'mutation { orders(where: { id: { eq: 1 } }, delete: true) { id } }'
    );
    record('user-a 无法删除订单', /blocked/i.test(errorMessage(aDelete.body)), errorMessage(aDelete.body));

    // ---- MCP 路径的已知缺陷：自定义头不透传 ----
    const mcpClient = new McpClient({ baseUrl, role: 'customer', headers: { 'X-User-Code': 'user-a' } });
    await mcpClient.connect();
    const viaMcp = await mcpClient.callTool('execute_graphql', { query: 'query { orders { id } }' });
    const mcpRows = viaMcp?.data?.orders ?? [];
    note('MCP execute_graphql 带 X-User-Code 的返回', `${mcpRows.length} 行（应为 0，说明头没透传）`);
    record('MCP execute_graphql 不透传自定义头（已知缺陷）', mcpRows.length === 0, `${mcpRows.length} 行`);
  } finally {
    await server.stop();
  }
}

/**
 * JWT 路径实验：记录「角色 claim 不生效」这个限制。
 *
 * 实测：token 能通过签名校验（无 token / 伪造签名都是 401），
 * 但 roles / role 两种 claim 形状、MCP 与 HTTP GraphQL 两个端点都拿不到角色，
 * 请求一律按 anon 执行（`default_block: false` 下等于全表可见）。
 */
async function probeJwt() {
  const server = await startServer(AUTH_JWT, 'JWT 实验');
  try {
    const { baseUrl } = server;
    const admin = new McpClient({
      baseUrl,
      headers: { Authorization: `Bearer ${mintJwt({ sub: 'admin', roles: ['admin'] })}` },
    });
    await admin.connect();
    const applied = await admin.callTool('update_current_config', ROLES_PATCH);
    record('jwt 模式下 admin 仍能写配置', applied?.success === true, JSON.stringify(applied?.errors ?? applied?.changes));

    let anonymous = null;
    try {
      const client = new McpClient({ baseUrl });
      await client.connect();
      anonymous = await client.callTool('execute_graphql', { query: 'query { orders { id } }' });
    } catch (error) {
      anonymous = { thrown: error.message };
    }
    note('jwt 模式无 token 的返回', JSON.stringify(anonymous).slice(0, 160));

    const jwtResponse = await fetch(`${baseUrl}/api/v1/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mintJwt({ sub: 'user-a', roles: ['customer'] })}`,
      },
      body: JSON.stringify({ query: 'query { orders { id owner_code } }' }),
    });
    const jwtBody = await jwtResponse.json().catch(() => null);
    const rows = jwtBody?.data?.orders ?? [];
    note('jwt 模式带 roles claim 的返回', `${rows.length} 行`);
    limitations.push(
      `JWT 角色 claim 不生效：token 可过签名校验，但角色未从 roles/role 解析，请求按 anon 执行（实测 ${rows.length} 行）`
    );
  } finally {
    await server.stop();
  }
}

/**
 * JWT + roles_query：官方文档里按用户查库定角色的机制。
 *
 * 若这条能通，JWT 方案就成立：sub 既是身份也是 `$user_id`，行过滤按人生效，
 * 角色由 user_roles 表决定（同一角色可被多个用户共享）。
 */
async function probeJwtRolesQuery() {
  const server = await startServer(AUTH_JWT_ROLES_QUERY, 'JWT + roles_query');
  try {
    const { baseUrl } = server;
    const admin = new McpClient({
      baseUrl,
      headers: { Authorization: `Bearer ${mintJwt({ sub: 'admin', roles: ['admin'] })}` },
    });
    await admin.connect();

    const applied = await admin.callTool('update_current_config', {
      roles: [
        {
          name: 'customer',
          tables: [
            {
              name: 'orders',
              database: 'app',
              query: {
                block: false,
                filters: ['{ owner_code: { _eq: $user_id } }'],
                columns: ['id', 'order_no', 'owner_code', 'status', 'amount_cents'],
              },
              insert: { block: true },
              update: { block: true },
              delete: { block: true },
            },
          ],
        },
      ],
    });
    record('roles_query 模式下写入角色配置', applied?.success === true, JSON.stringify(applied?.errors ?? applied?.changes));

    async function queryAsJwt(sub) {
      const response = await fetch(`${baseUrl}/api/v1/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mintJwt({ sub, roles: [] })}`,
        },
        body: JSON.stringify({ query: 'query { orders { id owner_code internal_note } }' }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }

    const asA = await queryAsJwt('user-a');
    const rowsA = asA.body?.data?.orders ?? [];
    note('roles_query: user-a 返回', `${rowsA.length} 行` + (errorMessage(asA.body) ? ` / ${errorMessage(asA.body)}` : ''));
    record(
      'roles_query 下 user-a 只看到自己的 3 行',
      rowsA.length === 3 && rowsA.every((row) => row.owner_code === 'user-a'),
      `${rowsA.length} 行`
    );
    record(
      'roles_query 下列白名单生效',
      rowsA.every((row) => row.internal_note == null),
      JSON.stringify(rowsA[0] ?? null)
    );

    const asB = await queryAsJwt('user-b');
    const rowsB = asB.body?.data?.orders ?? [];
    record(
      'roles_query 下 user-b 只看到自己的 3 行',
      rowsB.length === 3 && rowsB.every((row) => row.owner_code === 'user-b'),
      `${rowsB.length} 行`
    );
  } finally {
    await server.stop();
  }
}

/**
 * agentic 模式 + JWT：官方文档说 MCP 只在 agentic 模式挂载，且要求「verified roles」，
 * `auth.development`（头信任）会被拒绝启动。若这条能通，就不需要自建网关了。
 *
 * 过滤器用 `$user_id`（= JWT 的 sub），这也是文档里 owner 级访问的标准写法。
 */
async function probeAgentic() {
  let server;
  try {
    server = await startServer(AUTH_JWT, 'agentic + JWT', true, 'agentic');
  } catch (error) {
    limitations.push(`agentic 模式无法启动：${error.message}`);
    console.log(`NOTE  agentic 模式启动失败，跳过：${error.message}`);
    return;
  }

  try {
    const { baseUrl } = server;
    const admin = new McpClient({
      baseUrl,
      headers: { Authorization: `Bearer ${mintJwt({ sub: 'admin', roles: ['admin'] })}` },
    });
    await admin.connect();

    const applied = await admin.callTool('update_current_config', {
      roles: [
        {
          name: 'customer',
          tables: [
            {
              name: 'orders',
              database: 'app',
              query: {
                block: false,
                filters: ['{ owner_code: { _eq: $user_id } }'],
                columns: ['id', 'order_no', 'owner_code', 'status', 'amount_cents'],
              },
              insert: { block: true },
              update: { block: true },
              delete: { block: true },
            },
          ],
        },
      ],
    }).catch((error) => ({ success: false, errors: [error.message] }));
    record('agentic：写入角色配置', applied?.success === true, JSON.stringify(applied?.errors ?? applied?.changes));
    note('agentic：admin 可见工具', (await admin.listTools()).map((tool) => tool.name).join(', '));

    const asA = await runGraphql(baseUrl, { role: null, userCode: null }, 'query { orders { id owner_code } }');
    note('agentic：无身份访问 HTTP GraphQL', JSON.stringify(asA.body).slice(0, 200));

    async function queryWithJwt(sub) {
      const response = await fetch(`${baseUrl}/api/v1/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mintJwt({ sub, roles: ['customer'] })}`,
        },
        body: JSON.stringify({ query: 'query { orders { id owner_code internal_note } }' }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }

    const a = await queryWithJwt('user-a');
    const rowsA = a.body?.data?.orders ?? [];
    note('agentic：user-a 返回', `${rowsA.length} 行` + (errorMessage(a.body) ? ` / ${errorMessage(a.body)}` : ''));
    record(
      'agentic：JWT 的 sub 变成 $user_id，user-a 只看到自己的 3 行',
      rowsA.length === 3 && rowsA.every((row) => row.owner_code === 'user-a'),
      `${rowsA.length} 行`
    );
    record(
      'agentic：列白名单生效',
      rowsA.every((row) => row.internal_note == null),
      JSON.stringify(rowsA[0] ?? null)
    );

    const b = await queryWithJwt('user-b');
    const rowsB = b.body?.data?.orders ?? [];
    record(
      'agentic：user-b 只看到自己的 3 行',
      rowsB.length === 3 && rowsB.every((row) => row.owner_code === 'user-b'),
      `${rowsB.length} 行`
    );

    // MCP 路径是否也带身份（若 agentic 下 MCP 透传 JWT，行过滤就不用自建网关）
    const mcpClient = new McpClient({
      baseUrl,
      headers: { Authorization: `Bearer ${mintJwt({ sub: 'user-a', roles: ['customer'] })}` },
    });
    await mcpClient.connect();
    const viaMcp = await mcpClient.callTool('execute_graphql', { query: 'query { orders { id owner_code } }' });
    const mcpRows = viaMcp?.data?.orders ?? [];
    note('agentic：MCP execute_graphql 行数', `${mcpRows.length} 行`);
    record(
      'agentic：MCP execute_graphql 也按用户过滤',
      mcpRows.length === 3 && mcpRows.every((row) => row.owner_code === 'user-a'),
      `${mcpRows.length} 行`
    );
  } finally {
    await server.stop();
  }
}

async function main() {
  await probeHeaderIdentity();
  await probeJwt();
  await probeJwtRolesQuery();
  await probeAgentic();

  const failed = checks.filter((check) => !check.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (limitations.length > 0) {
    console.log('\n--- 已知限制 ---');
    for (const item of limitations) console.log(`- ${item}`);
  }
  if (failed.length > 0) {
    console.log('\n--- GraphJin 日志（末尾 30 行）---');
    console.log(serverLogs.join('').split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`验证异常: ${error.stack ?? error.message}`);
  console.log('\n--- GraphJin 日志（末尾 30 行）---');
  console.log(serverLogs.join('').split('\n').slice(-30).join('\n'));
  process.exit(1);
});
