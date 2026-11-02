'use strict';

/**
 * 用 LLM 把数据库 schema 生成为业务本体论候选。
 *
 * 为什么按「批次」而不是一次生成（第一性原理）：
 * 一次请求同时吞吐两个无界量——输入是整库 schema（表/列越多越长），输出是六类合一的大
 * JSON（条目越多越长）。任一端超过模型的上下文或 max_tokens，结果就是 prompt 被截、
 * 输出被截、JSON 解析失败得到空对象，表现为「调用成功但 0 条」；而整库一次跑完的耗时
 * 也很容易超过请求超时，被 AbortController 掐断成 AbortError。
 * 所以把工作切成有界的小块：表按固定条数分批、外键按固定条数分批，每类各调用一次。
 * 每条 prompt / 输出都有上限；单批失败只丢那一批，其余照常返回，错误也能定位到具体类别。
 *
 * 与 ontology-scaffold.js（纯规则反推）平行：产出同样形状（见 toEntry），可直接落库。
 * 语义校验（关系两端、指标列是否存在）仍留给 ontology-lint；这里只做 payload 的形状校验。
 */

const { callChatCompletion } = require('./llm-client');
const { normalizePayload } = require('./ontology-payload');
const { KINDS, SEVERITIES } = require('./ontology');

/** 单次请求超时：分块后每批变短，但本地模型仍可能慢，给足 5 分钟（可用环境变量覆盖） */
const GENERATE_TIMEOUT_MS = Number(process.env.MCP_BUILDER_LLM_TIMEOUT_MS) || 300_000;
/** 每个表批次多少张表；每个外键批次多少条外键。批越大调用越少，但单次越慢越易截断 */
const TABLES_PER_BATCH = Number(process.env.MCP_BUILDER_ONTOLOGY_BATCH_TABLES) || 12;
const RELATIONS_PER_BATCH = Number(process.env.MCP_BUILDER_ONTOLOGY_BATCH_RELATIONS) || 40;

const SYSTEM_PROMPT = [
  '你是一名资深数据架构师，擅长从数据库 schema 提炼业务语义。',
  '你只输出符合要求的 JSON，不输出任何多余文字或解释。',
  '所有业务名称、定义使用中文。',
].join('\n');

/**
 * 每一类怎么生成：scope 决定按表分批还是按外键分批，payload 是该类允许的键。
 * 分开写而不是共用一段大 prompt：一次只问一类，模型更专注，输出也更短、更不容易被截断。
 */
const CATEGORY_GUIDES = {
  term: {
    scope: 'table',
    task: '为这些表的列生成业务术语：把技术列名翻译成业务叫法；能识别的枚举值补上中文 label。',
    payload: 'column（写成 db.schema.table.column）, values([{ value, label }])',
  },
  concept: {
    scope: 'table',
    task: '为这些表生成业务概念：一张核心表通常对应一个概念，写清主键 / 显示列 / 粒度。',
    payload: 'pkey, display, grain',
  },
  rule: {
    scope: 'table',
    task: '根据列名 / 注释 / 枚举提炼业务规则（过滤、隐藏列、禁表、只读）；落不到具体表或列的就别编造。',
    payload: 'mode(filter|hide-column|block-table|read-only), on({ table, column }), predicate',
  },
  metric: {
    scope: 'table',
    task: '从数值 / 时间列提炼业务指标：给可读名称、口径 grain、单位；能为 GraphQL 的给一段查询。',
    payload: 'graphql, grain, unit, window({ column, tz, period })',
  },
  example: {
    scope: 'table',
    task: '为这些表构造自然语言问句样例，并写明它应该碰哪些表 / 列（expect）。',
    payload: 'notes, expect({ tables, columns, values, mustNot })',
  },
  relation: {
    scope: 'relation',
    task: '根据外键生成业务关系：给关系起业务名，写清两端与基数。',
    payload: 'from({ table, column }), to({ table, column }), cardinality(many-to-one|one-to-many|many-to-many|one-to-one), alias',
  },
};

function tableRef(table) {
  return [table.database, table.schema, table.name].filter(Boolean).join('.');
}

