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
  KIND_EXAMPLE,
  KIND_METRIC,
  KIND_RELATION,
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

test('ontology：每一类 kind 都能存下来（含关系与样例）', () => {
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

/**
 * 自定义 kind 的门（docs/ontology-next.md §0.1）。
 *
 * kind 不是展示标签，而是契约：系统靠它决定校验什么、渲染到哪、能驱动什么机器行为。
 * 允许用户自造 kind，系统对它就一无所知，只能退化成一个带标题的文本框——
 * 所以这里必须是硬拒绝，而不是「未知类别按普通文本处理」。
 */
test('ontology：未知 kind 被拒，且错误里列出可用类别', () => {
  const { store: db, cleanup } = store();
  try {
    let thrown = null;
    try {
      db.save({
        database: 'app',
        kind: 'diagnosis',
        name: '某行业自造的类别',
        definition: '不该被接受',
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof OntologyError, '未知 kind 必须抛 OntologyError');
    for (const kind of KINDS) {
      assert.ok(
        thrown.message.includes(kind),
        `错误信息要列出可用类别，缺了 ${kind}：${thrown.message}`
      );
    }
    assert.equal(db.list().length, 0, '被拒的条目不能落库');
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：条目只存用户填的内容，不会凭空长出字段', () => {
  const { store: db, cleanup } = store();
  try {
    const saved = db.save({
      database: 'app',
      kind: KIND_TERM,
      name: '一个说法',
      aliases: ['另一种说法'],
      definition: '一句说明',
      tables: ['app.main.某张表'],
    });
    // 键集合固定：任何「顺手加个字段」都会让这条断言失败
    assert.deepEqual(Object.keys(saved).sort(), [
      'aliases',
      'createdAt',
      'database',
      'definition',
      'expression',
      'facets',
      'id',
      'kind',
      'name',
      'payload',
      'severity',
      'tables',
      'updatedAt',
    ]);
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：关系和样例都进渲染，且按「词汇 → 实体 → 关系 → 约束 → 口径 → 样例」排序', () => {
  const { store: db, cleanup } = store();
  try {
    db.save({
      database: 'app',
      kind: KIND_TERM,
      name: '买家',
      aliases: ['客户'],
      definition: '付费主体',
      tables: ['app.main.customers'],
    });
    db.save({
      database: 'app',
      kind: KIND_RELATION,
      name: '下单人',
      definition: '把订单归到买家名下',
      tables: ['app.main.orders', 'app.main.customers'],
      payload: {
        from: { table: 'app.main.orders', column: 'customer_id' },
        to: { table: 'app.main.customers', column: 'id' },
        cardinality: 'many-to-one',
        alias: 'customer',
      },
    });
    db.save({
      database: 'app',
      kind: KIND_EXAMPLE,
      name: '上月各站点的平均履约时长是多少？',
      expression: '{ shipments { hub_id } }',
      tables: ['app.main.shipments'],
      payload: { notes: '按站点分组，不 join 明细' },
    });

    const text = db.render();

    // 关系必须给出「哪条边、哪个方向、什么基数」——这三样才是 join 时的歧义源
    assert.match(text, /## 关系/);
    assert.match(text, /app\.main\.orders\.customer_id → app\.main\.customers\.id/);
    assert.match(text, /many-to-one/);
    assert.match(text, /关系名=customer/);

    // 样例是「问题 → 查询」，只有问题没有查询等于零样本
    assert.match(text, /## 样例问答/);
    assert.match(text, /上月各站点的平均履约时长是多少？/);
    assert.match(text, /\{ shipments \{ hub_id \} \}/);

    // 顺序：先词汇，再实体，然后关系与约束，最后口径与样例（按小节标题比，别被正文里的词干扰）
    assert.ok(text.indexOf('## 术语表') < text.indexOf('## 关系'));
    assert.ok(text.indexOf('## 关系') < text.indexOf('## 样例问答'));
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：指标的粒度 / 单位 / 窗口 / 可执行片段都进渲染', () => {
  const { store: db, cleanup } = store();
  try {
    db.save({
      database: 'app',
      kind: KIND_METRIC,
      name: '平均履约时长',
      definition: '从揽收到签收',
      expression: 'avg(交付 - 揽收)',
      payload: {
        grain: '每运单',
        unit: '小时',
        window: { column: 'picked_up_at' },
        graphql: '{ shipments { delivered_at picked_up_at } }',
      },
    });

    const text = db.render();
    assert.match(text, /粒度=每运单/);
    assert.match(text, /单位=小时/);
    assert.match(text, /窗口=picked_up_at/);
    assert.match(text, /查询=\{ shipments \{ delivered_at picked_up_at \} \}/);
    // 原来的伪代码口径还在，人看的那一层没有被结构化字段挤掉
    assert.match(text, /avg\(交付 - 揽收\)/);
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：术语的值域与扩展属性都进渲染', () => {
  const { store: db, cleanup } = store();
  try {
    db.save({
      database: 'app',
      kind: KIND_TERM,
      name: '已支付',
      definition: '付款完成、可结算',
      payload: {
        column: 'app.main.orders.status',
        values: [
          { value: 'paid', label: '已支付' },
          { value: 'refunded', label: '已退款' },
        ],
      },
      facets: [{ key: '编码体系', value: 'ICD-10' }],
    });

    const text = db.render();
    assert.match(text, /值域：paid\(已支付\) \/ refunded\(已退款\)/);
    // facets 是「系统只转达、不解释」的那一层，原样带出去
    assert.match(text, /编码体系=ICD-10/);
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：规则把形态、作用表与判据都渲染出来', () => {
  const { store: db, cleanup } = store();
  try {
    db.save({
      database: 'app',
      kind: KIND_RULE,
      name: '只看未作废',
      definition: '作废的单据不该出现在任何统计里',
      severity: 'enforce',
      payload: {
        mode: 'filter',
        on: { table: 'app.main.orders' },
        predicate: '{ status: { _eq: "voided" } }',
      },
    });
    db.save({
      database: 'app',
      kind: KIND_RULE,
      name: '状态不可回退',
      definition: '仅提示：GraphJin 没有事务钩子',
      severity: 'warn',
      payload: {},
    });

    const text = db.render();
    const enforced = text.split('\n').find((line) => line.includes('只看未作废'));
    assert.match(enforced, /\[enforce\]/);
    assert.match(enforced, /形态=filter/);
    assert.match(enforced, /表=app\.main\.orders/);
    // 判据是 GraphJin 过滤表达式，原样渲染出来
    assert.ok(enforced.includes('判定='));
    assert.ok(enforced.includes('_eq'));

    // 没选形态的规则不渲染「形态=」，它本来就只是说明
    const advisory = text.split('\n').find((line) => line.includes('状态不可回退'));
    assert.ok(!advisory.includes('形态='));
  } finally {
    db.close();
    cleanup();
  }
});

test('ontology：老表升级补上 payload / facets 列，老条目读出空对象与空数组', () => {
  const ctx = tempDb();
  const db = new OntologyStore(ctx.dbPath);
  try {
    db.save({ database: 'app', kind: KIND_TERM, name: '买家', definition: '付费主体' });
  } finally {
    db.close();
  }

  // 模拟上一版（有 database，但没有 payload / facets）
  const legacy = new DatabaseSync(ctx.dbPath);
  legacy.exec('ALTER TABLE ontology RENAME TO ontology_old');
  legacy.exec(`CREATE TABLE ontology (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    database TEXT NOT NULL DEFAULT '',
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
    `INSERT INTO ontology (database, kind, name, aliases, definition, tables, expression, severity,
     created_at, updated_at)
     VALUES ('app', 'term', '老买家', '[]', '旧含义', '[]', '', 'info', 'now', 'now')`
  );
  legacy.close();

  const upgraded = new OntologyStore(ctx.dbPath);
  try {
    const [entry] = upgraded.list();
    assert.equal(entry.name, '老买家');
    assert.deepEqual(entry.payload, {});
    assert.deepEqual(entry.facets, []);
    // 新能力在同一份数据上可用，不用重建条目
    const updated = upgraded.save({ ...entry, payload: { values: ['a'] } });
    assert.deepEqual(updated.payload, { values: [{ value: 'a' }] });
  } finally {
    upgraded.close();
    ctx.cleanup();
  }
});

test('ontology：超长正文渲染时截断并标注（静默截断比不截断更糟）', () => {
  const { store: db, cleanup } = store();
  try {
    const long = 'x'.repeat(1200);
    db.save({ database: 'app', kind: KIND_TERM, name: '长条目', definition: long });

    const text = db.render();
    assert.match(text, /已截断/);
    assert.ok(!text.includes(long), '超长正文不应原样进上下文');
    // 截断后仍然保留可读的开头，不是整段丢弃
    assert.ok(text.includes('x'.repeat(50)));
  } finally {
    db.close();
    cleanup();
  }
});
