'use strict';

/**
 * 生成订单演示数据：demo 库 + 用户/组织 + 权限矩阵，并跑一遍真实查询验证。
 *
 * 建成后的效果：
 * - user-a（角色 customer）只看到属于自己邮箱的 3 条订单，且看不到 internal_note；
 * - user-b（角色 ops）看到全部 6 条，并且能更新、删除。
 *
 * 行过滤靠 `{ owner_code: { _eq: $user_code } }` + dev.yml 的 header_variables，
 * `$user_code` 由 X-User-Code 请求头注入 —— 角色仍是共享的，用户维度才是个体。
 *
 * 用法：
 *   npm run demo:orders                       # 写入开发数据目录
 *   npm run demo:orders -- --db <路径>        # 指定 Electron 的 mcp-builder.db
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createBackend } = require('../sidecar-backend/src/index');
const { GraphJinService } = require('../sidecar-backend/src/graphjin');
const { McpClient } = require('../sidecar-backend/src/mcp-client');

const ROOT = path.join(__dirname, '..');
const PROJECT_DIR = path.join(ROOT, 'projects', 'demo-orders');
const DEMO_DB = path.join(PROJECT_DIR, 'demo.db');

const USER_A = { name: 'User A', email: 'user-a@demo.local', role: 'customer' };
const USER_B = { name: 'User B', email: 'user-b@demo.local', role: 'ops' };

/** 6 条订单：3 条归 user-a，3 条归 user-b；internal_note 用来验证列白名单 */
const ORDERS = [
  { id: 1, order_no: 'A-1001', owner_code: USER_A.email, status: 'paid', total_cents: 19900, internal_note: 'a 的内部备注 1' },
  { id: 2, order_no: 'A-1002', owner_code: USER_A.email, status: 'pending', total_cents: 9900, internal_note: 'a 的内部备注 2' },
  { id: 3, order_no: 'A-1003', owner_code: USER_A.email, status: 'paid', total_cents: 4500, internal_note: 'a 的内部备注 3' },
  { id: 4, order_no: 'B-2001', owner_code: USER_B.email, status: 'paid', total_cents: 32000, internal_note: 'b 的内部备注 1' },
  { id: 5, order_no: 'B-2002', owner_code: USER_B.email, status: 'refunded', total_cents: 7800, internal_note: 'b 的内部备注 2' },
  { id: 6, order_no: 'B-2003', owner_code: USER_B.email, status: 'paid', total_cents: 15600, internal_note: 'b 的内部备注 3' },
];

