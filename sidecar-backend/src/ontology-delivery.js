'use strict';

/**
 * 交付层的「谁能看到什么」。
 *
 * 背景：本体论一旦经网关送出去，就等于把**语义**也送出去了——被屏蔽的表叫什么、
 * 它有哪些取值、围绕它有什么规则，这些本身就是情报。数据和语义要一起受限。
 *
 * 判定依据是 GraphJin 回写进 dev.yml 的 `sources[].access`：
 * - `blocked_tables`：对所有人（含 admin）不可读，语义一起隐藏；
 * - `admin_tables`：只有 admin 能读，非 admin 连它的条目都看不到。
 *
 * 注意 source 模式的语义：`grants` 只限制列与行，**不限制能看见哪些表**，
 * 所以这里不用 grants 判断可见性。真正的「看不见」只有上面两种。
 */

const fs = require('node:fs');
const path = require('node:path');

const { readSourceAccess } = require('./project');
const { buildCatalog } = require('./ontology-catalog');

/** dev.yml 快照按 mtime 缓存：同一份配置不重复解析，改了立刻生效 */
const accessCache = new Map();

/**
 * 读某个项目目录下的 access 快照。
 *
 * 为什么读 dev.yml 而不是问运行中的实例：网关的每个请求都会走这里，同步读一个小文件
 * 比每个请求发一次 MCP 调用便宜得多；而 dev.yml 本来就是「配置的真相来源」——
 * 写入走实例，实例回写它。
 *
 * @param {string} projectDir
 * @returns {Object|null} { 库名: access }；读不到时返回 null（表示不做过滤）
 */
function readAccessSnapshot(projectDir) {
  if (typeof projectDir !== 'string' || projectDir === '') return null;
  const file = path.join(path.resolve(projectDir), 'dev.yml');

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const cached = accessCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.accesses;

  let accesses = {};
  try {
    accesses = readSourceAccess(fs.readFileSync(file, 'utf8'));
  } catch {
    // 文件被改坏时按「没有配置」处理：宁可不过滤，也不要因为解析失败把所有语义藏掉
    accesses = {};
  }
  accessCache.set(file, { mtimeMs: stat.mtimeMs, accesses });
  return accesses;
}

/**
 * 每个库对某个角色隐藏哪些表。
 *
 * @param {Object} accesses { 库名: access }
 * @param {string|null} role
 * @returns {Map<string, Set<string>>}
 */
function hiddenTablesByDatabase(accesses, role) {
  const hidden = new Map();
  const isAdmin = role === 'admin';

  for (const [database, access] of Object.entries(accesses ?? {})) {
    const tables = new Set();
    for (const table of Array.isArray(access?.blocked_tables) ? access.blocked_tables : []) {
      if (typeof table === 'string' && table !== '') tables.add(table);
    }
    if (!isAdmin) {
      for (const table of Array.isArray(access?.admin_tables) ? access.admin_tables : []) {
        if (typeof table === 'string' && table !== '') tables.add(table);
      }
    }
    if (tables.size > 0) hidden.set(database, tables);
  }

  return hidden;
}

/** 一条引用属于哪个库的哪张表：`db.schema.table` 取首尾，`db.table` 也认，短引用归到条目自己的库 */
function splitRef(ref, fallbackDatabase) {
  const parts = String(ref ?? '')
    .trim()
    .split('.')
    .filter((part) => part !== '');
  if (parts.length === 0) return null;
  const table = parts[parts.length - 1];
  const database = parts.length >= 2 ? parts[0] : fallbackDatabase;
  return { database, table };
}

/** 条目引用到的所有表（含绑定列、关系两端、规则作用表） */
function refsOf(entry) {
  const refs = [];
  for (const ref of Array.isArray(entry?.tables) ? entry.tables : []) {
    if (typeof ref === 'string' && ref !== '') refs.push(ref);
  }
  const payload = entry?.payload ?? {};
  // 绑定列是「表引用 + 列」，去掉最后一段才是表；留着列名会被当成表名去比对
  if (typeof payload.column === 'string' && payload.column.includes('.')) {
    refs.push(payload.column.split('.').slice(0, -1).join('.'));
  }
  for (const side of [payload.from, payload.to, payload.on]) {
    if (typeof side?.table === 'string' && side.table !== '') refs.push(side.table);
  }
  return refs;
}

/**
 * 按角色过滤条目。
 *
 * 一条条目只要沾到任何一张被隐藏的表，整条都不给：它的一半语义仍然会暴露那张表
 * 的存在与含义（比如「订单 → 薪酬表」的关系名本身就说明了薪酬表在做什么）。
 *
 * 没有任何表引用的条目（纯术语、纯说明）保留——它们不指向被隐藏的对象。
 *
 * @param {Array<Object>} entries
 * @param {Object} options
 * @param {Object} options.accesses
 * @param {string|null} options.role
 * @returns {Array<Object>}
 */
function filterEntriesForRole(entries, { accesses = {}, role = null } = {}) {
  const hidden = hiddenTablesByDatabase(accesses, role);
  if (hidden.size === 0) return entries;

  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    for (const ref of refsOf(entry)) {
      const parsed = splitRef(ref, entry?.database ?? '');
      if (!parsed) continue;
      if (hidden.get(parsed.database)?.has(parsed.table)) return false;
    }
    return true;
  });
}

/**
 * 造一个「按角色取本体论」的提供方。
 *
 * 网关每个请求调一次；这里的对象是**懒渲染**的：只有真要 `document` / `catalog` 时才算，
 * 所以 tools/list 这种只关心「有没有条目」的请求不会白白渲染一遍全文。
 *
 * @param {Object} options
 * @param {{list: Function, renderEntries: Function}} options.store
 * @param {string|Function|null} [options.projectDir] 项目目录，或返回它的函数
 * @param {Function} [options.readAccesses] 便于测试注入，默认读 dev.yml
 * @returns {(role: string|null) => Object|null}
 */
function createOntologyProvider({
  store,
  projectDir = null,
  readAccesses = readAccessSnapshot,
} = {}) {
  return (role = null) => {
    const all = store.list();
    if (all.length === 0) return null;

    const dir = typeof projectDir === 'function' ? projectDir() : projectDir;
    const accesses = dir ? readAccesses(dir) : null;
    const entries = accesses ? filterEntriesForRole(all, { accesses, role }) : all;
    if (entries.length === 0) return null;

    const pick = ({ kind = null, database = null } = {}) =>
      entries.filter(
        (entry) => (!kind || entry.kind === kind) && (database === null || entry.database === database)
      );

    return {
      entries,
      databases: [...new Set(entries.map((entry) => entry.database))],
      // 懒渲染：每次会话都会取 document/catalog，而 tools/list 不会
      get document() {
        return store.renderEntries(entries);
      },
      get catalog() {
        return buildCatalog(entries);
      },
      render: (filter) => store.renderEntries(pick(filter)),
      renderEntries: (list) => store.renderEntries(list),
    };
  };
}

module.exports = {
  readAccessSnapshot,
  hiddenTablesByDatabase,
  filterEntriesForRole,
  splitRef,
  refsOf,
  createOntologyProvider,
};
