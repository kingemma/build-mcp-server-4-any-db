'use strict';

/**
 * 起草助手：从**已有的东西**（schema 的结构、库里的注释、列里的真实取值）
 * 反推出可用的本体论草稿。
 *
 * 为什么需要它：本体论类功能最常见的死法不是「功能不够」，而是**空表格**——
 * 面对 60 张表，没人愿意手敲第一批条目。人愿意做的是「审阅并修正」，不是「凭空创造」。
 *
 * 两条边界，都很重要：
 * 1. 这里**只产出草稿，不落库**。定义与边界得人来写；自动生成的空定义进了
 *    instructions 只会稀释真正的知识。UI 把草稿填进表单，保存仍是人的动作。
 * 2. 值域扫描**只接受低基数列**。一列如果有几百个不同取值（姓名、金额、时间戳），
 *    它不是字典，硬扫出来塞进本体论只会把上下文撑爆，还可能把敏感值带给所有客户端。
 */

const {
  canonicalTableRef,
  resolveTableRef,
  buildTableIndex,
  splitColumnRef,
} = require('./ontology-lint');

/** 每类最多列多少条草稿；总数再多也只是「还有 N 项」——一次给人 200 条等于什么都没给 */
const MAX_PER_KIND = 30;

/** 值域扫描的上限：超过这么多不同取值就不该当字典 */
const MAX_DISTINCT = 20;

/** 单个取值的长度上限：更长的基本是自由文本（备注、URL、JSON），不是枚举 */
const MAX_VALUE_LENGTH = 80;

/**
 * `order_items` → `Order items`，`customer_id` → `Customer id`。
 *
 * 只做两件事：把分隔符换成空格、ASCII 首字母大写。中文原样返回——
 * 非要「翻译」中文表名只会产出比原样更难读的东西。
 *
 * @param {string} raw
 * @returns {string}
 */
function humanizeName(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';
  const spaced = text.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z]/.test(spaced)) return spaced;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * 外键列名 → 关系名：`customer_id` → `Customer`。
 *
 * 去掉尾部的 id 是因为「下单人 = customer_id」里，`id` 不是业务含义的一部分；
 * 但如果整列就叫 `id`，去掉就空了，那就退回原样。
 *
 * @param {string} column
 * @returns {string}
 */
function relationNameFromColumn(column) {
  const humanized = humanizeName(column);
  const stripped = humanized.replace(/\s+id$/i, '').trim();
  return stripped === '' ? humanized : stripped;
}

/**
 * @param {{table: string, column: string}} side
 * @returns {{table: string, column: string}|null}
 */
function resolveSide(index, side) {
  if (!side || side.table === undefined) return null;
  const resolved = resolveTableRef(index, String(side.table));
  if (resolved.status !== 'exact' && resolved.status !== 'partial') return null;
  const table = canonicalTableRef(resolved.table);
  const column = String(side.column ?? '').trim();
  return table === '' || column === '' ? null : { table, column };
}

/** 无序对：同一条边从哪端写进来都算同一个 */
function pairKey(a, b) {
  const left = `${a.table}.${a.column}`.toLowerCase();
  const right = `${b.table}.${b.column}`.toLowerCase();
  return [left, right].sort().join('<>');
}

/**
 * 从 schema 生成候选条目。
 *
 * 覆盖判断用的是「解析后比对」而不是字符串相等：用户可能把 `app.main.orders`
 * 写成 `app.orders`，两者指的是同一张表，不该因为写法不同就重复起草。
 *
 * @param {Object} options
 * @param {{tables: Array<Object>, relationships: Array<Object>}|null} options.schema
 * @param {Array<Object>} [options.entries] 已维护的条目
 * @param {string|null} [options.database] 只看某个库
 * @returns {Object} { counts, concepts, relations, terms, truncated }
 */
