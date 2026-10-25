/**
 * 演示项目的业务本体论：按刚生成的两个库自动造一套条目。
 *
 * 为什么不是写死的 JSON：演示库的 schema 是 demo.js 现场建出来的，条目里的表名、外键、
 * 状态取值如果抄一份常量，改一次建表语句就会悄悄对不上——体检报一堆「表不存在」，
 * 而这种错最容易被当成产品 bug。这里改成读 PRAGMA：表在才生成条目，外键在才生成关系，
 * 值域直接从数据里取样，schema 变了条目跟着变。
 *
 * 内容本身仍是人工写的（业务叫法、定义、口径），自动的只是「对齐」这一步：
 * 机器能保证条目指向真实存在的表和列，写不出好定义——那是人干的活。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { FINANCE_DATABASE, INVENTORY_DATABASE } = require('./demo');

/** 演示库里的 schema 名：sqlite 只有一个 main */
const SCHEMA = 'main';

/**
 * 表 → 概念。定义写的是「给 AI 看的业务语义」，不是表结构复述。
 * 表不在 schema 里就整条跳过（见文件头的说明）。
 */
const CONCEPTS = {
  accounts: {
    name: '会计科目',
    aliases: ['科目'],
    definition: '记账用的科目清单，分录里的金额最终都归到某个科目上；category 区分资产 / 负债 / 收入 / 费用。',
    display: 'name',
  },
  vouchers: {
    name: '记账凭证',
    aliases: ['凭证'],
    definition: '一笔业务在账上的载体，一张凭证下挂多条借贷分录；status 为 voided 的凭证作废，不参与任何统计。',
    display: 'voucher_no',
  },
  voucher_entries: {
    name: '凭证分录',
    aliases: ['分录', '明细'],
    definition: '凭证的借贷明细，direction 决定方向、amount 是金额；一张凭证下借贷必须相等。',
    display: 'memo',
  },
  invoices: {
    name: '销售发票',
    aliases: ['发票'],
    definition: '开给客户的发票，amount 是含税金额、tax_amount 是其中的税额；status 为 void 的是作废票。',
    display: 'invoice_no',
  },
  payments: {
    name: '收款单',
    aliases: ['回款', '收款'],
    definition: '客户实际付进来的钱，挂在某张发票上；一张发票可以分多次收款。',
    display: 'method',
  },
  warehouses: {
    name: '仓库',
    aliases: ['库房'],
    definition: '存放商品的实体仓，city 是所在城市；同一商品在不同仓各有自己的库存。',
    display: 'name',
  },
  products: {
    name: '商品',
    aliases: ['货品', 'SKU'],
    definition: '可售卖的最小单位，sku 是唯一编码；unit_cost 是当前单位成本，用于算库存金额。',
    display: 'name',
  },
  stock_levels: {
    name: '库存余额',
    aliases: ['库存'],
    definition: '某个商品在某个仓的结存：on_hand 是在库数量、reserved 是被订单占住但还没出库的数量，可用量是两者之差。',
    display: 'product_id',
  },
  inbound_orders: {
    name: '入库单',
    aliases: ['收货单'],
    definition: '向供应商收货的单据，status 为 inspecting 时还在质检、不能计入可用库存。',
    display: 'order_no',
  },
  inbound_items: {
    name: '入库明细',
    aliases: ['收货明细'],
    definition: '入库单里的商品行，quantity 是收货数量、unit_cost 是这次入库的成本单价。',
    display: 'product_id',
  },
  outbound_orders: {
    name: '出库单',
    aliases: ['发货单'],
    definition: '发给客户的出库单据，status 为 packed 时已打包待发、shipped 表示已发出。',
    display: 'order_no',
  },
  outbound_items: {
    name: '出库明细',
    aliases: ['发货明细'],
    definition: '出库单里的商品行，quantity 是发货数量、unit_price 是这次销售的单价。',
    display: 'product_id',
  },
};

/**
 * `${表}.${列}` → 术语。只收业务含义不显然的列：
 * id / owner_code 这类字段各表含义一致，逐表造术语只会把术语列表冲淡。
 * values 留空时会从库里采样真实取值（见 sampleValues）。
 */