/** 一批表 → prompt 里的 schema 片段（只含这一批，避免整库膨胀） */
function renderTableLines(tables) {
  return tables
    .map((table) => {
      const cols = (table.columns ?? [])
        .map((column) => {
          const parts = [`${column.name}:${column.type ?? '?'}`];
          if (column.comment) parts.push(`「${column.comment}」`);
          return parts.join(' ');
        })
        .join('; ');
      return `- 表 ${tableRef(table)}${table.comment ? `（${table.comment}）` : ''}: ${cols}`;
    })
    .join('\n');
}

function renderRelationLines(relationships) {
  return relationships
    .map((rel) => {
      const from = [rel.fromDatabase, rel.fromSchema, rel.fromTable, rel.fromColumn].filter(Boolean).join('.');
      const to = [rel.toDatabase, rel.toSchema, rel.toTable, rel.toColumn].filter(Boolean).join('.');
      return `- 外键 ${from} → ${to}`;
    })
    .join('\n');
}

/**
 * 把 schema 压成给模型的文本摘要。保留原签名，供 lint / 测试复用。
 * @returns {{tableText: string, relText: string}}
 */
function buildSchemaDigest(schema, database) {
  const tables = (schema?.tables ?? []).filter((table) => !database || table.database === database);
  const relationships = (schema?.relationships ?? []).filter((rel) => !database || rel.fromDatabase === database);
  return { tableText: renderTableLines(tables), relText: renderRelationLines(relationships) };
}

/**
 * 一批 schema 片段 → 只问一类的 prompt；要求模型只返回 {"<kind>": [...]}。
 *
 * @param {string} kind
 * @param {string} scopeText 本批的表 / 外键文本
 * @param {string} database
 * @param {string} [scopeLabel] 覆盖「本批表 / 本批外键」的标题（无外键时关系也走表批次）
 */
function buildBatchMessages(kind, scopeText, database, scopeLabel = null) {
  const guide = CATEGORY_GUIDES[kind];
  const dbLabel = database ? `数据库「${database}」` : '当前数据库';
  const label = scopeLabel ?? (guide.scope === 'relation' ? '本批外键' : '本批表');
  const user = `请只生成「${kind}」这一类条目，基于 ${dbLabel} 的这一批 schema。

## 类别
${kind}

## ${label}
${scopeText}

## 输出要求
- 只输出一个 JSON 对象，顶层键就是 "${kind}"，值是数组：{"${kind}": [ ... ]}
- 不要输出解释文字，也不要输出其它类别的键。
- 每条公共字段：name（必填，业务名）、definition（业务含义，尽量具体）、aliases（同义词数组，可空）、tables（相关表，db.schema.table 形式）。
- payload 允许的键严格如下，多写无效：${guide.payload}
- ${guide.task}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 从模型文本里抠出 JSON 对象（容忍 ```json 代码围栏与前后闲话） */
function parseModelJson(text) {
  if (typeof text !== 'string') return {};
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return {};
  }
}

/** 从一批回复里取出该类条目；容忍模型把该类直接给成数组 */
function parseItems(raw, kind) {
  const parsed = parseModelJson(raw);
  return Array.isArray(parsed[kind]) ? parsed[kind] : [];
}

/** 一条原始条目 → 可落库的条目；形状不合规范返回 null（由调用方丢弃） */
function toEntry(raw, kind, database) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim())
    : [];
  const tables = Array.isArray(raw.tables)
    ? raw.tables.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];
  const definition = typeof raw.definition === 'string' ? raw.definition.trim() : '';
  const expression = typeof raw.expression === 'string' ? raw.expression.trim() : '';
  const severityInput = typeof raw.severity === 'string' ? raw.severity : 'info';
  const severity = SEVERITIES.includes(severityInput) ? severityInput : 'info';

  let payload = {};
  try {
    payload = normalizePayload(kind, raw.payload && typeof raw.payload === 'object' ? raw.payload : {});
  } catch (err) {
    // 单条载荷不合规范就丢掉，不让一条坏数据阻塞整批生成
    console.warn(`[ontology-generate] 跳过 ${kind}/${name}：${err.message}`);
    return null;
  }

  return { database, kind, name, aliases, definition, tables, expression, severity, payload };
}

function zeroCounts() {
  return KINDS.reduce((acc, kind) => {
    acc[kind] = 0;
    return acc;
  }, {});
}

