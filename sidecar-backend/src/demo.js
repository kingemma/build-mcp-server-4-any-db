#!/usr/bin/env node
'use strict';

/**
 * 一键演示项目：三个示例库（财务系统 / 库存管理系统 / 装备维修保障系统）
 * + 各库一个只读角色（带行过滤）。
 *
 * 演示的价值在于「不碰自己的库就能看到权限生效」：三个库都带 owner_code，
 * 角色只能看到自己名下的行，写删一律 blocked —— 打开权限矩阵就能看到这套规则。
 *
 * 每个库一个角色是为了演示「角色 × 库」：finance_analyst 在 inventory 库里没有任何
 * grant，换库就是换身份，而不是「一个只读角色走天下」。三个库的业务毫无关系
 * （财务 / 库存 / 装备维修），也顺带说明平台不预设行业。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createProject, replaceRolesBlock } = require('./project');

const DEMO_APP_NAME = 'Demo Finance, Inventory & Maintenance';

const FINANCE_DATABASE = 'finance.db';
const INVENTORY_DATABASE = 'inventory.db';
const MAINTENANCE_DATABASE = 'maintenance.db';

/** 落盘「已保存连接」用：每个库一条，只记一条会让删连接误伤其它库 */
const DEMO_CONNECTIONS = [
  { name: 'finance', connection: { type: 'sqlite', path: FINANCE_DATABASE } },
  { name: 'inventory', connection: { type: 'sqlite', path: INVENTORY_DATABASE } },
  { name: 'maintenance', connection: { type: 'sqlite', path: MAINTENANCE_DATABASE } },
];

/** 每个库一个只读角色：角色 × 库 的演示 */
const ROLE_BY_DATABASE = {
  finance: 'finance_analyst',
  inventory: 'inventory_viewer',
  maintenance: 'maintenance_engineer',
};

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

/* ------------------------------------------------------- 装备维修保障系统 */

/**
 * 设计出发点（第一性原理）——先有不可再简化的事实，表结构是它们的直接推论：
 *
 * 1. 失效发生在「部件」上，不发生在「装备」上，所以 faults 同时挂装备与部件；
 * 2. 维修只有两个触发源，且互斥：计划（预防性）或故障（纠正性）。这条不变量
 *    落成 maintenance_reports 上的 CHECK 约束，schema 自己拒绝「没有来源」和
 *    「两个来源」的记录——业务约束写在库里，比写在文档里可靠；
 * 3. 一次维修的成本只可能来自两类资源：换掉的部件（report_parts）与耗掉的耗材
 *    （consumption_items），所以单次维修成本、单台装备年成本都可由明细相加得出；
 * 4. 「现象」与「根因」是两层东西：同一种现象可以有多个根因，因此故障树是自引用的树，
 *    而故障记录必须落到「底事件」上，否则「为什么坏」这个问题就答不出来；
 * 5. 计划的周期形态与类型必须自洽（日历 / 运行小时 / 状态监测），也写成 CHECK。
 */

/** 装备：[id, asset_no, name, model, category, location, commissioned_at, status, run_hours, owner] */
const EQUIPMENT_SEED = [
  [1, 'EQ-001', '液压挖掘机', 'SY215C', '工程机械', '上海临港保障基地', '2022-03-15', 'in_service', 4210, 'hq'],
  [2, 'EQ-002', '柴油发电机组', '200GF', '能源保障', '广州南沙场站', '2021-07-01', 'in_service', 6880, 'gz'],
  [3, 'EQ-003', '越野叉车', 'CPCD50', '装卸机械', '北京亦庄库区', '2020-11-20', 'pending_repair', 5120, 'sh'],
  [4, 'EQ-004', '阵地雷达', 'TDR-120', '电子装备', '西安国际港阵地', '2023-01-10', 'in_service', 2140, 'hq'],
  [5, 'EQ-005', '螺杆空压机', 'GA55', '能源保障', '成都双流场站', '2019-05-06', 'under_repair', 9040, 'sh'],
  [6, 'EQ-006', '抢修车', 'QXC-2', '保障车辆', '武汉阳逻基地', '2022-09-18', 'in_service', 3760, 'gz'],
  [7, 'EQ-007', '液压试验台', 'HYT-30', '检测设备', '上海临港保障基地', '2021-12-02', 'in_service', 1580, 'hq'],
  [8, 'EQ-008', '备用发电机组', '120GF', '能源保障', '广州南沙场站', '2018-04-11', 'retired', 15200, 'gz'],
];

