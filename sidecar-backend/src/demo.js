#!/usr/bin/env node
'use strict';

/**
 * 一键演示项目：两个示例库（财务系统 / 库存管理系统）+ 各库一个只读角色（带行过滤）。
 *
 * 演示的价值在于「不碰自己的库就能看到权限生效」：两张库都带 owner_code，
 * 角色只能看到自己名下的行，写删一律 blocked —— 打开权限矩阵就能看到这套规则。
 *
 * 每个库一个角色是为了演示「角色 × 库」：finance_analyst 在 inventory 库里没有
 * 任何 grant，换库就是换身份，而不是「一个只读角色走天下」。两库的业务毫无关系
 * （财务 / 库存），也顺带说明平台不预设行业。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createProject, replaceRolesBlock } = require('./project');

const DEMO_APP_NAME = 'Demo Finance & Inventory';

const FINANCE_DATABASE = 'finance.db';
const INVENTORY_DATABASE = 'inventory.db';

/** 落盘「已保存连接」用：两个库各一条，只记一条会让删连接误伤另一个库 */
const DEMO_CONNECTIONS = [
  { name: 'finance', connection: { type: 'sqlite', path: FINANCE_DATABASE } },
  { name: 'inventory', connection: { type: 'sqlite', path: INVENTORY_DATABASE } },
];

/** 每个库一个只读角色：角色 × 库 的演示 */
const ROLE_BY_DATABASE = { finance: 'finance_analyst', inventory: 'inventory_viewer' };

/** 行过滤：只能看到自己名下的行 */
const DEMO_FILTER = '{ owner_code: { _eq: $user_code } }';

/**
 * 「本库没你的份」的 grant。
 *
 * 实测（2026-10-24）：source 级 `read: authenticated` 的含义是**任何已认证角色都能读**，
 * 没被 grants 点名的角色不会因此被挡，反而拿不到 columns 白名单与 filter —— 权限比
 * 点名角色还大。所以「换库换身份」不能靠「不给 grant」实现，只能显式给一份查不到
 * 任何行的 filter。这条实测结论同样适用于平台自己写的配置：别用「没写 grant」当拒绝。
 */
const DENY_FILTER = '{ owner_code: { _eq: "__not_granted__" } }';

/** 归属取值：数据必须分散到几个 owner 上，行过滤才看得出差别 */
const OWNERS = ['hq', 'sh', 'gz'];

/** 演示数据的账期：跨 8 / 9 / 10 三个月，月度口径才有东西可看 */
const FINANCE_START = Date.UTC(2026, 7, 3);
const INVENTORY_START = Date.UTC(2026, 7, 5);
const DAY = 24 * 60 * 60 * 1000;

/** @param {number} epoch @returns {string} YYYY-MM-DD */
function isoDay(epoch) {
  return new Date(epoch).toISOString().slice(0, 10);
}

/** @param {number} value @returns {number} 两位小数，金额不能出现浮点尾巴 */
function money(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 用「序号取模」而不是随机数：每次重建演示项目都得到同一份数据，
 * 文档里的截图与断言才能对得上。
 *
 * @param {number} seed
 * @param {Array} list
 */
function pick(seed, list) {
  return list[seed % list.length];
}

/* ------------------------------------------------------------------ 财务系统 */

/** 会计科目：真实科目编码 + 类别，24 个 */
const ACCOUNTS = [
  ['1001', '库存现金', '资产'],
  ['1002', '银行存款', '资产'],
  ['1122', '应收账款', '资产'],
  ['1231', '其他应收款', '资产'],
  ['1403', '原材料', '资产'],
  ['1405', '库存商品', '资产'],
  ['1601', '固定资产', '资产'],
  ['1701', '无形资产', '资产'],
  ['2001', '短期借款', '负债'],
  ['2202', '应付账款', '负债'],
  ['2211', '应付职工薪酬', '负债'],
  ['2221', '应交税费', '负债'],
  ['2501', '长期借款', '负债'],
  ['4001', '实收资本', '权益'],
  ['4002', '资本公积', '权益'],
  ['4101', '盈余公积', '权益'],
  ['5001', '主营业务收入', '收入'],
  ['5051', '其他业务收入', '收入'],
  ['5301', '营业外收入', '收入'],
  ['6001', '主营业务成本', '成本'],
  ['6401', '销售费用', '费用'],
  ['6601', '管理费用', '费用'],
  ['6602', '财务费用', '费用'],
  ['6801', '所得税费用', '费用'],
];

const FINANCE_CUSTOMERS = [
  '华东精密机械有限公司',
  '南方水务工程集团',
  '恒通物流股份有限公司',
  '北斗电子设备厂',
  '云锦纺织有限公司',
  '中启建设集团第三分公司',
  '海川食品有限公司',
  '广联医疗器械有限公司',
];

/** @returns {Array} accounts 行 */
function buildAccounts() {
  return ACCOUNTS.map(([code, name, category], index) => [
    index + 1,
    code,
    name,
    category,
    pick(index, OWNERS),
  ]);
}

/** @returns {Array} vouchers 行 */
function buildVouchers() {
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    const booked = isoDay(FINANCE_START + i * 2 * DAY);
    rows.push([
      i + 1,
      `记-${booked.slice(0, 7)}-${String(i + 1).padStart(4, '0')}`,
      booked,
      booked.slice(0, 7),
      i % 11 === 7 ? 'voided' : i % 9 === 4 ? 'draft' : 'posted',
      pick(i, OWNERS),
    ]);
  }
  return rows;
}