const COLUMN_TERMS = {
  'vouchers.status': {
    name: '凭证状态',
    definition: 'posted 已记账、draft 草稿、voided 已作废；作废凭证不参与统计。',
    values: true,
  },
  'voucher_entries.direction': {
    name: '借贷方向',
    definition: 'debit 借方、credit 贷方；同一凭证下借贷金额必须相等。',
    values: true,
  },
  'invoices.status': {
    name: '发票状态',
    definition: 'issued 已开票未收、paid 已收款、void 已作废。',
    values: true,
  },
  'invoices.tax_amount': {
    name: '税额',
    definition: '含税金额里的增值税部分，税率按 13% 计；开票金额 = 不含税金额 + 税额。',
  },
  'payments.method': {
    name: '收款方式',
    definition: 'transfer 转账、card 刷卡、cash 现金。',
    values: true,
  },
  'products.unit': {
    name: '计量单位',
    definition: '商品的计价单位，库存数量与出入库数量都按这个单位计。',
    values: true,
  },
  'products.category': {
    name: '商品类目',
    definition: '商品的业务分类，用于按类目看销售与库存结构。',
    values: true,
  },
  'stock_levels.reserved': {
    name: '预留数量',
    definition: '已被订单占用、还没实际出库的数量；可用库存 = 在库数量 − 预留数量。',
  },
  'inbound_orders.status': {
    name: '入库状态',
    definition: 'received 已收货、inspecting 质检中；只有已收货的入库量才计入库存。',
    values: true,
  },
  'outbound_orders.status': {
    name: '出库状态',
    definition: 'packed 已打包待发、shipped 已发出。',
    values: true,
  },
  'outbound_items.unit_price': {
    name: '销售单价',
    definition: '这次出库的成交单价，通常高于商品当前成本单价。',
  },
};

/**
 * `${表}.${外键列}` → 关系的业务叫法。没配的外键用「对端概念名 + 关联」兜底，
 * 宁可叫得平淡，也不要造一个看不懂的名字。
 */
const RELATION_NAMES = {
  'voucher_entries.voucher_id': '所属凭证',
  'voucher_entries.account_id': '记入科目',
  'invoices.voucher_id': '来源凭证',
  'payments.invoice_id': '对应发票',
  'stock_levels.product_id': '库存商品',
  'stock_levels.warehouse_id': '存放仓库',
  'inbound_orders.warehouse_id': '收货仓库',
  'inbound_items.order_id': '所属入库单',
  'inbound_items.product_id': '入库商品',
  'outbound_orders.warehouse_id': '发货仓库',
  'outbound_items.order_id': '所属出库单',
  'outbound_items.product_id': '出库商品',
};

const ENDPOINT_SIDE = { from: 'from', to: 'to' };

/**
 * 业务规则：形态都选 filter（GraphJin 行过滤），谓词挑演示数据本身就满足的，
 * 于是「应用规则」跑一遍不会改变任何查询结果，只演示链路。
 * 真正的强约束（借贷平衡、库存不为负）写成 filter 表达不了，放在定义与指标口径里说。
 */
const RULES = {
  finance: [
    {
      name: '作废凭证不参与统计',
      definition: 'status 为 voided 的凭证已经从账上撤下，任何汇总口径都应排除，否则金额会被重复计入。',
      mode: 'filter',
      on: { table: 'vouchers' },
      predicate: '{ status: { _ne: "voided" } }',
      severity: 'enforce',
    },
    {
      name: '发票金额必须为正',
      definition: '开票金额代表实际应收，红冲场景会另开一张负数发票，但金额为 0 的发票不应出现在账上。',
      mode: 'filter',
      on: { table: 'invoices' },
      predicate: '{ amount: { _gt: 0 } }',
      severity: 'warn',
    },
  ],
  inventory: [
    {
      name: '只统计已收货的入库',
      definition: '正在质检（inspecting）的入库单还没入账，统计入库量时要把它们排除掉。',
      mode: 'filter',
      on: { table: 'inbound_orders' },
      predicate: '{ status: { _eq: "received" } }',
      severity: 'warn',
    },
    {
      name: '库存余额由出入库推导',
      definition: '库存余额是结果表，不手工改：写入与删除都应拦住，只允许通过入库、出库两类单据影响它。',
      mode: 'read-only',
      on: { table: 'stock_levels' },
      severity: 'enforce',
    },
  ],
};