/**
 * 每台装备的三个关键可更换单元：[名称, 件号, 装配位置, 设计寿命小时, 采购单价]。
 * 只列「坏了要停机」的单元，不是完整 BOM——演示要的是能被故障指到的那几层。
 */
const PART_SPECS = [
  [
    ['液压主泵', 'PN-HY-101', '泵舱', 8000, 39800],
    ['动臂油缸', 'PN-HY-102', '动臂', 6000, 12600],
    ['回转减速机', 'PN-HY-103', '回转平台', 10000, 21500],
  ],
  [
    ['发动机总成', 'PN-EN-201', '机舱', 12000, 86000],
    ['励磁调节器', 'PN-EL-202', '控制柜', 6000, 9800],
    ['散热器', 'PN-EN-203', '机组侧', 9000, 4200],
  ],
  [
    ['变速箱', 'PN-TR-301', '车架', 10000, 32000],
    ['制动器总成', 'PN-TR-302', '驱动桥', 5000, 6800],
    ['门架油缸', 'PN-HY-303', '门架', 6000, 9400],
  ],
  [
    ['收发组件', 'PN-RD-401', '阵面', 8000, 128000],
    ['伺服转台', 'PN-RD-402', '底座', 9000, 46000],
    ['电源模块', 'PN-EL-403', '机柜', 7000, 15600],
  ],
  [
    ['主机总成', 'PN-AC-501', '机头', 15000, 98000],
    ['冷却器', 'PN-AC-502', '机侧', 8000, 7400],
    ['进气过滤器', 'PN-AC-503', '进气口', 4000, 1800],
  ],
  [
    ['底盘传动轴', 'PN-VH-601', '底盘', 9000, 8200],
    ['液压绞盘', 'PN-VH-602', '车尾', 6000, 24000],
    ['取力器', 'PN-VH-603', '变速箱侧', 7000, 5600],
  ],
  [
    ['高压柱塞泵', 'PN-TB-701', '泵站', 8000, 52000],
    ['加载阀组', 'PN-TB-702', '台面', 6000, 18000],
    ['传感器组', 'PN-TB-703', '测点', 5000, 3200],
  ],
  [
    ['发动机总成', 'PN-EN-801', '机舱', 12000, 82000],
    ['励磁调节器', 'PN-EL-802', '控制柜', 6000, 9200],
    ['散热器', 'PN-EN-803', '机组侧', 9000, 3800],
  ],
];

/**
 * 故障树：[编码, 名称, 层级, 所属系统, 父节点编码, 说明]。
 * 先顶事件、再中间事件、最后底事件，保证父节点先于子节点建出来。
 * 底事件才是「可修的最小单元」，所以故障记录只允许指到底事件。
 */