/**
 * 凭证分录：每张凭证三条（借应收 / 贷收入 / 贷税额），借贷必须平。
 * 不平的分录会让「按科目汇总」演示出一个对不上的数，那比没有数据更糟。
 *
 * @param {Array} vouchers
 * @returns {Array}
 */
function buildVoucherEntries(vouchers) {
  const rows = [];
  let id = 1;
  for (const voucher of vouchers) {
    const [voucherId, , , , , owner] = voucher;
    const gross = money(1200 + ((voucherId * 7331) % 8800) / 10);
    const tax = money(gross * 0.13);
    const net = money(gross - tax);
    rows.push([id++, voucherId, 3, 'debit', gross, '应收销项', owner]);
    rows.push([id++, voucherId, 17, 'credit', net, '确认收入', owner]);
    rows.push([id++, voucherId, 12, 'credit', tax, '销项税额', owner]);
  }
  return rows;
}

/** @param {Array} vouchers @returns {Array} invoices 行 */
function buildInvoices(vouchers) {
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    const voucher = vouchers[i];
    const issuedAt = voucher[2];
    const gross = money(1200 + ((voucher[0] * 7331) % 8800) / 10);
    rows.push([
      i + 1,
      `INV-${String(i + 1).padStart(6, '0')}`,
      voucher[0],
      pick(i, FINANCE_CUSTOMERS),
      gross,
      money(gross * 0.13),
      i < 20 ? 'paid' : i === 28 ? 'void' : 'issued',
      issuedAt,
      voucher[5],
    ]);
  }
  return rows;
}

/** 收款只挂在已付发票上：没收到的钱记成收款，演示口径就错了 @param {Array} invoices */
function buildPayments(invoices) {
  const rows = [];
  let id = 1;
  for (const invoice of invoices) {
    if (invoice[6] !== 'paid') continue;
    const issued = Date.parse(`${invoice[7]}T00:00:00Z`);
    rows.push([
      id++,
      invoice[0],
      invoice[4],
      pick(id, ['transfer', 'card', 'cash']),
      isoDay(issued + (id % 9 + 1) * DAY),
      invoice[8],
    ]);
  }
  return rows;
}