/** 指标口径：expression 写人看得懂的公式，graphql 留空由使用方拼查询 */
const METRICS = {
  finance: [
    {
      name: '开票金额',
      definition: '统计期内已开票（不含作废）的含税金额合计。',
      tables: ['invoices'],
      expression: 'sum(amount) where status != "void"',
      unit: '元',
    },
    {
      name: '已收款金额',
      definition: '统计期内客户实际付进来的钱，按收款单发生日归集。',
      tables: ['payments'],
      expression: 'sum(amount)',
      unit: '元',
    },
    {
      name: '未回款余额',
      definition: '已开票未收到的钱：开票金额减去已收款金额，按发票而不是按客户口径。',
      tables: ['invoices', 'payments'],
      expression: 'sum(invoices.amount) - sum(payments.amount)',
      unit: '元',
    },
  ],
  inventory: [
    {
      name: '可用库存',
      definition: '真正能卖的量：在库数量减去被订单预留的部分。',
      tables: ['stock_levels'],
      expression: 'sum(on_hand - reserved)',
      unit: '件',
    },
    {
      name: '库存金额',
      definition: '压在库存上的钱，按商品当前单位成本计价，不含在途。',
      tables: ['stock_levels', 'products'],
      expression: 'sum(stock_levels.on_hand * products.unit_cost)',
      unit: '元',
    },
    {
      name: '出库销售额',
      definition: '统计期内出库明细的成交金额合计，按发货口径而不是开票口径。',
      tables: ['outbound_items'],
      expression: 'sum(quantity * unit_price)',
      unit: '元',
    },
  ],
};

/** 术语取值域最多带几个：全量塞进去只会让上下文变长，够判断口径就行 */
const MAX_TERM_VALUES = 8;

/**
 * 读一张表的列与外键。
 *
 * @param {DatabaseSync} db
 * @param {string} table
 * @returns {{columns: Array<string>, foreignKeys: Array<{column: string, table: string, to: string}>}}
 */
function readTable(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  const foreignKeys = db
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all()
    .filter((row) => row.table)
    .map((row) => ({ column: row.from, table: row.table, to: row.to }));
  return { columns, foreignKeys };
}

/**
 * 采样一列的取值域：中文/英文枚举值本身就在数据里，抄常量容易过期。
 *
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {string} column
 * @returns {Array<string>}
 */
function sampleValues(db, table, column) {
  const rows = db
    .prepare(`SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL LIMIT ?`)
    .all(MAX_TERM_VALUES);
  return rows.map((row) => String(row.value)).filter((value) => value !== '');
}

/**
 * 读一个演示库的表结构。
 *
 * @param {string} file sqlite 文件
 * @returns {Map<string, {columns: Array<string>, foreignKeys: Array<Object>}>}
 */
function readSchema(file) {
  const schema = new Map();
  if (!fs.existsSync(file)) return schema;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    for (const table of tables) schema.set(table, readTable(db, table));
  } finally {
    db.close();
  }
  return schema;
}

/**
 * 按库生成条目。
 *
 * @param {string} database 库名，同时作为条目的 database 字段
 * @param {string} file sqlite 文件
 * @returns {Array<Object>} 未落库的条目
 */