const FAULT_TREE_SEED = [
  ['FT-TOP-01', '液压系统压力不足', 'top', '液压', null, '整机动作无力、压力上不去的统称'],
  ['FT-TOP-02', '发电与供电异常', 'top', '电气', null, '输出电压或频率偏离额定值'],
  ['FT-TOP-03', '行走机构异响', 'top', '传动', null, '行走或换挡时出现金属撞击声'],
  ['FT-TOP-04', '温升与进气异常', 'top', '冷却进气', null, '温度超限或进气量不足'],
  ['FT-INT-011', '液压泵输出不足', 'intermediate', '液压', 'FT-TOP-01', '泵本身排量或效率下降'],
  ['FT-INT-012', '系统内泄', 'intermediate', '液压', 'FT-TOP-01', '压力油在内部或接头处泄漏'],
  ['FT-INT-021', '励磁与供电异常', 'intermediate', '电气', 'FT-TOP-02', '励磁或调压环节失效'],
  ['FT-INT-031', '轴承与齿轮磨损', 'intermediate', '传动', 'FT-TOP-03', '传动件磨损失去精度'],
  ['FT-INT-041', '冷却与进气受阻', 'intermediate', '冷却进气', 'FT-TOP-04', '散热或进气通路被堵'],
  ['FT-BAS-0111', '柱塞磨损', 'basic', '液压', 'FT-INT-011', '泵内柱塞与缸体间隙超差'],
  ['FT-BAS-0112', '吸油过滤器堵塞', 'basic', '液压', 'FT-INT-011', '吸油阻力大导致吸空'],
  ['FT-BAS-0121', '密封圈老化', 'basic', '液压', 'FT-INT-012', '油缸或阀体密封失效'],
  ['FT-BAS-0122', '管接头松动', 'basic', '液压', 'FT-INT-012', '接头预紧力不足'],
  ['FT-BAS-0211', '电气部件受潮', 'basic', '电气', 'FT-INT-021', '绝缘下降，潮湿环境高发'],
  ['FT-BAS-0212', '调压板失效', 'basic', '电气', 'FT-INT-021', '调压回路无法稳定输出'],
  ['FT-BAS-0311', '轴承滚道剥落', 'basic', '传动', 'FT-INT-031', '疲劳剥落引起异响与卡滞'],
  ['FT-BAS-0312', '齿轮点蚀', 'basic', '传动', 'FT-INT-031', '齿面点蚀导致换挡冲击'],
  ['FT-BAS-0411', '冷却器堵塞', 'basic', '冷却进气', 'FT-INT-041', '散热通道结垢或堵塞'],
  ['FT-BAS-0412', '润滑脂失效', 'basic', '冷却进气', 'FT-INT-041', '油脂老化失去润滑能力'],
  ['FT-BAS-0413', '进气过滤器堵塞', 'basic', '冷却进气', 'FT-INT-041', '进气阻力大，进气量不足'],
];

/**
 * 故障：[装备 id, 部件槽位(0-2), 故障号, 发生日, 现象, 严重度, 停机小时, 根因编码]。
 * 根因一律指向底事件；严重度取 minor / major / critical。
 */
const FAULT_SEED = [
  [1, 0, 'F-2026-0001', '2026-02-11', '动臂提升压力掉到 8MPa，动作明显迟缓', 'major', 18, 'FT-BAS-0111'],
  [1, 1, 'F-2026-0002', '2026-05-08', '活塞杆处渗油，日补油约 2L', 'minor', 6, 'FT-BAS-0121'],
  [2, 0, 'F-2026-0003', '2026-03-02', '机油压力低报警，曲轴箱有异响', 'critical', 52, 'FT-BAS-0412'],
  [2, 1, 'F-2026-0004', '2026-06-19', '加载 120kW 时输出电压抖动、频率不稳', 'major', 26, 'FT-BAS-0212'],
  [3, 0, 'F-2026-0005', '2026-04-07', '二挡换挡冲击，放油见金属屑', 'major', 30, 'FT-BAS-0312'],
  [3, 1, 'F-2026-0006', '2026-07-22', '制动时门架异响，制动距离变长', 'major', 12, 'FT-BAS-0311'],
  [4, 1, 'F-2026-0007', '2026-05-30', '方位转动卡滞，随动误差超差', 'major', 22, 'FT-BAS-0311'],
  [4, 0, 'F-2026-0008', '2026-08-14', '开机自检报通道失锁，雨后故障率上升', 'critical', 48, 'FT-BAS-0211'],
  [5, 0, 'F-2026-0009', '2026-04-20', '排气温度高，加载 5 分钟后自动停机', 'critical', 40, 'FT-BAS-0411'],
  [5, 1, 'F-2026-0010', '2026-08-03', '油温 105℃，冷却风扇常转', 'major', 14, 'FT-BAS-0411'],
  [6, 1, 'F-2026-0011', '2026-06-02', '绞盘保压时缓慢下滑，接头处见油迹', 'minor', 5, 'FT-BAS-0122'],
  [7, 1, 'F-2026-0012', '2026-07-09', '加载到 25MPa 时压力上不去', 'major', 16, 'FT-BAS-0112'],
  [7, 2, 'F-2026-0013', '2026-09-11', '压力显示跳变，标定后复现', 'minor', 4, 'FT-BAS-0211'],
  [3, 2, 'F-2026-0014', '2026-09-26', '门架下沉，静置 2 小时下降 30mm', 'major', 20, 'FT-BAS-0121'],
];

