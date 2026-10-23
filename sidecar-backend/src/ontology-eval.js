'use strict';

/**
 * 样例评测：用**确定的规则**回答「这份本体论还能不能支撑这些问题」。
 *
 * 为什么不是「跑模型打分」：平台不拥有模型，也不该假装拥有。没有模型时最诚实的做法，
 * 是把「什么算对」写成可对账的规则，然后对**已有的样例**逐条核对：
 *
 * 1. `runs`：样例里那段查询现在还能跑通吗（表改名、列删掉，这里立刻红）；
 * 2. `structure`：它提到的东西，和条目声明的期望一致吗（防「改了查询忘了改期望」）；
 * 3. `grounded`：这个问题需要的表，本体论真的讲了吗（不讲，模型就只能在猜）。
 *
 * 这三项都不判断「模型答得好不好」——那需要真模型与真答案。所以 UI 里必须写清楚
 * 它测的是什么，不然「评测通过」会被读成「AI 很懂业务」，那是另一种谎。
 */

const { canonicalTableRef, resolveTableRef } = require('./ontology-lint');

/** 一次最多评测多少条样例：跑查询是有成本的，别让一次点击变成全表扫描 */
const MAX_EXAMPLES = 50;

/** 只读守卫：样例是「查询」，出现 mutation 就不执行——评测不该有副作用 */
const MUTATION_LIKE = /^\s*mutation\b/i;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 查询文本里是否出现这个 token。
 *
 * 按词边界判断而不是 `includes`：查 `amount` 不该命中 `total_amount`；
 * 但 token 首尾若不是单词字符（中文、带符号的取值），就不加边界，否则永远匹配不上。
 *
 * @param {string} haystack
 * @param {string} token
 * @returns {boolean}
 */
function mentions(haystack, token) {
  const clean = String(token ?? '').trim();
  if (clean === '') return false;
  const left = /^\w/.test(clean) ? '(?<![\\w])' : '';
  const right = /\w$/.test(clean) ? '(?![\\w])' : '';
  try {
    return new RegExp(`${left}${escapeRegExp(clean)}${right}`).test(haystack);
  } catch {
    return false;
  }
}

/** 表引用取最后一段：查询里写的是裸表名，期望里允许写完整规范形式 */
function tableNameOf(ref) {
  return String(ref ?? '').trim().split('.').pop();
}

/**
 * 对比查询文本与声明的期望。
 *
 * @param {string} queryText
 * @param {Object} [expect] { tables, columns, values, mustNot }
 * @returns {{declared: boolean, ok: boolean, missing: Object, leaked: string[]}}
 */
function compareQuery(queryText, expect = {}) {
  const tables = Array.isArray(expect.tables) ? expect.tables : [];
  const columns = Array.isArray(expect.columns) ? expect.columns : [];
  const values = Array.isArray(expect.values) ? expect.values : [];
  const mustNot = Array.isArray(expect.mustNot) ? expect.mustNot : [];

  const text = String(queryText ?? '');
  const missing = { tables: [], columns: [], values: [] };

  for (const ref of tables) {
    if (!mentions(text, tableNameOf(ref))) missing.tables.push(ref);
  }
  for (const column of columns) {
    if (!mentions(text, column)) missing.columns.push(column);
  }
  for (const value of values) {
    if (!mentions(text, value)) missing.values.push(value);
  }
  const leaked = mustNot.filter((token) => mentions(text, token));

  const declared = tables.length + columns.length + values.length + mustNot.length > 0;
  const ok =
    declared &&
    missing.tables.length === 0 &&
    missing.columns.length === 0 &&
    missing.values.length === 0 &&
    leaked.length === 0;

  return { declared, ok, missing, leaked };
}

/**
 * 非样例条目共引用到的表（解析成规范形式）。
 *
 * 只算「讲述」类条目：样例自己引用自己的表，不能拿来自我证明。
 *
 * @param {Array<Object>} entries
 * @param {Object|null} index buildTableIndex 的结果
 * @returns {Set<string>}
 */
function documentedTables(entries, index) {
  const documented = new Set();
  for (const entry of entries) {
    if (entry.kind === 'example') continue;
    for (const ref of Array.isArray(entry.tables) ? entry.tables : []) {
      const resolved = index ? resolveTableRef(index, String(ref)) : null;
      if (resolved && (resolved.status === 'exact' || resolved.status === 'partial')) {
        documented.add(canonicalTableRef(resolved.table));
      } else {
        const raw = String(ref ?? '').trim();
        if (raw !== '') documented.add(raw);
      }
    }
  }
  return documented;
}

