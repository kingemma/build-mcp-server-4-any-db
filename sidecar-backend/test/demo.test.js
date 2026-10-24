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
} = require('../src/demo');
const { readSourceConnections } = require('../src/project');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-demo-'));
}

/** @param {string} dir @param {string} file @returns {string} 库文件路径 */
function dbPath(dir, file) {
  return path.join(dir, file);
}

test('createDemoProject 种出两个库与各自的只读角色', () => {
  const dir = tempDir();
  const report = createDemoProject({ dir, port: 45123 });

  assert.deepStrictEqual(report.databases, ['finance', 'inventory']);
  assert.deepStrictEqual(report.roles, [
    'admin',
    ROLE_BY_DATABASE.finance,
    ROLE_BY_DATABASE.inventory,
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

  // 每个库一个角色：finance_analyst 不该出现在 inventory 的 grants 里，
  // 「一个只读角色走天下」演示不出角色 × 库
  const text = fs.readFileSync(path.join(dir, 'dev.yml'), 'utf8');
  assert.match(text, /- role: "finance_analyst"/);
  assert.match(text, /- role: "inventory_viewer"/);
  // 行过滤必须真的写进 dev.yml：这是演示「权限立刻生效」的关键
  assert.match(text, /filter: "\{ owner_code: \{ _eq: \$user_code \} \}"/);
  // 演示项目是只读的
  assert.match(text, /write: "blocked"/);
  assert.match(text, /delete: "blocked"/);

  const conns = readSourceConnections(text);
  assert.deepStrictEqual(Object.keys(conns), ['finance', 'inventory']);
  assert.strictEqual(conns.finance.type, 'sqlite');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('两个库都有真实数据：行数、外键与借贷平衡', () => {
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