/** 最后一条故障还没修：装备 3 停在「待修」，演示「故障 → 计划外维修」未闭环的状态 */
const UNREPAIRED_FAULT_NO = 'F-2026-0014';

/**
 * 维修计划：[装备 id, 计划号, 名称, 类型, 间隔天, 间隔小时, 上次完成, 下次到期日,
 * 下次到期小时, 状态]。退役装备（EQ-008）故意没有计划——规则里会断言这一点。
 */
const PLAN_SEED = [
  [1, 'MP-2026-001', '液压系统季度保养', 'calendar', 90, null, '2026-07-15', '2026-10-13', null, 'active'],
  [1, 'MP-2026-002', '主泵 500 小时检查', 'hour_based', null, 500, '2026-06-20', null, 4500, 'active'],
  [1, 'MP-2026-003', '回转减速机状态监测', 'condition', null, null, '2026-08-05', null, null, 'active'],
  [2, 'MP-2026-004', '发电机组半年保养', 'calendar', 180, null, '2026-05-02', '2026-10-29', null, 'active'],
  [2, 'MP-2026-005', '机油与三滤更换', 'hour_based', null, 250, '2026-08-12', null, 7000, 'active'],
  [3, 'MP-2026-006', '叉车制动系统检查', 'calendar', 90, null, '2026-06-28', '2026-09-26', null, 'active'],
  [4, 'MP-2026-007', '雷达年度标校', 'calendar', 365, null, '2025-11-20', '2026-11-20', null, 'active'],
  [4, 'MP-2026-008', '收发组件温漂监测', 'condition', null, null, '2026-07-18', null, null, 'active'],
  [5, 'MP-2026-009', '空压机冷却器清洗', 'calendar', 60, null, '2026-06-15', '2026-08-14', null, 'suspended'],
  [6, 'MP-2026-010', '抢修车底盘保养', 'calendar', 180, null, '2026-04-12', '2026-10-09', null, 'active'],
  [6, 'MP-2026-011', '液压绞盘换油', 'hour_based', null, 1000, '2026-05-30', null, 4000, 'active'],
  [7, 'MP-2026-012', '试验台压力标定', 'calendar', 90, null, '2026-08-01', '2026-10-30', null, 'active'],
];

/** 计划来源的维修报告取这几条计划（都已完成），故障来源的由 FAULT_SEED 推出来 */
const PLAN_REPORT_PLAN_NOS = ['MP-2026-001', 'MP-2026-004', 'MP-2026-006', 'MP-2026-010', 'MP-2026-012'];

/** 维修人员：报告要有署名，同一个人反复出现才像一份台账 */
const TECHNICIANS = ['张卫东', '李国强', '陈志远', '王海涛'];

/** 换件的故障号：只有这几条故障真的换了部件，其余是清洁 / 调整 / 紧固 */
const REPLACEMENT_FAULT_NOS = new Set([
  'F-2026-0001',
  'F-2026-0003',
  'F-2026-0004',
  'F-2026-0005',
  'F-2026-0006',
  'F-2026-0007',
  'F-2026-0008',
  'F-2026-0009',
]);

/** 耗材台账：[编码, 名称, 规格, 单位, 库存, 单价] */
const CONSUMABLES = [
  ['CS-101', '抗磨液压油', 'L-HM 46#', 'L', 420, 68.0],
  ['CS-102', '齿轮油', 'GL-5 85W-90', 'L', 180, 42.0],
  ['CS-103', '柴油机油', 'CI-4 15W-40', 'L', 240, 55.0],
  ['CS-104', '机油滤芯', '适配 200GF', '个', 36, 180.0],
  ['CS-105', '空气滤芯', 'K2841', '个', 20, 240.0],
  ['CS-106', '耐油密封胶', '310ml/支', '支', 90, 35.0],
  ['CS-107', '极压锂基脂', '3#', 'kg', 120, 48.0],
  ['CS-108', '环保清洗剂', '20L/桶', '桶', 24, 128.0],
];

/** 部件 id 换算：装备 i 的第 slot 个部件 */
function partIdOf(equipmentId, slot) {
  return (equipmentId - 1) * 3 + slot + 1;
}

/** @returns {Array} equipment 行 */
function buildEquipment() {
  return EQUIPMENT_SEED.map((row) => [...row]);
}

