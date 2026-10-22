'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  OntologyStore,
  OntologyError,
  KINDS,
  KIND_CONCEPT,
  KIND_METRIC,
  KIND_RULE,
  KIND_TERM,
} = require('../src/ontology');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-'));
  const dbPath = path.join(dir, 'mcp-builder.db');
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function store() {
  const ctx = tempDb();
  return { store: new OntologyStore(ctx.dbPath), cleanup: ctx.cleanup };
}

test('ontology：保存后读回来的字段完整，脏 JSON 列降级成空数组', () => {
  const { store: db, cleanup } = store();
  try {
    const saved = db.save({
      database: 'app',
      kind: KIND_CONCEPT,
      name: '买家',
      aliases: ['客户', 'customer'],
      definition: '平台的付费主体',
      tables: ['app.main.customers'],
    });
    assert.equal(saved.id, 1);
    assert.equal(saved.database, 'app');
    assert.deepEqual(saved.aliases, ['客户', 'customer']);
    assert.deepEqual(saved.tables, ['app.main.customers']);

    // 直接写坏数据库里的列，验证读取侧降级而不抛错
    db.db.prepare('UPDATE ontology SET aliases = ? WHERE id = ?').run('not-json', saved.id);
    assert.deepEqual(db.get(saved.id).aliases, []);
    assert.deepEqual(db.list()[0].aliases, []);
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：同一个词在不同库可以各有各的含义', () => {
  const { store: db, cleanup } = store();
  try {
    db.save({ database: 'app', kind: KIND_TERM, name: '订单', definition: '购买意图' });
    db.save({ database: 'analytics', kind: KIND_TERM, name: '订单', definition: '一次访问事件' });
    assert.equal(db.list().length, 2);
    assert.equal(db.list({ database: 'app' })[0].definition, '购买意图');
    assert.equal(db.list({ database: 'analytics' })[0].definition, '一次访问事件');
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：同库同名同类覆盖，不插两条', () => {
  const { store: db, cleanup } = store();
  try {
    db.save({ database: 'app', kind: KIND_TERM, name: 'GMV', definition: '成交总额' });
    const updated = db.save({
      database: 'app',
      kind: KIND_TERM,
      name: 'GMV',
      definition: '已支付订单金额合计',
    });
    assert.equal(db.list({ database: 'app' }).length, 1);
    assert.equal(db.get(updated.id).definition, '已支付订单金额合计');
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：同名不同类互不覆盖', () => {
  const { store: db, cleanup } = store();
  try {
    db.save({ database: 'app', kind: KIND_TERM, name: '订单', definition: '口语里的下单' });
    db.save({ database: 'app', kind: KIND_CONCEPT, name: '订单', definition: '购买意图' });
    assert.equal(db.list({ database: 'app' }).length, 2);
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：非法 kind / severity / 空名称 / 缺数据库都被拒', () => {
  const { store: db, cleanup } = store();
  try {
    assert.throws(() => db.save({ database: 'app', kind: 'nope', name: 'x' }), OntologyError);
    assert.throws(
      () => db.save({ database: 'app', kind: KIND_TERM, name: 'x', severity: 'fatal' }),
      OntologyError
    );
    assert.throws(() => db.save({ database: 'app', kind: KIND_TERM, name: '  ' }), /名称 不能为空/);
    assert.throws(() => db.save({ kind: KIND_TERM, name: 'x' }), /数据库 不能为空/);
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：规则至少要填说明或约束', () => {
  const { store: db, cleanup } = store();
  try {
    assert.throws(() => db.save({ database: 'app', kind: KIND_RULE, name: '空规则' }), /至少要填/);
    const ok = db.save({
      database: 'app',
      kind: KIND_RULE,
      name: '金额为正',
      expression: 'amount > 0',
    });
    assert.equal(ok.severity, 'info');
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：删除返回是否真的删掉了', () => {
  const { store: db, cleanup } = store();
  try {
    const saved = db.save({ database: 'app', kind: KIND_TERM, name: '临时', definition: 'x' });
    assert.equal(db.remove(saved.id), true);
    assert.equal(db.remove(saved.id), false);
    assert.equal(db.list().length, 0);
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：没归属到库的老条目默认不出现，显式传空串才看得到', () => {
  const { store: db, cleanup } = store();
  try {
    // 直接插一条 database 为空的记录，模拟升级前的老数据
    db.db
      .prepare(
        `INSERT INTO ontology (database, kind, name, aliases, definition, tables, expression,
         severity, created_at, updated_at)
         VALUES ('', 'term', '老条目', '[]', 'x', '[]', '', 'info', 'now', 'now')`
      )
      .run();
    db.save({ database: 'app', kind: KIND_TERM, name: '新条目', definition: 'y' });
    assert.deepEqual(
      db.list().map((entry) => entry.name),
      ['新条目']
    );
    assert.deepEqual(
      db.list({ database: '' }).map((entry) => entry.name),
      ['老条目']
    );
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：老表升级会补上 database 列，不丢已有条目', () => {
  const ctx = tempDb();
  const db = new OntologyStore(ctx.dbPath);
  try {
    db.save({ database: 'app', kind: KIND_TERM, name: '买家', definition: 'y' });
  } finally {
    db.close();
  }
  // 模拟升级前的表结构：没有 database 列
  const legacy = new DatabaseSync(ctx.dbPath);
  legacy.exec('ALTER TABLE ontology RENAME TO ontology_old');
  legacy.exec(`CREATE TABLE ontology (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    definition TEXT NOT NULL DEFAULT '',
    tables TEXT NOT NULL DEFAULT '[]',
    expression TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'info',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  legacy.exec(
    `INSERT INTO ontology (kind, name, aliases, definition, tables, expression, severity,
     created_at, updated_at)
     VALUES ('term', '老买家', '[]', '旧含义', '[]', '', 'info', 'now', 'now')`
  );
  legacy.close();

  const upgraded = new OntologyStore(ctx.dbPath);
  try {
    const names = upgraded.list({ database: '' }).map((entry) => entry.name);
    assert.deepEqual(names, ['老买家']);
    assert.equal(upgraded.list().length, 0);
  } finally {
    upgraded.close();
    ctx.cleanup();
  }
});

test('ontology：databases 列出已维护本体论的库', () => {
  const { store: db, cleanup } = store();
  try {
    assert.deepEqual(db.databases(), []);
    db.save({ database: 'analytics', kind: KIND_TERM, name: '事件', definition: 'x' });
    db.save({ database: 'app', kind: KIND_TERM, name: '买家', definition: 'y' });
    assert.deepEqual(db.databases(), ['analytics', 'app']);
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：单库渲染不带库标题，多库按库分组', () => {
  const { store: db, cleanup } = store();
  try {
    assert.equal(db.render(), '');

    db.save({
      database: 'app',
      kind: KIND_TERM,
      name: '买家',
      aliases: ['客户'],
      definition: '平台的付费主体',
      tables: ['app.main.customers'],
    });
    db.save({
      database: 'app',
      kind: KIND_RULE,
      name: '金额恒为正',
      definition: '写入前必须校验',
      severity: 'enforce',
    });
    db.save({
      database: 'analytics',
      kind: KIND_METRIC,
      name: '已支付 GMV',
      definition: '已支付订单的金额合计',
      expression: 'sum(amount) where status = "paid"',
    });

    const all = db.render();
    // 两个库：出现库标题，按库名排序，且各节内容不互相串
    const analyticsStart = all.indexOf('## 数据库 analytics');
    const appStart = all.indexOf('## 数据库 app');
    assert.ok(analyticsStart !== -1 && appStart !== -1);
    assert.ok(analyticsStart < appStart, '应按库名排序：analytics 在 app 之前');
    const appSection = all.slice(appStart);
    const analyticsSection = all.slice(analyticsStart, appStart);
    assert.ok(appSection.includes('买家'));
    assert.ok(!appSection.includes('已支付 GMV'));
    assert.ok(analyticsSection.includes('已支付 GMV'));
    assert.ok(!analyticsSection.includes('买家'));
    // 词汇 -> 规则 -> 指标 的顺序
    assert.ok(all.indexOf('术语表') < all.indexOf('业务规则'));
    assert.match(all, /买家（客户）/);
    assert.match(all, /\[enforce\] \*\*金额恒为正\*\*/);
    assert.match(all, /sum\(amount\) where status = "paid"/);
    // 表名只作为定位提示出现，不展开列结构
    assert.match(all, /\[app\.main\.customers\]/);
    assert.ok(!all.includes('CREATE TABLE'));

    // 只看一个库时，不该出现另一个库的内容
    const onlyApp = db.render({ database: 'app' });
    assert.ok(onlyApp.includes('买家'));
    assert.ok(!onlyApp.includes('已支付 GMV'));
    // 单库不该为库名多包一层标题
    assert.ok(!onlyApp.includes('## 数据库'));

    // 只看一类
    const onlyRules = db.render({ kind: KIND_RULE });
    assert.ok(onlyRules.includes('金额恒为正'));
    assert.ok(!onlyRules.includes('已支付 GMV'));

    // 库 + 类组合
    assert.match(db.render({ database: 'analytics', kind: KIND_METRIC }), /已支付 GMV/);
    assert.equal(db.render({ database: 'app', kind: KIND_METRIC }), '');
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：render 拒绝非法 kind', () => {
  const { store: db, cleanup } = store();
  try {
    assert.throws(() => db.render({ kind: 'nope' }), OntologyError);
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：四类 kind 都能存下来', () => {
  const { store: db, cleanup } = store();
  try {
    for (const kind of KINDS) {
      db.save({
        database: 'app',
        kind,
        name: `条目-${kind}`,
        definition: 'd',
        expression: kind === KIND_RULE ? 'x > 0' : '',
      });
    }
    assert.equal(db.list().length, KINDS.length);
    assert.equal(db.list({ kind: KIND_CONCEPT }).length, 1);
  } finally {
    db.close();
    cleanup();
  }
});
