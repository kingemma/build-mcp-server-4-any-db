'use strict';

/**
 * 条目的结构化载荷（payload）与自由扩展（facets）。
 *
 * 为什么需要这两样东西：
 * - `payload` 装「系统要校验、要渲染、将来还要执行」的语义（关系两端、度量粒度、
 *   规则判据……）。键名按 kind 白名单，写入时拒收未知键——否则它会在半年后变成
 *   一个谁也不敢动的 JSON 垃圾桶。
 * - `facets` 装「系统只转达、不解释」的行业补充信息。这是「不允许自定义 kind」
 *   的交换条件（docs/ontology-next.md §0.1）：语义必须受控，内容必须无限。
 *
 * 一条贯穿的原则：这里只做**形状**校验，不做语义校验。
 * 「关系两端在 schema 里对不上」属于 ontology-lint 的活——它需要 schema，
 * 而 save 拿不到，硬在这里查会把「schema 没加载时先记下来」的正常流程堵死。
 */

/** 每个 kind 允许的 payload 键。不在表里的键一律拒收。 */
const PAYLOAD_KEYS = {
  term: ['column', 'values'],
  concept: ['pkey', 'display', 'grain'],
  relation: ['from', 'to', 'cardinality', 'alias'],
  rule: ['mode', 'on', 'predicate'],
  metric: ['graphql', 'grain', 'unit', 'window'],
  example: ['notes', 'expect'],
};

/**
 * 规则的可执行形态。
 *
 * 为什么规则只有这一个「机制」字段：早期版本还有 scope（读/写）与 effect（拦/提醒），
 * 三者都在描述同一件事，必然出现「scope=read 却 mode=read-only」这种自相矛盾的组合。
 * 现在机制只由 mode 说，强度只由 severity 说（info / warn / enforce），没有第二个解释权。
 *
 * 写不变量与状态机刻意不在其中：GraphJin 没有对应能力，写进来就是一句空头承诺。
 */
const RULE_MODES = ['filter', 'hide-column', 'block-table', 'read-only'];

/** 样例的期望结构：查询里必须出现什么、不许出现什么 */
const EXPECT_KEYS = ['tables', 'columns', 'values', 'mustNot'];

/** 关系的基数。不是数据库术语也没有行业色彩，任何关系模型都只有这几种。 */
const CARDINALITIES = ['many-to-one', 'one-to-many', 'many-to-many', 'one-to-one'];

class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadError';
  }
}

/**
 * @param {*} value
 * @returns {string} 去空白的字符串；非字符串一律当空串，不抛错
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 归一化「表 + 列」这种两端结构。
 *
 * 允许只填一半：用户可能先记下「这条关系指 orders.customer_id」，列等下次再补。
 * 缺的一半由 lint 报（relation-incomplete），保存环节不拦——「先记下来再补」是
 * 维护知识时最常见的动作，拦住它等于逼人编一个假列名。
 *
 * @param {*} raw
 * @param {string} field 用于错误信息的字段名
 * @returns {{table?: string, column?: string}|null}
 */
function normalizeEnd(raw, field) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PayloadError(`${field} 必须是 { table, column } 这样的对象`);
  }
  const out = {};
  const table = text(raw.table);
  const column = text(raw.column);
  if (table !== '') out.table = table;
  if (column !== '') out.column = column;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 值域：一个列有哪些真实取值、各自什么意思。
 *
 * 接受 `['paid', 'refunded']` 或 `[{ value: 'paid', label: '已支付' }]` 两种输入，
 * 前者是手快时的写法，后者才带人话。空值直接丢弃，不报错——用户删行时会留下空行。
 *
 * @param {*} raw
 * @returns {Array<{value: string, label?: string, note?: string}>}
 */
function normalizeValues(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PayloadError('values 必须是数组');

  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const source = typeof item === 'string' ? { value: item } : item;
    if (!source || typeof source !== 'object') continue;
    const value = text(source.value);
    if (value === '') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const entry = { value };
    const label = text(source.label);
    const note = text(source.note);
    if (label !== '') entry.label = label;
    if (note !== '') entry.note = note;
    out.push(entry);
  }
  return out;
}

/**
 * 时间窗口：用哪一列、什么时区、按什么周期。
 *
 * 三个字段全可缺省——不是每个库都有时间维度，也不是每个度量都按时间切。
 *
 * @param {*} raw
 * @returns {{column?: string, tz?: string, period?: string}|null}
 */