/** @returns {Array} parts 行：运行小时逼近设计寿命时状态自动升到 due_soon / overdue */
function buildMaintenanceParts() {
  const rows = [];
  let id = 1;
  EQUIPMENT_SEED.forEach((equipment, index) => {
    const [equipmentId, , , , , , , , runHours, owner] = equipment;
    PART_SPECS[index].forEach(([name, partNo, position, designHours, unitPrice], slot) => {
      const partRunHours = Math.max(120, runHours - slot * 260);
      const ratio = partRunHours / designHours;
      const status = ratio >= 1 ? 'overdue' : ratio >= 0.85 ? 'due_soon' : 'normal';
      rows.push([
        id++,
        equipmentId,
        partNo,
        name,
        position,
        designHours,
        partRunHours,
        status,
        unitPrice,
        owner,
      ]);
    });
  });
  return rows;
}

/** @returns {Array} fault_tree_nodes 行 */
function buildFaultTreeNodes() {
  const rows = [];
  const idByCode = new Map();
  FAULT_TREE_SEED.forEach(([code, name, nodeType, system, parentCode, description], index) => {
    const id = index + 1;
    idByCode.set(code, id);
    rows.push([
      id,
      code,
      name,
      nodeType,
      system,
      parentCode == null ? null : idByCode.get(parentCode),
      description,
      'hq',
    ]);
  });
  return rows;
}

/** @returns {Array} faults 行 */
function buildFaults() {
  const idByCode = new Map(FAULT_TREE_SEED.map(([code], index) => [code, index + 1]));
  return FAULT_SEED.map(([equipmentId, slot, faultNo, occurredAt, symptom, severity, downtime, root], index) => {
    const equipment = EQUIPMENT_SEED[equipmentId - 1];
    return [
      index + 1,
      faultNo,
      equipmentId,
      partIdOf(equipmentId, slot),
      occurredAt,
      symptom,
      severity,
      downtime,
      idByCode.get(root),
      equipment[9],
    ];
  });
}

/** @returns {Array} maintenance_plans 行 */
function buildMaintenancePlans() {
  return PLAN_SEED.map((row, index) => {
    const [equipmentId, planNo, name, planType, days, hours, lastDone, dueAt, dueHours, status] = row;
    return [
      index + 1,
      planNo,
      equipmentId,
      name,
      planType,
      days,
      hours,
      lastDone,
      dueAt,
      dueHours,
      status,
      EQUIPMENT_SEED[equipmentId - 1][9],
    ];
  });
}

/**
 * 维修报告：来源互斥由 CHECK 兜底，这里保证两类来源都有数据。
 *
 * 计划来源取「上次完成日」作为开工日（计划性停机 4~10h）；
 * 故障来源直接复用故障的停机小时，两者对得上才算一份真实台账。
 *
 * @param {Array} faults
 * @param {Array} plans
 * @returns {Array}
 */
function buildMaintenanceReports(faults, plans) {
  const rows = [];
  let id = 1;
  let sequence = 1;
  const reportNo = () => `MR-2026-${String(sequence++).padStart(4, '0')}`;

  for (const planNo of PLAN_REPORT_PLAN_NOS) {
    const plan = plans.find((row) => row[1] === planNo);
    if (!plan) continue;
    const [, , equipmentId, name, , , , lastDone] = plan;
    const downtime = 4 + (sequence % 4) * 2;
    const started = lastDone ?? '2026-07-01';
    rows.push([
      id++,
      reportNo(),
      equipmentId,
      plan[0],
      null,
      started,
      isoDay(Date.parse(`${started}T00:00:00Z`) + downtime * 60 * 60 * 1000),
      downtime,
      pick(id, TECHNICIANS),
      `${name}按计划执行，检查项全部合格，已复位并试运行`,
      'completed',
      EQUIPMENT_SEED[equipmentId - 1][9],
    ]);
  }

  for (const fault of faults) {
    const [faultId, faultNo, equipmentId, partId, occurredAt, symptom, , downtime] = fault;
    if (faultNo === UNREPAIRED_FAULT_NO) continue;
    const partName = PART_SPECS[equipmentId - 1].find((_, slot) => partIdOf(equipmentId, slot) === partId)[0];
    const replaced = REPLACEMENT_FAULT_NOS.has(faultNo);
    rows.push([
      id++,
      reportNo(),
      equipmentId,
      null,
      faultId,
      occurredAt,
      isoDay(Date.parse(`${occurredAt}T00:00:00Z`) + downtime * 60 * 60 * 1000),
      downtime,
      pick(id, TECHNICIANS),
      replaced
        ? `${symptom}；定位到 ${partName}，已换件并复测，参数回到正常范围`
        : `${symptom}；定位到 ${partName}，清洁紧固后复测正常`,
      faultNo === 'F-2026-0009' ? 'deferred' : 'completed',
      EQUIPMENT_SEED[equipmentId - 1][9],
    ]);
  }
  return rows;
}