/**
 * 逐条评测样例。
 *
 * @param {Object} options
 * @param {Array<Object>} [options.entries] 全部条目
 * @param {Object|null} [options.index] schema 索引；为空时跳过覆盖检查
 * @param {string|null} [options.database] 只看某个库
 * @param {Function|null} [options.runQuery] async (query) => void，抛错表示执行失败
 * @param {string} [options.note] 为什么没跑查询（回给 UI 说明）
 * @param {number} [options.maxExamples]
 * @returns {Promise<Object>} 评测报告
 */
async function evaluateExamples({
  entries = [],
  index = null,
  database = null,
  runQuery = null,
  note = '',
  maxExamples = MAX_EXAMPLES,
} = {}) {
  const scoped = (Array.isArray(entries) ? entries : []).filter(
    (entry) => !database || entry.database === database
  );
  const examples = scoped.filter((entry) => entry.kind === 'example');
  const capped = examples.slice(0, maxExamples);
  const documented = documentedTables(scoped, index);

  const results = [];
  for (const example of capped) {
    const query = typeof example.expression === 'string' ? example.expression.trim() : '';
    const expect = example.payload?.expect ?? {};
    const groundRefs =
      Array.isArray(expect.tables) && expect.tables.length > 0
        ? expect.tables
        : Array.isArray(example.tables)
          ? example.tables
          : [];

    const messages = [];

    // 1. 结构：声明的期望与查询文本是否对得上
    let structure;
    if (query === '') {
      structure = { status: 'fail' };
      messages.push('这条样例没有查询，无法评测');
    } else {
      const compared = compareQuery(query, expect);
      if (!compared.declared) {
        structure = { status: 'skipped' };
        messages.push('没有声明期望结构：只验了能否执行与覆盖');
      } else {
        structure = {
          status: compared.ok ? 'pass' : 'fail',
          missing: compared.missing,
          leaked: compared.leaked,
        };
        const missingParts = [];
        if (compared.missing.tables.length > 0) {
          missingParts.push(`表 ${compared.missing.tables.join('、')}`);
        }
        if (compared.missing.columns.length > 0) {
          missingParts.push(`列 ${compared.missing.columns.join('、')}`);
        }
        if (compared.missing.values.length > 0) {
          missingParts.push(`取值 ${compared.missing.values.join('、')}`);
        }
        if (missingParts.length > 0) {
          messages.push(`查询里没出现期望的${missingParts.join('；')}`);
        }
        if (compared.leaked.length > 0) {
          messages.push(`查询里出现了不该出现的 ${compared.leaked.join('、')}`);
        }
      }
    }

    // 2. 可执行：真跑一遍（只读、有上限）
    let runs;
    if (!runQuery) {
      runs = { status: 'skipped' };
    } else if (query === '') {
      runs = { status: 'skipped' };
    } else if (MUTATION_LIKE.test(query)) {
      runs = { status: 'skipped' };
      messages.push('样例看起来是写操作，评测不执行它');
    } else {
      try {
        await runQuery(query);
        runs = { status: 'pass' };
      } catch (error) {
        runs = { status: 'fail', error: error.message };
        messages.push(`执行失败：${error.message}`);
      }
    }

    // 3. 覆盖：这个问题需要的表，本体论讲了吗（需要 schema 才能把写法归一）
    let grounded;
    if (!index || groundRefs.length === 0) {
      grounded = { status: 'skipped' };
    } else {
      const uncovered = [];
      for (const ref of groundRefs) {
        const resolved = resolveTableRef(index, String(ref));
        const canonical =
          resolved.status === 'exact' || resolved.status === 'partial'
            ? canonicalTableRef(resolved.table)
            : String(ref).trim();
        if (!documented.has(canonical)) uncovered.push(ref);
      }
      grounded = { status: uncovered.length > 0 ? 'warn' : 'pass', uncovered };
      if (uncovered.length > 0) {
        messages.push(`这些表没有任何条目讲过：${uncovered.join('、')}——模型只能猜它们是什么`);
      }
    }

    const checks = [structure, runs, grounded];
    const status = checks.some((check) => check.status === 'fail')
      ? 'fail'
      : checks.some((check) => check.status === 'warn')
        ? 'warn'
        : checks.every((check) => check.status === 'skipped')
          ? 'skipped'
          : 'pass';

    results.push({
      id: example.id,
      question: example.name,
      database: example.database,
      status,
      checks: { structure, runs, grounded },
      messages,
    });
  }

  const summary = { pass: 0, warn: 0, fail: 0, skipped: 0, total: results.length };
  for (const result of results) summary[result.status] += 1;

  return {
    checkedAt: new Date().toISOString(),
    ranQueries: Boolean(runQuery),
    note,
    truncated: examples.length > capped.length,
    skippedExamples: Math.max(0, examples.length - capped.length),
    summary,
    results,
  };
}

module.exports = {
  MAX_EXAMPLES,
  mentions,
  compareQuery,
  evaluateExamples,
};