function normalizeWindow(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PayloadError('window 必须是 { column, tz, period } 这样的对象');
  }
  const out = {};
  for (const key of ['column', 'tz', 'period']) {
    const value = text(raw[key]);
    if (value !== '') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 按 kind 归一化 payload。
 *
 * 未知键**直接拒收**而不是原谅：一旦允许塞任意键，payload 就退化成第二个
 * `definition`，而 lint 与渲染对它的理解永远追不上新增的键。
 *
 * @param {string} kind
 * @param {*} raw
 * @returns {Object} 只含有效值的对象；没有有效内容时返回 {}
 */
function normalizePayload(kind, raw) {
  const allowed = PAYLOAD_KEYS[kind];
  if (!allowed) throw new PayloadError(`未知类别「${kind}」，没有可用的扩展字段`);

  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PayloadError('payload 必须是对象');
  }

  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new PayloadError(
      `${kind} 不支持扩展字段 ${unknown.join(' / ')}（可用：${allowed.join(' / ')}）`
    );
  }

  const out = {};

  if (kind === 'term') {
    const column = text(raw.column);
    if (column !== '') out.column = column;
    const values = normalizeValues(raw.values);
    if (values.length > 0) out.values = values;
    return out;
  }

  if (kind === 'concept') {
    for (const key of ['pkey', 'display', 'grain']) {
      const value = text(raw[key]);
      if (value !== '') out[key] = value;
    }
    return out;
  }

  if (kind === 'relation') {
    const from = normalizeEnd(raw.from, 'from');
    const to = normalizeEnd(raw.to, 'to');
    if (from) out.from = from;
    if (to) out.to = to;
    const cardinality = text(raw.cardinality);
    if (cardinality !== '') {
      if (!CARDINALITIES.includes(cardinality)) {
        throw new PayloadError(`cardinality 只能是 ${CARDINALITIES.join(' / ')}`);
      }
      out.cardinality = cardinality;
    }
    const alias = text(raw.alias);
    if (alias !== '') out.alias = alias;
    return out;
  }

  if (kind === 'rule') {
    const mode = text(raw.mode);
    if (mode !== '') {
      if (!RULE_MODES.includes(mode)) {
        throw new PayloadError(`mode 只能是 ${RULE_MODES.join(' / ')}`);
      }
      out.mode = mode;
    }
    const on = normalizeEnd(raw.on, 'on');
    if (on) out.on = on;
    const predicate = text(raw.predicate);
    if (predicate !== '') out.predicate = predicate;
    return out;
  }

  if (kind === 'metric') {
    for (const key of ['graphql', 'grain', 'unit']) {
      const value = text(raw[key]);
      if (value !== '') out[key] = value;
    }
    const window = normalizeWindow(raw.window);
    if (window) out.window = window;
    return out;
  }

  // example
  const notes = text(raw.notes);
  if (notes !== '') out.notes = notes;
  const expect = normalizeExpect(raw.expect);
  if (Object.keys(expect).length > 0) out.expect = expect;
  return out;
}

/**
 * 字符串数组：去空白、去空项、去重。非法输入直接报错——静默丢弃会让用户以为已经存上了。
 *
 * @param {*} raw
 * @param {string} field
 * @returns {string[]}
 */
function normalizeStringList(raw, field) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PayloadError(`${field} 必须是数组`);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * 样例的期望结构。
 *
 * 为什么期望是显式数据而不是「从查询里推断」：推断需要一个 GraphQL 解析器，
 * 正则猜列名必然误报，而误报比不报更伤信任。让维护者写清「这个问题该碰哪些表、
 * 该过滤哪些值」，评测才有可对账的基准。
 *
 * @param {*} raw
 * @returns {{tables?: string[], columns?: string[], values?: string[], mustNot?: string[]}}
 */
function normalizeExpect(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PayloadError('expect 必须是对象');
  }

  const unknown = Object.keys(raw).filter((key) => !EXPECT_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new PayloadError(
      `expect 不支持 ${unknown.join(' / ')}（可用：${EXPECT_KEYS.join(' / ')}）`
    );
  }

  const out = {};
  for (const key of EXPECT_KEYS) {
    const list = normalizeStringList(raw[key], `expect.${key}`);
    if (list.length > 0) out[key] = list;
  }
  return out;
}

/**
 * 自由扩展：系统的「我不认识、但必须能存」的那部分。
 *
 * 只做三件事：键非空、值必须是标量、键不重复。不做类型推断，也不猜含义——
 * 一旦系统开始「理解」facets，它就不再是逃生口，而是一个没有 schema 的 payload。
 *
 * @param {*} raw
 * @returns {Array<{key: string, value: string|number|boolean, label?: string}>}
 */
function normalizeFacets(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PayloadError('facets 必须是数组');

  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const key = text(item.key);
    if (key === '') continue;
    if (seen.has(key)) throw new PayloadError(`扩展属性「${key}」重复了`);
    seen.add(key);

    const value = item.value;
    const scalar = ['string', 'number', 'boolean'].includes(typeof value);
    if (!scalar) {
      throw new PayloadError(`扩展属性「${key}」的值只能是文本、数字或真假`);
    }
    const entry = { key, value };
    const label = text(item.label);
    if (label !== '') entry.label = label;
    out.push(entry);
  }
  return out;
}

module.exports = {
  PayloadError,
  PAYLOAD_KEYS,
  EXPECT_KEYS,
  RULE_MODES,
  CARDINALITIES,
  normalizePayload,
  normalizeFacets,
  normalizeValues,
  normalizeWindow,
  normalizeExpect,
};