function countByKind(entries) {
  const counts = zeroCounts();
  for (const entry of entries) {
    if (counts[entry.kind] != null) counts[entry.kind] += 1;
  }
  return counts;
}

/** 把数组切成固定大小的块 */
function chunk(items, size) {
  const step = Math.max(1, Math.trunc(size) || 1);
  const out = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/** 跨批次去重：同一 kind + name 只留一条；定义取更长的，别名 / 关联表取并集 */
function dedupeEntries(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.kind}\u0000${entry.name}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...entry, aliases: [...entry.aliases], tables: [...entry.tables] });
      continue;
    }
    if ((entry.definition?.length ?? 0) > (prev.definition?.length ?? 0)) prev.definition = entry.definition;
    prev.aliases = [...new Set([...prev.aliases, ...entry.aliases])];
    prev.tables = [...new Set([...prev.tables, ...entry.tables])];
    if (Object.keys(prev.payload ?? {}).length === 0 && Object.keys(entry.payload ?? {}).length > 0) {
      prev.payload = entry.payload;
    }
  }
  return [...byKey.values()];
}

/**
 * 生成入口：按「表批次 / 外键批次」逐类调用模型，失败隔离，最后去重汇总。
 *
 * @param {Object} params
 * @param {Object} params.schema 已解析 schema（tables / relationships）
 * @param {string} [params.database] 目标库；空串表示不限制
 * @param {Object} params.modelConfig 解密后的模型配置
 * @param {string} [params.schemaSource] 来源标记，原样回传
 * @param {Function} [params.chatFn] 注入用，测试可替换
 * @param {number} [params.tablesPerBatch] 每批表数，默认取环境变量 / 12
 * @param {number} [params.relationsPerBatch] 每批外键数，默认取环境变量 / 40
 * @returns {Promise<{generated: boolean, schemaSource: string, counts: Object, entries: Array, batches: Object}>}
 */
async function generateOntology({
  schema,
  database = '',
  modelConfig,
  schemaSource = 'provided',
  chatFn = callChatCompletion,
  tablesPerBatch = TABLES_PER_BATCH,
  relationsPerBatch = RELATIONS_PER_BATCH,
} = {}) {
  const tables = (schema?.tables ?? []).filter((table) => !database || table.database === database);
  const relationships = (schema?.relationships ?? []).filter((rel) => !database || rel.fromDatabase === database);

  if (tables.length === 0) {
    return {
      generated: false,
      schemaSource: 'none',
      counts: zeroCounts(),
      entries: [],
      batches: { total: 0, failed: 0, failures: [] },
    };
  }

  const entries = [];
  const failures = [];
  let total = 0;

  const runBatch = async (kind, scopeText, scopeLabel = null) => {
    total += 1;
    try {
      const raw = await chatFn(modelConfig, buildBatchMessages(kind, scopeText, database, scopeLabel), {
        json: true,
        timeoutMs: GENERATE_TIMEOUT_MS,
      });
      for (const item of parseItems(raw, kind)) {
        const entry = toEntry(item, kind, database);
        if (entry) entries.push(entry);
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      failures.push({ kind, message });
      // 单批失败不阻塞整批：记下来，其余批次继续
      console.warn(`[ontology-generate] ${kind} 批次失败：${message}`);
    }
  };

  // 关系：有外键就按外键分批（准确且不重复）；没有外键才退回按表分批，让模型从 *_id 里猜
  if (relationships.length > 0) {
    for (const batch of chunk(relationships, relationsPerBatch)) {
      await runBatch('relation', renderRelationLines(batch));
    }
  } else {
    for (const batch of chunk(tables, tablesPerBatch)) {
      await runBatch('relation', renderTableLines(batch), '本批表');
    }
  }

  // 其余五类都按表分批
  const tableKinds = KINDS.filter((kind) => CATEGORY_GUIDES[kind]?.scope === 'table');
  for (const kind of tableKinds) {
    for (const batch of chunk(tables, tablesPerBatch)) {
      await runBatch(kind, renderTableLines(batch));
    }
  }

  const deduped = dedupeEntries(entries);
  return {
    generated: true,
    schemaSource,
    counts: countByKind(deduped),
    entries: deduped,
    batches: { total, failed: failures.length, failures },
  };
}

module.exports = {
  generateOntology,
  buildSchemaDigest,
  parseModelJson,
  toEntry,
};