function buildDatabaseEntries(database, file) {
  const schema = readSchema(file);
  if (schema.size === 0) return [];

  const tableRef = (table) => `${database}.${SCHEMA}.${table}`;
  const conceptName = (table) => CONCEPTS[table]?.name ?? table;
  const entries = [];

  // 概念 + 表级术语：一个实体两种说法（定义给 AI，术语给检索）
  for (const [table, info] of schema) {
    const concept = CONCEPTS[table];
    entries.push({
      database,
      kind: 'concept',
      name: conceptName(table),
      aliases: concept?.aliases ?? [],
      definition: concept?.definition ?? `${table} 表对应的业务实体。`,
      tables: [tableRef(table)],
      payload: { pkey: info.columns.includes('id') ? 'id' : '', display: concept?.display ?? '' },
    });
    entries.push({
      database,
      kind: 'term',
      name: conceptName(table),
      aliases: [table, ...(concept?.aliases ?? [])],
      definition: concept?.definition ?? `${table} 表在对话里的叫法。`,
      tables: [tableRef(table)],
    });
  }

  // 列级术语：只收业务含义不显然的列，取值域从数据里采样
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const [key, term] of Object.entries(COLUMN_TERMS)) {
      const [table, column] = key.split('.');
      const info = schema.get(table);
      if (!info || !info.columns.includes(column)) continue;
      const values = term.values ? sampleValues(db, table, column) : [];
      entries.push({
        database,
        kind: 'term',
        name: term.name,
        aliases: [],
        definition: term.definition,
        tables: [tableRef(table)],
        payload: { column, values },
      });
    }
  } finally {
    db.close();
  }

  // 关系：外键就是关系，不另外维护一份
  for (const [table, info] of schema) {
    for (const fk of info.foreignKeys) {
      if (!schema.has(fk.table)) continue;
      entries.push({
        database,
        kind: 'relation',
        name: RELATION_NAMES[`${table}.${fk.column}`] ?? `${conceptName(fk.table)}关联`,
        aliases: [],
        definition: `${conceptName(table)} 通过 ${fk.column} 指向 ${conceptName(fk.table)}，多条${conceptName(table)}可以指向同一条${conceptName(fk.table)}。`,
        payload: {
          from: { table: tableRef(table), column: fk.column },
          to: { table: tableRef(fk.table), column: fk.to },
          cardinality: 'many-to-one',
        },
      });
    }
  }

  // 规则 / 指标：人工写的内容，但落地前先跟 schema 对一遍，表或列不在就跳过
  for (const rule of RULES[database] ?? []) {
    const info = schema.get(rule.on.table);
    if (!info) continue;
    if (rule.on.column && !info.columns.includes(rule.on.column)) continue;
    entries.push({
      database,
      kind: 'rule',
      name: rule.name,
      aliases: [],
      definition: rule.definition,
      severity: rule.severity,
      tables: [tableRef(rule.on.table)],
      payload: {
        mode: rule.mode,
        on: { table: tableRef(rule.on.table), ...(rule.on.column ? { column: rule.on.column } : {}) },
        ...(rule.predicate ? { predicate: rule.predicate } : {}),
      },
    });
  }

  for (const metric of METRICS[database] ?? []) {
    const tables = metric.tables.filter((table) => schema.has(table)).map(tableRef);
    if (tables.length !== metric.tables.length) continue;
    entries.push({
      database,
      kind: 'metric',
      name: metric.name,
      aliases: [],
      definition: metric.definition,
      tables,
      expression: metric.expression,
      payload: { unit: metric.unit },
    });
  }

  return entries;
}

/**
 * 读两个演示库，产出两个库各自的条目。
 *
 * @param {Object} options
 * @param {string} options.dir 演示项目目录（两个 sqlite 文件所在处）
 * @returns {Array<Object>}
 */
function buildDemoOntology({ dir }) {
  return [
    ...buildDatabaseEntries('finance', path.join(dir, FINANCE_DATABASE)),
    ...buildDatabaseEntries('inventory', path.join(dir, INVENTORY_DATABASE)),
  ];
}

/**
 * 把条目写进本体论存储（同库 + 同类 + 同名是 upsert，重复点「一键演示」不会翻倍）。
 *
 * @param {Object} options
 * @param {string} options.dir 演示项目目录
 * @param {{save: (entry: Object) => Object}} options.store OntologyStore
 * @returns {{total: number, byDatabase: Object<string, Object<string, number>>}}
 */
function seedDemoOntology({ dir, store }) {
  const entries = buildDemoOntology({ dir });
  for (const entry of entries) store.save(entry);

  const byDatabase = {};
  for (const entry of entries) {
    const bucket = (byDatabase[entry.database] ??= {});
    bucket[entry.kind] = (bucket[entry.kind] ?? 0) + 1;
  }
  return { total: entries.length, byDatabase };
}

module.exports = {
  buildDemoOntology,
  seedDemoOntology,
  COLUMN_TERMS,
  CONCEPTS,
  METRICS,
  RULES,
};