/**
 * @param {Array} reports 维修报告
 * @param {Array} faults 故障
 * @param {Array} parts 部件（按 id 反查采购价）
 * @returns {Array} report_parts 行：换件明细，单价取部件采购价
 */
function buildReportParts(reports, faults, parts) {
  const rows = [];
  let id = 1;
  for (const report of reports) {
    const [, , equipmentId, , faultId] = report;
    if (faultId == null) continue;
    const fault = faults.find((row) => row[0] === faultId);
    if (!fault || !REPLACEMENT_FAULT_NOS.has(fault[1])) continue;
    const part = parts.find((row) => row[0] === fault[3]);
    if (!part) continue;
    rows.push([id++, report[0], part[0], 1, part[8], EQUIPMENT_SEED[equipmentId - 1][9]]);
  }
  return rows;
}

/** @returns {Array} consumables 行 */
function buildConsumables() {
  return CONSUMABLES.map(([code, name, spec, unit, stock, unitPrice], index) => [
    index + 1,
    code,
    name,
    spec,
    unit,
    stock,
    unitPrice,
    pick(index, OWNERS),
  ]);
}

/**
 * 耗材消耗：[报告下标, 耗材下标, 数量]。每条报告都有油品 / 脂类消耗，
 * 换件的报告再加密封胶与清洗剂——成本拆得开，指标才算得出来。
 *
 * @param {Array} reports
 * @returns {Array}
 */
function buildConsumptionItems(reports) {
  const rows = [];
  let id = 1;
  reports.forEach((report, index) => {
    const equipmentId = report[2];
    const owner = EQUIPMENT_SEED[equipmentId - 1][9];
    const first = CONSUMABLES[index % CONSUMABLES.length];
    rows.push([id++, report[0], (index % CONSUMABLES.length) + 1, 2 + (index % 4), first[5], owner]);
    if (report[4] != null) {
      rows.push([id++, report[0], 6, 1, CONSUMABLES[5][5], owner]);
      rows.push([id++, report[0], 8, 1, CONSUMABLES[7][5], owner]);
    }
  });
  return rows;
}