function seedFinanceDatabase(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FINANCE_DATABASE);
  if (fs.existsSync(file)) fs.rmSync(file);

  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE vouchers (
        id INTEGER PRIMARY KEY,
        voucher_no TEXT NOT NULL,
        booked_at TEXT NOT NULL,
        period TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE voucher_entries (
        id INTEGER PRIMARY KEY,
        voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        direction TEXT NOT NULL,
        amount REAL NOT NULL,
        memo TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE invoices (
        id INTEGER PRIMARY KEY,
        invoice_no TEXT NOT NULL,
        voucher_id INTEGER REFERENCES vouchers(id),
        customer_name TEXT NOT NULL,
        amount REAL NOT NULL,
        tax_amount REAL NOT NULL,
        status TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id),
        amount REAL NOT NULL,
        method TEXT NOT NULL,
        paid_at TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
    `);

    const accounts = buildAccounts();
    const vouchers = buildVouchers();
    const entries = buildVoucherEntries(vouchers);
    const invoices = buildInvoices(vouchers);
    const payments = buildPayments(invoices);

    const insertAccount = db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?)');
    for (const row of accounts) insertAccount.run(...row);
    const insertVoucher = db.prepare('INSERT INTO vouchers VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of vouchers) insertVoucher.run(...row);
    const insertEntry = db.prepare('INSERT INTO voucher_entries VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of entries) insertEntry.run(...row);
    const insertInvoice = db.prepare('INSERT INTO invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of invoices) insertInvoice.run(...row);
    const insertPayment = db.prepare('INSERT INTO payments VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of payments) insertPayment.run(...row);
  } finally {
    db.close();
  }
  return file;
}

/* -------------------------------------------------------------- 库存管理系统 */

const WAREHOUSES = [
  ['WH-SH01', '上海临港仓', '上海'],
  ['WH-BJ01', '北京亦庄仓', '北京'],
  ['WH-GZ01', '广州南沙仓', '广州'],
  ['WH-CD01', '成都双流仓', '成都'],
  ['WH-WH01', '武汉阳逻仓', '武汉'],
  ['WH-XA01', '西安国际港仓', '西安'],
];

const PRODUCTS = [
  ['SKU-1001', '伺服电机 A2-300', '电机', '台', 1280.0],
  ['SKU-1002', '步进电机 57BYG', '电机', '台', 236.5],
  ['SKU-2001', '不锈钢法兰 DN80', '阀门', '件', 88.0],
  ['SKU-2002', '电动蝶阀 DN100', '阀门', '件', 640.0],
  ['SKU-3001', '深沟球轴承 6208', '轴承', '套', 42.8],
  ['SKU-3002', '圆锥滚子轴承 30207', '轴承', '套', 96.4],
  ['SKU-4001', '屏蔽电缆 RVVP 4×1.5', '线缆', '米', 6.9],
  ['SKU-4002', '耐高温线缆 AF250', '线缆', '米', 12.3],
  ['SKU-5001', '内六角螺栓 M10×40', '紧固件', '千克', 18.6],
  ['SKU-5002', '不锈钢螺母 M10', '紧固件', '千克', 22.4],
  ['SKU-6001', '接近开关 PNP', '传感器', '件', 76.0],
  ['SKU-6002', '光电传感器 E3Z', '传感器', '件', 128.0],
  ['SKU-1003', '减速机 RV-40E', '电机', '台', 2150.0],
  ['SKU-2003', '气动球阀 DN50', '阀门', '件', 420.0],
  ['SKU-3003', '直线导轨 HGR20', '轴承', '套', 268.0],
  ['SKU-4003', '拖链电缆 4×2.5', '线缆', '米', 15.8],
  ['SKU-5003', '平垫圈 M10', '紧固件', '千克', 12.0],
  ['SKU-6003', '压力变送器 0-1.6MPa', '传感器', '件', 560.0],
  ['SKU-1004', '变频器 3.7kW', '电机', '台', 1480.0],
  ['SKU-2004', '止回阀 DN65', '阀门', '件', 186.0],
  ['SKU-3004', '滚珠丝杆 SFU1605', '轴承', '套', 320.0],
  ['SKU-4004', '控制电缆 KVVP 7×1.5', '线缆', '米', 9.4],
  ['SKU-5004', '膨胀螺栓 M12', '紧固件', '千克', 26.8],
  ['SKU-6004', '温度传感器 PT100', '传感器', '件', 92.5],
];

const SUPPLIERS = [
  '苏州精工机电有限公司',
  '宁波阀门制造有限公司',
  '洛阳轴承集团经销处',
  '无锡远东电缆有限公司',
  '深圳传感科技有限公司',
];

/** @returns {Array} warehouses 行 */
function buildWarehouses() {
  return WAREHOUSES.map(([code, name, city], index) => [
    index + 1,
    code,
    name,
    city,
    pick(index, OWNERS),
  ]);
}

/** @returns {Array} products 行 */
function buildProducts() {
  return PRODUCTS.map(([sku, name, category, unit, unitCost], index) => [
    index + 1,
    sku,
    name,
    category,
    unit,
    unitCost,
    pick(index, OWNERS),
  ]);
}

/**
 * 库存：每个商品铺 4 个仓，共 96 行。
 * 铺全量（24 × 6）会让「按仓统计」永远等于总量，看不出分布。
 *
 * @param {Array} products
 * @returns {Array}
 */
function buildStockLevels(products) {
  const rows = [];
  let id = 1;
  for (const product of products) {
    for (let k = 0; k < 4; k += 1) {
      const warehouseId = ((product[0] + k) % 6) + 1;
      const onHand = 40 + (product[0] * 37 + warehouseId * 13) % 900;
      rows.push([
        id++,
        product[0],
        warehouseId,
        onHand,
        Math.round(onHand * 0.12),
        '2026-10-18',
        product[6],
      ]);
    }
  }
  return rows;
}

/** @returns {{inboundOrders: Array, inboundItems: Array}} */
function buildInbound(products) {
  const orders = [];
  const items = [];
  let itemId = 1;
  for (let i = 0; i < 15; i += 1) {
    const received = isoDay(INVENTORY_START + i * 5 * DAY);
    const owner = pick(i, OWNERS);
    orders.push([
      i + 1,
      `IN-${String(i + 1).padStart(5, '0')}`,
      (i % 6) + 1,
      pick(i, SUPPLIERS),
      received,
      i % 7 === 3 ? 'inspecting' : 'received',
      owner,
    ]);
    for (let k = 0; k < 3; k += 1) {
      const product = products[(i * 3 + k) % products.length];
      items.push([itemId++, i + 1, product[0], 20 + ((i + k) * 17) % 380, product[5], owner]);
    }
  }
  return { inboundOrders: orders, inboundItems: items };
}

/** @returns {{outboundOrders: Array, outboundItems: Array}} */
function buildOutbound(products) {
  const orders = [];
  const items = [];
  let itemId = 1;
  for (let i = 0; i < 18; i += 1) {
    const shipped = isoDay(INVENTORY_START + (i * 4 + 2) * DAY);
    const owner = pick(i + 1, OWNERS);
    orders.push([
      i + 1,
      `OUT-${String(i + 1).padStart(5, '0')}`,
      (i % 6) + 1,
      pick(i, FINANCE_CUSTOMERS),
      shipped,
      i % 8 === 5 ? 'packed' : 'shipped',
      owner,
    ]);
    for (let k = 0; k < 3; k += 1) {
      const product = products[(i * 5 + k) % products.length];
      items.push([
        itemId++,
        i + 1,
        product[0],
        5 + ((i + k) * 11) % 90,
        money(product[5] * 1.35),
        owner,
      ]);
    }
  }
  return { outboundOrders: orders, outboundItems: items };
}

function seedInventoryDatabase(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, INVENTORY_DATABASE);
  if (fs.existsSync(file)) fs.rmSync(file);

  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE warehouses (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        city TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        unit TEXT NOT NULL,
        unit_cost REAL NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE stock_levels (
        id INTEGER PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id),
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
        on_hand INTEGER NOT NULL,
        reserved INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE inbound_orders (
        id INTEGER PRIMARY KEY,
        order_no TEXT NOT NULL,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
        supplier TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE inbound_items (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES inbound_orders(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL,
        unit_cost REAL NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE outbound_orders (
        id INTEGER PRIMARY KEY,
        order_no TEXT NOT NULL,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
        customer TEXT NOT NULL,
        shipped_at TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE outbound_items (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES outbound_orders(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        owner_code TEXT NOT NULL
      );
    `);

    const warehouses = buildWarehouses();
    const products = buildProducts();
    const stock = buildStockLevels(products);
    const { inboundOrders, inboundItems } = buildInbound(products);
    const { outboundOrders, outboundItems } = buildOutbound(products);

    const insertWarehouse = db.prepare('INSERT INTO warehouses VALUES (?, ?, ?, ?, ?)');
    for (const row of warehouses) insertWarehouse.run(...row);
    const insertProduct = db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of products) insertProduct.run(...row);
    const insertStock = db.prepare('INSERT INTO stock_levels VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of stock) insertStock.run(...row);
    const insertInboundOrder = db.prepare('INSERT INTO inbound_orders VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of inboundOrders) insertInboundOrder.run(...row);
    const insertInboundItem = db.prepare('INSERT INTO inbound_items VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of inboundItems) insertInboundItem.run(...row);
    const insertOutboundOrder = db.prepare(
      'INSERT INTO outbound_orders VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const row of outboundOrders) insertOutboundOrder.run(...row);
    const insertOutboundItem = db.prepare('INSERT INTO outbound_items VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of outboundItems) insertOutboundItem.run(...row);
  } finally {
    db.close();
  }
  return file;
}

/* ------------------------------------------------------------------- 项目装配 */

/** 财务库的表与其可授权列；列白名单必须与建表语句逐字一致 */
const FINANCE_TABLES = [
  { name: 'accounts', columns: ['id', 'code', 'name', 'category', 'owner_code'] },
  {
    name: 'vouchers',
    columns: ['id', 'voucher_no', 'booked_at', 'period', 'status', 'owner_code'],
  },
  {
    name: 'voucher_entries',
    columns: ['id', 'voucher_id', 'account_id', 'direction', 'amount', 'memo', 'owner_code'],
  },
  {
    name: 'invoices',
    columns: [
      'id',
      'invoice_no',
      'voucher_id',
      'customer_name',
      'amount',
      'tax_amount',
      'status',
      'issued_at',
      'owner_code',
    ],
  },
  { name: 'payments', columns: ['id', 'invoice_id', 'amount', 'method', 'paid_at', 'owner_code'] },
];

const INVENTORY_TABLES = [
  { name: 'warehouses', columns: ['id', 'code', 'name', 'city', 'owner_code'] },
  {
    name: 'products',
    columns: ['id', 'sku', 'name', 'category', 'unit', 'unit_cost', 'owner_code'],
  },
  {
    name: 'stock_levels',
    columns: [
      'id',
      'product_id',
      'warehouse_id',
      'on_hand',
      'reserved',
      'updated_at',
      'owner_code',
    ],
  },
  {
    name: 'inbound_orders',
    columns: ['id', 'order_no', 'warehouse_id', 'supplier', 'received_at', 'status', 'owner_code'],
  },
  {
    name: 'inbound_items',
    columns: ['id', 'order_id', 'product_id', 'quantity', 'unit_cost', 'owner_code'],
  },
  {
    name: 'outbound_orders',
    columns: ['id', 'order_no', 'warehouse_id', 'customer', 'shipped_at', 'status', 'owner_code'],
  },
  {
    name: 'outbound_items',
    columns: ['id', 'order_id', 'product_id', 'quantity', 'unit_price', 'owner_code'],
  },
];

/**
 * 一个数据源的 grants：本库角色给列白名单 + 行过滤，
 * 另一个演示角色给一份永远查不到行的 grant（原因见 DENY_FILTER 的注释）。
 *
 * @param {string} database
 * @param {Array<Object>} tables
 * @returns {Array<Object>}
 */
function demoGrants(database, tables) {
  return [
    {
      role: ROLE_BY_DATABASE[database],
      tables: tables.map((table) => ({
        name: table.name,
        columns: [...table.columns],
        filter: DEMO_FILTER,
      })),
    },
    {
      role: ROLE_BY_DATABASE[database === 'finance' ? 'inventory' : 'finance'],
      tables: tables.map((table) => ({
        name: table.name,
        columns: ['id', 'owner_code'],
        filter: DENY_FILTER,
      })),
    },
  ];
}

/** @returns {Array<Object>} dev.yml 的 sources 段所需的两个数据源 */
function demoSources() {
  return [
    {
      name: 'finance',
      type: 'sqlite',
      path: FINANCE_DATABASE,
      default: true,
      access: {
        read: 'authenticated',
        // 演示是只读的：写 / 删在 source 级就被挡住，任何人都写不动
        write: 'blocked',
        delete: 'blocked',
        grants: demoGrants('finance', FINANCE_TABLES),
      },
    },
    {
      name: 'inventory',
      type: 'sqlite',
      path: INVENTORY_DATABASE,
      access: {
        read: 'authenticated',
        write: 'blocked',
        delete: 'blocked',
        grants: demoGrants('inventory', INVENTORY_TABLES),
      },
    },
  ];
}

/**
 * 创建（或重建）演示项目：写 dev.yml、种两个库、各配一个只读角色。
 *
 * @param {Object} options
 * @param {string} options.dir 项目目录
 * @param {string} [options.appName]
 * @param {number} options.port 监听端口
 * @returns {Object} { devYaml, databases, roles, tables, tablesByDatabase }
 */
function createDemoProject({ dir, appName = DEMO_APP_NAME, port }) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('port 必须是正整数');
  }
  seedFinanceDatabase(dir);
  seedInventoryDatabase(dir);

  const sources = demoSources();
  const devYaml = createProject({ dir, appName, port, sources });

  // roles 段单独写：admin 保证启动不被拒，两个只读角色进入矩阵可编辑
  const roles = ['admin', ROLE_BY_DATABASE.finance, ROLE_BY_DATABASE.inventory];
  const text = replaceRolesBlock(fs.readFileSync(devYaml, 'utf8'), roles);
  fs.writeFileSync(devYaml, text, 'utf8');

  return {
    devYaml,
    databases: sources.map((source) => source.name),
    roles,
    tables: [...FINANCE_TABLES, ...INVENTORY_TABLES].map((table) => table.name),
    tablesByDatabase: {
      finance: FINANCE_TABLES.map((table) => table.name),
      inventory: INVENTORY_TABLES.map((table) => table.name),
    },
  };
}

module.exports = {
  DEMO_FILTER,
  DEMO_APP_NAME,
  DEMO_CONNECTIONS,
  ROLE_BY_DATABASE,
  FINANCE_DATABASE,
  INVENTORY_DATABASE,
  seedFinanceDatabase,
  seedInventoryDatabase,
  createDemoProject,
};