const ROLES_PATCH = {
  roles: [
    {
      name: 'customer',
      tables: [
        {
          name: 'orders',
          database: 'demo',
          query: {
            block: false,
            filters: ['{ owner_code: { _eq: $user_code } }'],
            columns: ['id', 'order_no', 'owner_code', 'status', 'total_cents', 'created_at'],
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
          database: 'demo',
          query: { block: false },
          insert: { block: true },
          update: { block: false },
          delete: { block: false },
        },
      ],
    },
  ],
};

function seedDatabase() {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  const db = new DatabaseSync(DEMO_DB);
  try {
    db.exec(`
      DROP TABLE IF EXISTS orders;
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        order_no TEXT NOT NULL,
        owner_code TEXT NOT NULL,
        status TEXT NOT NULL,
        total_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        internal_note TEXT
      );
    `);
    const insert = db.prepare(
      `INSERT INTO orders (id, order_no, owner_code, status, total_cents, created_at, internal_note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const order of ORDERS) {
      insert.run(
        order.id,
        order.order_no,
        order.owner_code,
        order.status,
        order.total_cents,
        '2026-10-01 09:00:00',
        order.internal_note
      );
    }
  } finally {
    db.close();
  }
}

async function rpc(router, method, params = {}) {
  const response = await router.dispatch({ jsonrpc: '2.0', id: 1, method, params });
  if (response?.error) throw new Error(`${method} 失败：${response.error.message}`);
  return response?.result;
}

/** 建组织/用户，已存在时复用，保证脚本可重复执行 */
async function ensureUsers(router) {
  const organizations = await rpc(router, 'users.listOrganizations');
  const organization =
    organizations.find((item) => item.name === 'demo-shop') ??
    (await rpc(router, 'users.createOrganization', { name: 'demo-shop' }));

  const existing = await rpc(router, 'users.list');
  const pick = (definition) => existing.find((user) => user.email === definition.email);

  const userA =
    pick(USER_A) ??
    (await rpc(router, 'users.create', {
      organizationId: organization.id,
      name: USER_A.name,
      email: USER_A.email,
      role: USER_A.role,
    }));
  const userB =
    pick(USER_B) ??
    (await rpc(router, 'users.create', {
      organizationId: organization.id,
      name: USER_B.name,
      email: USER_B.email,
      role: USER_B.role,
    }));

  // 角色可能被改过，这里拉回演示需要的样子
  if (userA.role !== USER_A.role) await rpc(router, 'users.setRole', { userId: userA.id, role: USER_A.role });
  if (userB.role !== USER_B.role) await rpc(router, 'users.setRole', { userId: userB.id, role: USER_B.role });

  return { organization, userA, userB };
}

function print(title, value) {
  console.log(`\n${title}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const dbFlag = process.argv.indexOf('--db');
  const dbPath = dbFlag > -1 ? path.resolve(process.argv[dbFlag + 1]) : null;

  seedDatabase();
  console.log(`演示库：${DEMO_DB}`);

  const backend = await createBackend(dbPath ? { dbPath } : {});
  console.log(`平台库：${backend.dbPath}`);
  console.log(`网关：  ${backend.gatewayUrl}`);

  const failures = [];
  const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
    if (!pass) failures.push(name);
  };

  try {
    const { userA, userB } = await ensureUsers(backend.router);

    const status = await rpc(backend.router, 'graphjin.start', {
      projectDir: PROJECT_DIR,
      appName: 'Demo Orders',
      databases: { demo: { type: 'sqlite', path: DEMO_DB, default: true } },
    });
    const baseUrl = status.baseUrl;
    console.log(`GraphJin：${baseUrl}`);

    const service = new GraphJinService({ baseUrl, role: 'admin' });
    await service.connect();
    const applied = await service.applyConfig(ROLES_PATCH);
    check('权限矩阵写入成功', applied?.success === true, JSON.stringify(applied?.errors ?? []));

    const tokenA = await rpc(backend.router, 'auth.token', { userId: userA.id });
    const tokenB = await rpc(backend.router, 'auth.token', { userId: userB.id });

    const execute = (identity, query) =>
      rpc(backend.router, 'graphql.execute', { baseUrl, ...identity, query });

    // ---- user-a：只看自己的、只看白名单列 ----
    const asA = await execute(
      { role: USER_A.role, userCode: USER_A.email },
      'query { orders { id order_no owner_code status total_cents } }'
    );
    const rowsA = asA?.data?.orders ?? [];
    check(
      'user-a 只看到自己的 3 条订单',
      rowsA.length === 3 && rowsA.every((row) => row.owner_code === USER_A.email),
      `${rowsA.length} 条：${rowsA.map((row) => row.order_no).join(', ')}`
    );

    const hidden = await execute({ role: USER_A.role, userCode: USER_A.email }, 'query { orders { id internal_note } }');
    const hiddenMessage = hidden?.errors?.[0]?.message ?? '';
    check('user-a 看不到 internal_note', /blocked/i.test(hiddenMessage), hiddenMessage);

    const aWrite = await execute(
      { role: USER_A.role, userCode: USER_A.email },
      'mutation { orders(where: { id: { eq: 1 } }, delete: true) { id } }'
    );
    check(
      'user-a 不能删除订单',
      /blocked/i.test(aWrite?.errors?.[0]?.message ?? ''),
      aWrite?.errors?.[0]?.message
    );

    // ---- user-b：全部数据 + 可改可删 ----
    const asB = await execute({ role: USER_B.role, userCode: USER_B.email }, 'query { orders { id order_no owner_code internal_note } }');
    const rowsB = asB?.data?.orders ?? [];
    check(
      'user-b 看到全部 6 条且列不受限',
      rowsB.length === 6 && rowsB.every((row) => row.internal_note != null),
      `${rowsB.length} 条`
    );

    const updated = await execute(
      { role: USER_B.role, userCode: USER_B.email },
      'mutation { orders(where: { id: { eq: 4 } }, update: { status: "refunded" }) { id status } }'
    );
    check(
      'user-b 能更新订单',
      updated?.data?.orders?.[0]?.status === 'refunded',
      JSON.stringify(updated?.data?.orders ?? updated?.errors)
    );

    const deleted = await execute(
      { role: USER_B.role, userCode: USER_B.email },
      'mutation { orders(where: { id: { eq: 6 } }, delete: true) { id } }'
    );
    const afterDelete = await execute({ role: USER_B.role, userCode: USER_B.email }, 'query { orders { id } }');
    check(
      'user-b 能删除订单',
      (afterDelete?.data?.orders ?? []).length === 5,
      `${(afterDelete?.data?.orders ?? []).length} 条 · ${JSON.stringify(deleted?.errors ?? '')}`
    );

    // 还原被改动和删除的行，保证脚本可重复执行
    await execute(
      { role: USER_B.role, userCode: USER_B.email },
      'mutation { orders(where: { id: { eq: 4 } }, update: { status: "paid" }) { id } }'
    );
    const removed = ORDERS.find((order) => order.id === 6);
    await execute(
      { role: USER_B.role, userCode: USER_B.email },
      `mutation {
        orders(insert: {
          id: 6, order_no: "${removed.order_no}", owner_code: "${removed.owner_code}",
          status: "${removed.status}", total_cents: ${removed.total_cents},
          created_at: "2026-10-01 09:00:00", internal_note: "${removed.internal_note}"
        }) { id }
      }`
    );

    // ---- 网关链路：令牌 → 角色注入 ----
    const gatewayClient = new McpClient({
      baseUrl: `http://127.0.0.1:${backend.port}`,
      headers: { Authorization: `Bearer ${tokenA.token}` },
    });
    await gatewayClient.connect();
    const viaGateway = await gatewayClient.callTool('execute_graphql', {
      query: 'query { orders { id internal_note } }',
    });
    check(
      '网关：user-a 的令牌被识别为 customer 角色',
      /blocked/i.test(viaGateway?.errors?.[0]?.message ?? ''),
      viaGateway?.errors?.[0]?.message ?? '未被拦截'
    );

    const anonymousClient = new McpClient({ baseUrl: `http://127.0.0.1:${backend.port}` });
    let anonymousRejected = false;
    try {
      await anonymousClient.connect();
    } catch (error) {
      anonymousRejected = /401/.test(error.message);
    }
    check('网关：无令牌被拒绝', anonymousRejected);

    // ---- 客户端接入信息 ----
    const configA = await rpc(backend.router, 'mcp.clientConfig', {
      baseUrl,
      gatewayUrl: backend.gatewayUrl,
      token: tokenA.token,
      name: 'DemoOrders-UserA',
    });
    print('user-a 的 MCP 客户端配置（粘进 Claude/Cursor）', configA.mcpServers);
    console.log(`\nuser-b 的令牌（12 小时有效）：${tokenB.token}`);
    console.log('user-a 的令牌：' + tokenA.token);
  } finally {
    await backend.stop();
  }

  console.log(`\n合计 ${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`种子数据失败：${error.stack ?? error.message}`);
  process.exit(1);
});