function proposeEntries({ schema = null, entries = [], database = null } = {}) {
  const empty = {
    counts: { concepts: 0, relations: 0, terms: 0 },
    concepts: [],
    relations: [],
    terms: [],
    truncated: { concepts: false, relations: false, terms: false },
  };
  if (!schema || !Array.isArray(schema.tables) || schema.tables.length === 0) return empty;

  const index = buildTableIndex(schema);
  const inScope = (table) => !database || table.database === database;
  const scopedEntries = (Array.isArray(entries) ? entries : []).filter(
    (entry) => !database || entry.database === database
  );

  const coveredTables = new Set();
  const coveredPairs = new Set();
  const coveredColumns = new Set();

  for (const entry of scopedEntries) {
    for (const ref of Array.isArray(entry.tables) ? entry.tables : []) {
      const resolved = resolveTableRef(index, String(ref));
      if (resolved.status === 'exact' || resolved.status === 'partial') {
        coveredTables.add(canonicalTableRef(resolved.table));
      }
    }

    if (entry.kind === 'relation') {
      const from = resolveSide(index, entry.payload?.from);
      const to = resolveSide(index, entry.payload?.to);
      if (from && to) coveredPairs.add(pairKey(from, to));
    }

    if (entry.kind === 'term' && typeof entry.payload?.column === 'string') {
      const parsed = splitColumnRef(entry.payload.column);
      if (parsed) {
        const resolved = resolveTableRef(index, parsed.table);
        if (resolved.status === 'exact' || resolved.status === 'partial') {
          coveredColumns.add(`${canonicalTableRef(resolved.table)}.${parsed.column}`.toLowerCase());
        }
      }
    }
  }

  const concepts = [];
  for (const table of index.tables.filter(inScope)) {
    const ref = canonicalTableRef(table);
    if (ref === '' || coveredTables.has(ref)) continue;
    concepts.push({
      kind: 'concept',
      name: humanizeName(table.name),
      definition: typeof table.comment === 'string' ? table.comment.trim() : '',
      tables: [ref],
    });
  }

  const relations = [];
  for (const rel of index.relationships.filter(
    (item) => !database || item.fromDatabase === database
  )) {
    const from = resolveSide(index, {
      table: canonicalTableRef({
        database: rel.fromDatabase,
        schema: rel.fromSchema,
        name: rel.fromTable,
      }),
      column: rel.fromColumn,
    });
    const to = resolveSide(index, {
      table: canonicalTableRef({
        database: rel.toDatabase,
        schema: rel.toSchema,
        name: rel.toTable,
      }),
      column: rel.toColumn,
    });
    if (!from || !to || coveredPairs.has(pairKey(from, to))) continue;
    relations.push({
      kind: 'relation',
      name: relationNameFromColumn(rel.fromColumn),
      definition: '',
      tables: [from.table, to.table],
      from,
      to,
      cardinality: 'many-to-one',
    });
  }

  const terms = [];
  for (const table of index.tables.filter(inScope)) {
    const ref = canonicalTableRef(table);
    for (const column of Array.isArray(table.columns) ? table.columns : []) {
      const comment = typeof column.comment === 'string' ? column.comment.trim() : '';
      // 没有注释的列不给候选：名字本身已经在 schema 里，再抄一遍没有任何信息增量
      if (comment === '' || !column.name) continue;
      const columnRef = `${ref}.${column.name}`;
      if (coveredColumns.has(columnRef.toLowerCase())) continue;
      terms.push({
        kind: 'term',
        name: humanizeName(column.name),
        definition: comment,
        aliases: [column.name],
        tables: [ref],
        column: columnRef,
      });
    }
  }

  return {
    counts: { concepts: concepts.length, relations: relations.length, terms: terms.length },
    concepts: concepts.slice(0, MAX_PER_KIND),
    relations: relations.slice(0, MAX_PER_KIND),
    terms: terms.slice(0, MAX_PER_KIND),
    truncated: {
      concepts: concepts.length > MAX_PER_KIND,
      relations: relations.length > MAX_PER_KIND,
      terms: terms.length > MAX_PER_KIND,
    },
  };
}

/**
 * 把抽样到的行汇总成值域建议。
 *
 * @param {Array<Object>} rows 查询返回的行
 * @param {string} column 要汇总的列
 * @param {Object} [options]
 * @returns {Object} { sampled, distinct, values, suitable, reason }
 */
function summarizeValues(rows, column, { maxDistinct = MAX_DISTINCT, maxLength = MAX_VALUE_LENGTH } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = new Map();
  for (const row of list) {
    const value = row?.[column];
    if (value === null || value === undefined) continue;
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const distinct = [...counts.keys()];
  const base = { sampled: list.length, distinct: distinct.length, values: [], suitable: false, reason: '' };

  if (list.length === 0) {
    return { ...base, reason: '没有取到数据：表可能是空的，或当前角色读不到它' };
  }
  if (distinct.length > maxDistinct) {
    return {
      ...base,
      reason: `不同取值有 ${distinct.length} 个，超过 ${maxDistinct}：这列不是低基数列，不适合做值域`,
    };
  }
  const longest = distinct.find((value) => value.length > maxLength);
  if (longest !== undefined) {
    return {
      ...base,
      reason: '取值的长度差异很大，看起来是自由文本（备注、ID、JSON），不适合做值域',
    };
  }
  // 值域在界面上是「每行一条」编辑的，取值里带等号或换行会把格式本身弄坏
  const separatorLike = distinct.find((value) => value.includes('=') || /[\r\n]/.test(value));
  if (separatorLike !== undefined) {
    return {
      ...base,
      reason: '取值里含等号或换行，像是键值对文本，不适合做值域',
    };
  }

  // 高频在前：值域列表按出现频率读起来更像「主要取值 + 长尾」
  const values = distinct.sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b)
  );
  return { ...base, suitable: true, values };
}

module.exports = {
  MAX_PER_KIND,
  MAX_DISTINCT,
  MAX_VALUE_LENGTH,
  humanizeName,
  relationNameFromColumn,
  proposeEntries,
  summarizeValues,
};