function seedMaintenanceDatabase(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, MAINTENANCE_DATABASE);
  if (fs.existsSync(file)) fs.rmSync(file);

  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE equipment (
        id INTEGER PRIMARY KEY,
        asset_no TEXT NOT NULL,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        category TEXT NOT NULL,
        location TEXT NOT NULL,
        commissioned_at TEXT NOT NULL,
        status TEXT NOT NULL,
        run_hours INTEGER NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE parts (
        id INTEGER PRIMARY KEY,
        equipment_id INTEGER NOT NULL REFERENCES equipment(id),
        part_no TEXT NOT NULL,
        name TEXT NOT NULL,
        position TEXT NOT NULL,
        design_hours INTEGER NOT NULL,
        run_hours INTEGER NOT NULL,
        status TEXT NOT NULL,
        unit_price REAL NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE fault_tree_nodes (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        node_type TEXT NOT NULL,
        system TEXT NOT NULL,
        parent_id INTEGER REFERENCES fault_tree_nodes(id),
        description TEXT NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE faults (
        id INTEGER PRIMARY KEY,
        fault_no TEXT NOT NULL,
        equipment_id INTEGER NOT NULL REFERENCES equipment(id),
        part_id INTEGER NOT NULL REFERENCES parts(id),
        occurred_at TEXT NOT NULL,
        symptom TEXT NOT NULL,
        severity TEXT NOT NULL,
        downtime_hours REAL NOT NULL,
        root_cause_id INTEGER NOT NULL REFERENCES fault_tree_nodes(id),
        owner_code TEXT NOT NULL
      );
      CREATE TABLE maintenance_plans (
        id INTEGER PRIMARY KEY,
        plan_no TEXT NOT NULL,
        equipment_id INTEGER NOT NULL REFERENCES equipment(id),
        name TEXT NOT NULL,
        plan_type TEXT NOT NULL,
        interval_days INTEGER,
        interval_hours INTEGER,
        last_done_at TEXT,
        next_due_at TEXT,
        next_due_hours INTEGER,
        status TEXT NOT NULL,
        owner_code TEXT NOT NULL,
        CHECK (
          (plan_type = 'calendar' AND interval_days IS NOT NULL AND interval_hours IS NULL) OR
          (plan_type = 'hour_based' AND interval_hours IS NOT NULL AND interval_days IS NULL) OR
          (plan_type = 'condition' AND interval_days IS NULL AND interval_hours IS NULL)
        )
      );
      CREATE TABLE maintenance_reports (
        id INTEGER PRIMARY KEY,
        report_no TEXT NOT NULL,
        equipment_id INTEGER NOT NULL REFERENCES equipment(id),
        plan_id INTEGER REFERENCES maintenance_plans(id),
        fault_id INTEGER REFERENCES faults(id),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        downtime_hours REAL NOT NULL,
        technician TEXT NOT NULL,
        conclusion TEXT NOT NULL,
        result TEXT NOT NULL,
        owner_code TEXT NOT NULL,
        CHECK ((plan_id IS NOT NULL) <> (fault_id IS NOT NULL))
      );
      CREATE TABLE report_parts (
        id INTEGER PRIMARY KEY,
        report_id INTEGER NOT NULL REFERENCES maintenance_reports(id),
        part_id INTEGER NOT NULL REFERENCES parts(id),
        quantity INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE consumables (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        spec TEXT NOT NULL,
        unit TEXT NOT NULL,
        stock_qty REAL NOT NULL,
        unit_price REAL NOT NULL,
        owner_code TEXT NOT NULL
      );
      CREATE TABLE consumption_items (
        id INTEGER PRIMARY KEY,
        report_id INTEGER NOT NULL REFERENCES maintenance_reports(id),
        consumable_id INTEGER NOT NULL REFERENCES consumables(id),
        quantity REAL NOT NULL,
        unit_price REAL NOT NULL,
        owner_code TEXT NOT NULL
      );
    `);

    const equipment = buildEquipment();
    const parts = buildMaintenanceParts();
    const tree = buildFaultTreeNodes();
    const faults = buildFaults();
    const plans = buildMaintenancePlans();
    const reports = buildMaintenanceReports(faults, plans);
    const replaced = buildReportParts(reports, faults, parts);
    const consumables = buildConsumables();
    const consumption = buildConsumptionItems(reports);

    const insert = (sql, rows) => {
      const statement = db.prepare(sql);
      for (const row of rows) statement.run(...row);
    };
    insert('INSERT INTO equipment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', equipment);
    insert('INSERT INTO parts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', parts);
    insert('INSERT INTO fault_tree_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?)', tree);
    insert('INSERT INTO faults VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', faults);
    insert('INSERT INTO maintenance_plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', plans);
    insert(
      'INSERT INTO maintenance_reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      reports
    );
    insert('INSERT INTO report_parts VALUES (?, ?, ?, ?, ?, ?)', replaced);
    insert('INSERT INTO consumables VALUES (?, ?, ?, ?, ?, ?, ?, ?)', consumables);
    insert('INSERT INTO consumption_items VALUES (?, ?, ?, ?, ?, ?)', consumption);
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

/** 装备维修保障库的表与其可授权列；列白名单必须与建表语句逐字一致 */
const MAINTENANCE_TABLES = [
  {
    name: 'equipment',
    columns: [
      'id',
      'asset_no',
      'name',
      'model',
      'category',
      'location',
      'commissioned_at',
      'status',
      'run_hours',
      'owner_code',
    ],
  },
  {
    name: 'parts',
    columns: [
      'id',
      'equipment_id',
      'part_no',
      'name',
      'position',
      'design_hours',
      'run_hours',
      'status',
      'unit_price',
      'owner_code',
    ],
  },
  {
    name: 'fault_tree_nodes',
    columns: ['id', 'code', 'name', 'node_type', 'system', 'parent_id', 'description', 'owner_code'],
  },
  {
    name: 'faults',
    columns: [
      'id',
      'fault_no',
      'equipment_id',
      'part_id',
      'occurred_at',
      'symptom',
      'severity',
      'downtime_hours',
      'root_cause_id',
      'owner_code',
    ],
  },
  {
    name: 'maintenance_plans',
    columns: [
      'id',
      'plan_no',
      'equipment_id',
      'name',
      'plan_type',
      'interval_days',
      'interval_hours',
      'last_done_at',
      'next_due_at',
      'next_due_hours',
      'status',
      'owner_code',
    ],
  },
  {
    name: 'maintenance_reports',
    columns: [
      'id',
      'report_no',
      'equipment_id',
      'plan_id',
      'fault_id',
      'started_at',
      'finished_at',
      'downtime_hours',
      'technician',
      'conclusion',
      'result',
      'owner_code',
    ],
  },
  {
    name: 'report_parts',
    columns: ['id', 'report_id', 'part_id', 'quantity', 'unit_price', 'owner_code'],
  },
  {
    name: 'consumables',
    columns: ['id', 'code', 'name', 'spec', 'unit', 'stock_qty', 'unit_price', 'owner_code'],
  },
  {
    name: 'consumption_items',
    columns: ['id', 'report_id', 'consumable_id', 'quantity', 'unit_price', 'owner_code'],
  },
];

/**
 * 一个数据源的 grants：本库角色给列白名单 + 行过滤，
 * 其余演示角色各给一份永远查不到行的 grant（原因见 DENY_FILTER 的注释）。
 *
 * @param {string} database
 * @param {Array<Object>} tables
 * @returns {Array<Object>}
 */
function demoGrants(database, tables) {
  const ownRole = ROLE_BY_DATABASE[database];
  const otherRoles = Object.values(ROLE_BY_DATABASE).filter((role) => role !== ownRole);
  return [
    {
      role: ownRole,
      tables: tables.map((table) => ({
        name: table.name,
        columns: [...table.columns],
        filter: DEMO_FILTER,
      })),
    },
    ...otherRoles.map((role) => ({
      role,
      tables: tables.map((table) => ({
        name: table.name,
        columns: ['id', 'owner_code'],
        filter: DENY_FILTER,
      })),
    })),
  ];
}

/** @returns {Array<Object>} dev.yml 的 sources 段所需的三个数据源 */
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
    {
      name: 'maintenance',
      type: 'sqlite',
      path: MAINTENANCE_DATABASE,
      access: {
        read: 'authenticated',
        write: 'blocked',
        delete: 'blocked',
        grants: demoGrants('maintenance', MAINTENANCE_TABLES),
      },
    },
  ];
}

/**
 * 创建（或重建）演示项目：写 dev.yml、种三个库、各配一个只读角色。
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
  seedMaintenanceDatabase(dir);

  const sources = demoSources();
  const devYaml = createProject({ dir, appName, port, sources });

  // roles 段单独写：admin 保证启动不被拒，三个只读角色进入矩阵可编辑
  const roles = ['admin', ...Object.values(ROLE_BY_DATABASE)];
  const text = replaceRolesBlock(fs.readFileSync(devYaml, 'utf8'), roles);
  fs.writeFileSync(devYaml, text, 'utf8');

  return {
    devYaml,
    databases: sources.map((source) => source.name),
    roles,
    tables: [...FINANCE_TABLES, ...INVENTORY_TABLES, ...MAINTENANCE_TABLES].map(
      (table) => table.name
    ),
    tablesByDatabase: {
      finance: FINANCE_TABLES.map((table) => table.name),
      inventory: INVENTORY_TABLES.map((table) => table.name),
      maintenance: MAINTENANCE_TABLES.map((table) => table.name),
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
  MAINTENANCE_DATABASE,
  MAINTENANCE_TABLES,
  seedFinanceDatabase,
  seedInventoryDatabase,
  seedMaintenanceDatabase,
  createDemoProject,
};
