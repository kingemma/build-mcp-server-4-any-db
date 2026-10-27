const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  createDemoProject,
  ROLE_BY_DATABASE,
  FINANCE_DATABASE,
  INVENTORY_DATABASE,
  MAINTENANCE_DATABASE,
} = require('../src/demo');
const { readSourceConnections } = require('../src/project');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-demo-'));
}

/** @param {string} dir @param {string} file @returns {string} 库文件路径 */
function dbPath(dir, file) {
  return path.join(dir, file);
}

test('createDemoProject 种出三个库与各自的只读角色', () => {
  const dir = tempDir();
  const report = createDemoProject({ dir, port: 45123 });

  assert.deepStrictEqual(report.databases, ['finance', 'inventory', 'maintenance']);
  assert.deepStrictEqual(report.roles, [
    'admin',
    ROLE_BY_DATABASE.finance,
    ROLE_BY_DATABASE.inventory,
    ROLE_BY_DATABASE.maintenance,
  ]);
  assert.deepStrictEqual(report.tablesByDatabase.finance, [
    'accounts',
    'vouchers',
    'voucher_entries',
    'invoices',
    'payments',
  ]);
  assert.deepStrictEqual(report.tablesByDatabase.inventory, [
    'warehouses',
    'products',
    'stock_levels',
    'inbound_orders',
    'inbound_items',
    'outbound_orders',
    'outbound_items',
  ]);
  // 维修库的表就是那套业务本体：装备 → 部件 → 故障 → 故障树 → 计划 → 报告 → 换件 / 耗材
  assert.deepStrictEqual(report.tablesByDatabase.maintenance, [
    'equipment',
    'parts',
    'fault_tree_nodes',
    'faults',
    'maintenance_plans',
    'maintenance_reports',
    'report_parts',
    'consumables',
    'consumption_items',
  ]);

  // 每个库一个角色：finance_analyst 不该出现在 inventory 的 grants 里，
  // 「一个只读角色走天下」演示不出角色 × 库
  const text = fs.readFileSync(path.join(dir, 'dev.yml'), 'utf8');
  assert.match(text, /- role: "finance_analyst"/);
  assert.match(text, /- role: "inventory_viewer"/);
  assert.match(text, /- role: "maintenance_engineer"/);
  // 行过滤必须真的写进 dev.yml：这是演示「权限立刻生效」的关键
  assert.match(text, /filter: "\{ owner_code: \{ _eq: \$user_code \} \}"/);
  // 演示项目是只读的
  assert.match(text, /write: "blocked"/);
  assert.match(text, /delete: "blocked"/);

  const conns = readSourceConnections(text);
  assert.deepStrictEqual(Object.keys(conns), ['finance', 'inventory', 'maintenance']);
  assert.strictEqual(conns.finance.type, 'sqlite');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('财务与库存库都有真实数据：行数、外键与借贷平衡', () => {
  const dir = tempDir();
  createDemoProject({ dir, port: 45123 });

  const finance = new DatabaseSync(dbPath(dir, FINANCE_DATABASE));
  try {
    const count = (table) => finance.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.ok(count('accounts') >= 20, '会计科目要够多，科目表才像科目表');
    assert.ok(count('vouchers') >= 30);
    assert.ok(count('voucher_entries') >= 90);
    assert.ok(count('invoices') >= 20);
    assert.ok(count('payments') >= 15);

    // 分录必须借贷平衡：不平的凭证会让「按科目汇总」演示出一个对不上的数
    const unbalanced = finance
      .prepare(
        `SELECT voucher_id, ROUND(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END), 2) AS diff
         FROM voucher_entries GROUP BY voucher_id HAVING ABS(diff) > 0.01`
      )
      .all();
    assert.deepStrictEqual(unbalanced, []);

    // 外键真的连得上：schema 浏览器要能画出关系
    const joined = finance
      .prepare(
        `SELECT COUNT(*) AS n FROM voucher_entries e
         JOIN vouchers v ON v.id = e.voucher_id
         JOIN accounts a ON a.id = e.account_id`
      )
      .get();
    assert.strictEqual(joined.n, count('voucher_entries'));

    // 收款只挂在已付发票上
    const badPayments = finance
      .prepare(
        `SELECT COUNT(*) AS n FROM payments p JOIN invoices i ON i.id = p.invoice_id
         WHERE i.status <> 'paid'`
      )
      .get();
    assert.strictEqual(badPayments.n, 0);
  } finally {
    finance.close();
  }

  const inventory = new DatabaseSync(dbPath(dir, INVENTORY_DATABASE));
  try {
    const count = (table) => inventory.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.ok(count('warehouses') >= 5);
    assert.ok(count('products') >= 20);
    assert.ok(count('stock_levels') >= 80);
    assert.ok(count('inbound_items') >= 30);
    assert.ok(count('outbound_items') >= 30);

    const joined = inventory
      .prepare(
        `SELECT COUNT(*) AS n FROM stock_levels s
         JOIN products p ON p.id = s.product_id
         JOIN warehouses w ON w.id = s.warehouse_id`
      )
      .get();
    assert.strictEqual(joined.n, count('stock_levels'));
    // 预留量不能超过在手量：库存演示里出现负数可用量会让人以为平台算错了
    const negative = inventory
      .prepare('SELECT COUNT(*) AS n FROM stock_levels WHERE reserved > on_hand')
      .get();
    assert.strictEqual(negative.n, 0);
  } finally {
    inventory.close();
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('维修库的数据能串成一条链：装备 → 部件 → 故障 → 报告 → 换件 / 耗材', () => {
  const dir = tempDir();
  createDemoProject({ dir, port: 45123 });

  const db = new DatabaseSync(dbPath(dir, MAINTENANCE_DATABASE));
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.ok(count('equipment') >= 6);
    assert.ok(count('parts') >= 18, '每台装备至少几个可更换单元');
    assert.ok(count('fault_tree_nodes') >= 15);
    assert.ok(count('faults') >= 10);
    assert.ok(count('maintenance_plans') >= 8);
    assert.ok(count('maintenance_reports') >= 12);
    assert.ok(count('report_parts') >= 5, '换件明细为空的话维修成本无从算起');
    assert.ok(count('consumption_items') >= 20);

    // 故障必须同时挂到装备与「该装备的」部件上，否则「哪台装备的哪个件坏了」说不清
    const wrongPart = db
      .prepare(
        `SELECT COUNT(*) AS n FROM faults f JOIN parts p ON p.id = f.part_id
         WHERE p.equipment_id <> f.equipment_id`
      )
      .get();
    assert.strictEqual(wrongPart.n, 0);

    // 根因只能落在底事件上：中间事件 / 顶事件是「现象」，修不了
    const notBasic = db
      .prepare(
        `SELECT COUNT(*) AS n FROM faults f JOIN fault_tree_nodes t ON t.id = f.root_cause_id
         WHERE t.node_type <> 'basic'`
      )
      .get();
    assert.strictEqual(notBasic.n, 0);

    // 故障来源的报告，停机时长必须与故障记录一致——两边对不上，MTTR 就是错的
    const drifted = db
      .prepare(
        `SELECT COUNT(*) AS n FROM maintenance_reports r JOIN faults f ON f.id = r.fault_id
         WHERE r.downtime_hours <> f.downtime_hours`
      )
      .get();
    assert.strictEqual(drifted.n, 0);

    // 每类资源都要有价：成本 = Σ(换件数量 × 单价) + Σ(耗材数量 × 单价)
    const cost = db
      .prepare(
        `SELECT (SELECT SUM(quantity * unit_price) FROM report_parts)
              + (SELECT SUM(quantity * unit_price) FROM consumption_items) AS total`
      )
      .get();
    assert.ok(cost.total > 0, '维修成本必须算得出一个正数');

    // 报告、故障、换件、耗材都能追到同一台装备
    const traceable = db
      .prepare(
        `SELECT COUNT(*) AS n FROM report_parts rp
         JOIN maintenance_reports r ON r.id = rp.report_id
         JOIN parts p ON p.id = rp.part_id
         WHERE p.equipment_id <> r.equipment_id`
      )
      .get();
    assert.strictEqual(traceable.n, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('业务约束落在 schema 上：来源互斥、计划周期自洽、退役装备不排计划', () => {
  const dir = tempDir();
  createDemoProject({ dir, port: 45123 });

  const db = new DatabaseSync(dbPath(dir, MAINTENANCE_DATABASE));
  try {
    // 维修报告必须恰好一个来源：既没有来源、又两个来源都要被库自己挡住
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO maintenance_reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(9001, 'MR-X-1', 1, null, null, '2026-10-01', '2026-10-02', 4, '测试', '无来源', 'completed', 'hq'),
      /CHECK constraint failed/
    );
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO maintenance_reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(9002, 'MR-X-2', 1, 1, 1, '2026-10-01', '2026-10-02', 4, '测试', '两个来源', 'completed', 'hq'),
      /CHECK constraint failed/
    );

    // 计划周期与类型必须自洽：日历型不许带间隔小时
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO maintenance_plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(9003, 'MP-X', 1, '错配的计划', 'calendar', 90, 500, null, '2026-11-01', null, 'active', 'hq'),
      /CHECK constraint failed/
    );

    // 退役装备不进计划：一条计划都不该有（规则靠数据体现，不是靠约束）
    const retiredPlans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM maintenance_plans p JOIN equipment e ON e.id = p.equipment_id
         WHERE e.status = 'retired'`
      )
      .get();
    assert.strictEqual(retiredPlans.n, 0);

    // 故障树是一棵真树：只有一个根层级，且每个子节点的父节点都在树里
    const roots = db.prepare('SELECT COUNT(*) AS n FROM fault_tree_nodes WHERE parent_id IS NULL').get();
    const topEvents = db
      .prepare(`SELECT COUNT(*) AS n FROM fault_tree_nodes WHERE node_type = 'top'`)
      .get();
    assert.strictEqual(roots.n, topEvents.n, '顶事件就是树根，数量必须一致');
    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM fault_tree_nodes child
         WHERE child.parent_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM fault_tree_nodes parent WHERE parent.id = child.parent_id)`
      )
      .get();
    assert.strictEqual(orphans.n, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('每行都带 owner_code：行过滤演示的前提', () => {
  const dir = tempDir();
  createDemoProject({ dir, port: 45123 });

  const tables = {
    [FINANCE_DATABASE]: ['accounts', 'vouchers', 'voucher_entries', 'invoices', 'payments'],
    [INVENTORY_DATABASE]: [
      'warehouses',
      'products',
      'stock_levels',
      'inbound_orders',
      'inbound_items',
      'outbound_orders',
      'outbound_items',
    ],
    [MAINTENANCE_DATABASE]: [
      'equipment',
      'parts',
      'fault_tree_nodes',
      'faults',
      'maintenance_plans',
      'maintenance_reports',
      'report_parts',
      'consumables',
      'consumption_items',
    ],
  };
  for (const [file, names] of Object.entries(tables)) {
    const db = new DatabaseSync(dbPath(dir, file));
    try {
      for (const table of names) {
        const empty = db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table} WHERE owner_code IS NULL OR owner_code = ''`
          )
          .get();
        assert.strictEqual(empty.n, 0, `${file}.${table} 有行没有 owner_code`);
      }
    } finally {
      db.close();
    }
  }

  // 数据必须分散在多个 owner 上：全是一个值，行过滤就演示不出差别
  const db = new DatabaseSync(dbPath(dir, FINANCE_DATABASE));
  try {
    const owners = db.prepare('SELECT DISTINCT owner_code FROM vouchers').all();
    assert.ok(owners.length >= 3, `owner 只有 ${owners.length} 个，行过滤看不出效果`);
  } finally {
    db.close();
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('createDemoProject 重建时不会沿用旧数据', () => {
  const dir = tempDir();
  createDemoProject({ dir, port: 45123 });
  // 先把行删光，再跑一次必须重新种满。外键是开着的，只能从子表开始删
  const financeFile = dbPath(dir, FINANCE_DATABASE);
  const db = new DatabaseSync(financeFile);
  db.exec(`
    DELETE FROM payments;
    DELETE FROM invoices;
    DELETE FROM voucher_entries;
    DELETE FROM vouchers;
  `);
  db.close();

  createDemoProject({ dir, port: 45123 });
  const fresh = new DatabaseSync(financeFile);
  try {
    const row = fresh.prepare('SELECT COUNT(*) AS n FROM vouchers').get();
    assert.strictEqual(row?.n, 40);
  } finally {
    fresh.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
