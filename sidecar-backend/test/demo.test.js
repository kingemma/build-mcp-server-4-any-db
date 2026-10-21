const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createDemoProject, DEMO_ROLE } = require('../src/demo');
const { readSourceConnections } = require('../src/project');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-demo-'));
}

test('createDemoProject 种出示例数据与只读角色', () => {
  const dir = tempDir();
  const report = createDemoProject({ dir, port: 45123 });

  assert.deepStrictEqual(report.databases, ['demo']);
  assert.ok(report.roles.includes('admin'));
  assert.ok(report.roles.includes(DEMO_ROLE));
  assert.deepStrictEqual(report.tables.sort(), ['customers', 'orders']);

  // 行过滤必须真的写进 dev.yml：这是演示「权限立刻生效」的关键
  const text = fs.readFileSync(path.join(dir, 'dev.yml'), 'utf8');
  assert.match(text, /filter: "\{ owner_code: \{ _eq: \$user_code \} \}"/);
  assert.match(text, /- role: "analyst"/);
  // 演示项目是只读的
  assert.match(text, /write: "blocked"/);
  assert.match(text, /delete: "blocked"/);

  const conns = readSourceConnections(text);
  assert.deepStrictEqual(Object.keys(conns), ['demo']);
  assert.strictEqual(conns.demo.type, 'sqlite');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('createDemoProject 重建时不会沿用旧数据', () => {
  const dir = tempDir();
  createDemoProject({ dir, port: 45123 });
  // 先把行删光，再跑一次必须重新种满
  const dbFile = path.join(dir, 'orders.db');
  const db = new DatabaseSync(dbFile);
  db.exec('DELETE FROM orders');
  db.close();

  createDemoProject({ dir, port: 45123 });
  const fresh = new DatabaseSync(dbFile);
  try {
    const row = fresh.prepare('SELECT COUNT(*) AS n FROM orders').get();
    assert.strictEqual(row?.n, 6);
  } finally {
    fresh.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
