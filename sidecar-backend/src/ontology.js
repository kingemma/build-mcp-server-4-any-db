'use strict';

/**
 * 业务本体论：人类维护的领域知识，供 MCP 客户端在查询之前建立业务语境。
 *
 * 为什么需要它：Schema 只描述「怎么连表」，不描述「这是什么生意」。AI 缺的从来不是
 * 查询能力，而是新同事入职几天才能摸清的五样东西 —— 术语表、概念、关系语义、
 * 业务规则、命名指标。实测 GraphJin 3.21.14 承载不了这些（config 的
 * tables[].description 写入成功却被静默丢弃，query_catalog 只检索 schema 名），
 * 所以由平台自己存，并经 MCP 网关注入给客户端。
 *
 * 各类条目共用一张表：形状足够接近（名称 / 别名 / 定义 / 关联表 + 一份按类别校验的
 * payload），拆四张表只会让 CRUD 与导出多写四遍。
 */

const { DatabaseSync } = require('node:sqlite');

const { normalizePayload, normalizeFacets } = require('./ontology-payload');
const { MAX_BODY_CHARS } = require('./ontology-catalog');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ontology (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  definition TEXT NOT NULL DEFAULT '',
  tables TEXT NOT NULL DEFAULT '[]',
  expression TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info',
  payload TEXT NOT NULL DEFAULT '{}',
  facets TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ontology_kind ON ontology(kind, database);
`;

/** 条目归属的库。同一个词在不同库可以有不同的含义，所以它是主键的一部分 */
const DATABASE_FIELD = 'database';

/**
 * 后加的列：升级时逐列补，补完不丢老条目。
 *
 * 用列表而不是一串 if：下一次加列只改这里，迁移逻辑不需要再动一遍
 * （历史教训是 database 那一次写成了 if，加第二列时就得重写整个方法）。
 */
const COLUMN_MIGRATIONS = [
  { name: DATABASE_FIELD, ddl: "TEXT NOT NULL DEFAULT ''" },
  { name: 'payload', ddl: "TEXT NOT NULL DEFAULT '{}'" },
  { name: 'facets', ddl: "TEXT NOT NULL DEFAULT '[]'" },
];

/** 业务概念：实体及其含义，可跨多张表 */
const KIND_CONCEPT = 'concept';
/** 术语：口语 / 黑话与 schema 的映射，最轻的一层 */
const KIND_TERM = 'term';
/** 业务规则：不变量与状态机，决定 AI 该不该做某个操作 */
const KIND_RULE = 'rule';
/** 指标：命名聚合，统一口径 */
const KIND_METRIC = 'metric';
/**
 * 关系：一条外键在业务里叫什么、从哪端看。
 *
 * 单独一类而不是挂在概念上，因为「同一张表有三条外键」是最常见的歧义源：
 * 只说「这个概念碰这些表」帮不上忙，必须说清是哪一条边、方向是什么。
 */
const KIND_RELATION = 'relation';
/**
 * 样例问答：一个问题 → 一段验证过的查询。
 *
 * 既是少样本，也是评测集（同一份数据两个用途）；同时也是「指标口径」之外
 * 唯一能表达「这个问题跨这几张表、这么连」的地方。
 */
const KIND_EXAMPLE = 'example';

const KINDS = [
  KIND_CONCEPT,
  KIND_TERM,
  KIND_RULE,
  KIND_METRIC,
  KIND_RELATION,
  KIND_EXAMPLE,
];

/** 规则强度：info 只是说明，enforce 是硬约束 */
const SEVERITIES = ['info', 'warn', 'enforce'];

/** 渲染顺序：先建立词汇，再讲实体，然后是关系与约束，最后是口径与例子 */
const RENDER_ORDER = [KIND_TERM, KIND_CONCEPT, KIND_RELATION, KIND_RULE, KIND_METRIC, KIND_EXAMPLE];

const KIND_TITLES = {
  [KIND_TERM]: '术语表',
  [KIND_CONCEPT]: '业务概念',
  [KIND_RELATION]: '关系',
  [KIND_RULE]: '业务规则',
  [KIND_METRIC]: '指标口径',
  [KIND_EXAMPLE]: '样例问答',
};

/**
 * 正文截断：超过上限就断开并标注。
 *
 * 静默截断比不截断更糟——维护者会以为写进去的都送达了。所以标记必须显眼，
 * 同时 lint 有对应的 `entry-too-long` 提醒拆分。
 *
 * @param {string} text
 * @returns {string}
 */
function truncateBody(text) {
  const clean = typeof text === 'string' ? text : '';
  if (clean.length <= MAX_BODY_CHARS) return clean;
  return `${clean.slice(0, MAX_BODY_CHARS)}…（已截断，建议拆成多条）`;
}

/**
 * 把结构化载荷压成一句人话，接在条目正文后面。
 *
 * 为什么挤在同一个 `·` 串里而不是每个字段一行：这段文本会进 instructions，
 * 一行一个字段会让 20 条指标吃掉上千 token。用分隔符连起来，模型照样读得懂，
 * 人也一眼扫得完——信息一点不少，行数少一个数量级。
 *
 * @param {Object} entry
 * @returns {string[]} 若干「键=值」片段；没有扩展字段时为空数组
 */
function payloadFacts(entry) {
  const payload = entry.payload ?? {};
  const facts = [];

  if (entry.kind === KIND_RELATION) {
    const end = (side) =>
      side?.table ? `${side.table}${side.column ? `.${side.column}` : ''}` : '?';
    // 两端一个都没填时，不再单独渲染基数/关系名：那是草稿，写成「— many-to-one」只会让人困惑
    if (payload.from || payload.to) {
      facts.push(`${end(payload.from)} → ${end(payload.to)}`);
      if (payload.cardinality) facts.push(payload.cardinality);
      if (payload.alias) facts.push(`关系名=${payload.alias}`);
    }
  }

  if (entry.kind === KIND_RULE) {
    // 形态与判据都要露出来：模型看到「这条规则会拦」，才会真的收手
    if (payload.mode) facts.push(`形态=${payload.mode}`);
    if (payload.on?.table) {
      facts.push(`表=${payload.on.table}${payload.on.column ? `.${payload.on.column}` : ''}`);
    }
    if (payload.predicate) facts.push(`判定=${payload.predicate}`);
  }

  if (entry.kind === KIND_METRIC) {
    if (payload.grain) facts.push(`粒度=${payload.grain}`);
    if (payload.unit) facts.push(`单位=${payload.unit}`);
    if (payload.window?.column) facts.push(`窗口=${payload.window.column}`);
    // 可执行片段单独给出：只写伪代码时模型只能猜语法，给了片段它就能照抄
    if (payload.graphql) facts.push(`查询=${payload.graphql}`);
  }

  if (entry.kind === KIND_TERM && Array.isArray(payload.values) && payload.values.length > 0) {
    const values = payload.values
      .map((item) => (item.label ? `${item.value}(${item.label})` : item.value))
      .join(' / ');
    facts.push(`值域：${values}`);
  }

  if (entry.kind === KIND_CONCEPT) {
    if (payload.pkey) facts.push(`主键=${payload.pkey}`);
    if (payload.display) facts.push(`显示列=${payload.display}`);
    if (payload.grain) facts.push(`粒度=${payload.grain}`);
  }

  if (Array.isArray(entry.facets) && entry.facets.length > 0) {
    facts.push(entry.facets.map((facet) => `${facet.key}=${facet.value}`).join('，'));
  }

  return facts;
}

class OntologyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OntologyError';
  }
}

/**
 * @param {*} value
 * @returns {string[]} 永远返回字符串数组，脏数据按空数组处理
 */
function parseList(value) {
  const source = Array.isArray(value) ? value : safeJson(value);
  return source.filter((item) => typeof item === 'string' && item.trim() !== '');
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 解析对象型 JSON 列（payload）。脏数据降级成空对象：
 * 一条坏行不该让整份业务语境挂掉。
 */
function safeObject(value) {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

class OntologyStore {
  /**
   * @param {string} dbPath SQLite 文件路径
   */
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** 给老表补后加的列：本体论的能力是一层层长出来的，升级不能丢已有条目 */
  #migrate() {
    const existing = new Set(
      this.db.prepare('PRAGMA table_info(ontology)').all().map((column) => column.name)
    );
    for (const column of COLUMN_MIGRATIONS) {
      if (existing.has(column.name)) continue;
      this.db.exec(`ALTER TABLE ontology ADD COLUMN ${column.name} ${column.ddl}`);
    }
  }

  close() {
    this.db.close();
  }

  #requireText(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new OntologyError(`${field} 不能为空`);
    }
    return value.trim();
  }

  /**
   * @param {Object} [filter]
   * @param {string} [filter.kind] 只看某一类
   * @param {string} [filter.database] 只看某个库
   * @returns {Array<Object>} 条目；脏 JSON 列降级成空数组，不让整份列表挂掉
   */
  list({ kind = null, database = null } = {}) {
    const clauses = [];
    const values = [];
    if (kind && KINDS.includes(kind)) {
      clauses.push('kind = ?');
      values.push(kind);
    }
    // 空串是「还没归属到库」的老条目：显式传空串才看得到，不传就默认排除
    if (typeof database === 'string') {
      clauses.push('database = ?');
      values.push(database);
    } else if (database === null) {
      clauses.push("database <> ''");
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM ontology${where} ORDER BY database, id`)
      .all(...values)
      .map((row) => this.#shape(row));
  }

  /**
   * @param {number} id
   * @returns {Object|null}
   */
  get(id) {
    if (!Number.isInteger(id)) throw new OntologyError('id 必须是整数');
    const row = this.db.prepare('SELECT * FROM ontology WHERE id = ?').get(id);
    return row ? this.#shape(row) : null;
  }

  /**
   * 新增或更新一条。同库 + 同类 + 同名视为同一条，避免同一个概念存两遍。
   *
   * @param {Object} input
   * @returns {Object} 保存后的条目
   */
  save(input) {
    const {
      id = null,
      database,
      kind,
      name,
      aliases = [],
      definition = '',
      tables = [],
      expression = '',
      severity = 'info',
      payload = {},
      facets = [],
    } = input ?? {};

    const cleanDatabase = this.#requireText(database, '数据库');
    const cleanKind = this.#requireText(kind, 'kind');
    if (!KINDS.includes(cleanKind)) {
      throw new OntologyError(`kind 只能是 ${KINDS.join(' / ')}`);
    }
    const cleanName = this.#requireText(name, '名称');
    if (!SEVERITIES.includes(severity)) {
      throw new OntologyError(`severity 只能是 ${SEVERITIES.join(' / ')}`);
    }
    const cleanDefinition = typeof definition === 'string' ? definition.trim() : '';
    const cleanExpression = typeof expression === 'string' ? expression.trim() : '';
    // 规则没有说明也没有约束，等于什么都没说
    if (cleanKind === KIND_RULE && !cleanDefinition && !cleanExpression) {
      throw new OntologyError('规则至少要填说明或约束表达式');
    }

    // 形状错误在这里变成 OntologyError：调用方只需要认识一种错误类型。
    // 语义错误（关系两端对不上、指标引用的列不存在）留给 ontology-lint——
    // 那需要 schema，而 save 拿不到，硬查会堵死「schema 没加载时先记下来」。
    let cleanPayload;
    let cleanFacets;
    try {
      cleanPayload = normalizePayload(cleanKind, payload);
      cleanFacets = normalizeFacets(facets);
    } catch (error) {
      throw new OntologyError(error.message);
    }

    const columns = [
      cleanDatabase,
      cleanKind,
      cleanName,
      JSON.stringify(parseList(aliases)),
      cleanDefinition,
      JSON.stringify(parseList(tables)),
      cleanExpression,
      severity,
      JSON.stringify(cleanPayload),
      JSON.stringify(cleanFacets),
    ];
    const now = new Date().toISOString();

    if (Number.isInteger(id)) {
      const updated = this.db
        .prepare(
          `UPDATE ontology SET database = ?, kind = ?, name = ?, aliases = ?, definition = ?,
           tables = ?, expression = ?, severity = ?, payload = ?, facets = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(...columns, now, id);
      if (updated.changes === 0) throw new OntologyError(`条目 ${id} 不存在`);
      return this.get(id);
    }

    const existing = this.db
      .prepare('SELECT id FROM ontology WHERE database = ? AND kind = ? AND name = ?')
      .get(cleanDatabase, cleanKind, cleanName);
    if (existing) {
      return this.save({ ...input, id: existing.id });
    }

    const row = this.db
      .prepare(
        `INSERT INTO ontology
           (database, kind, name, aliases, definition, tables, expression, severity,
            payload, facets, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .get(...columns, now, now);
    return this.get(row.id);
  }

  /**
   * @param {number} id
   * @returns {boolean} 是否真的删掉了
   */
  remove(id) {
    if (!Number.isInteger(id)) throw new OntologyError('id 必须是整数');
    return this.db.prepare('DELETE FROM ontology WHERE id = ?').run(id).changes > 0;
  }

  #shape(row) {
    return {
      id: row.id,
      database: row.database,
      kind: row.kind,
      name: row.name,
      aliases: parseList(row.aliases),
      definition: row.definition,
      tables: parseList(row.tables),
      expression: row.expression,
      severity: row.severity,
      payload: safeObject(row.payload),
      facets: safeJson(row.facets),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 渲染成给 AI 读的业务语境文档。
   *
   * 按库分组：每个库有自己的本体论，AI 查哪个库就看哪一节。只有一个库时省掉库标题，
   * 少一层噪音。表名 / 列名 / 外键一概不展开（那些 query_catalog 会给），
   * 这里只写语义、别名、口径与约束。
   *
   * @param {Object} [filter]
   * @param {string} [filter.kind] 只渲染某一类
   * @param {string} [filter.database] 只渲染某个库
   * @returns {string} markdown 文本；没有条目时返回空串，网关据此不注入
   */
  render({ kind = null, database = null } = {}) {
    if (kind && !KINDS.includes(kind)) {
      throw new OntologyError(`kind 只能是 ${KINDS.join(' / ')}`);
    }
    return this.renderEntries(this.list({ kind, database }));
  }

  /**
   * 渲染任意一组条目。
   *
   * 检索结果与对象画像复用它：页面预览、按需检索、单个对象这三处如果各写一套排版，
   * 模型在不同调用里看到的同一条目就会长得不一样。
   *
   * @param {Array<Object>} entries
   * @returns {string} markdown；空数组返回空串
   */
  renderEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';

    const groups = [...new Set(entries.map((entry) => entry.database))];
    // 单库时直接用二级标题放类别，不为一个库名多包一层
    const groupHeading = groups.length > 1;

    const blocks = groups.map((group) => {
      const scoped = entries.filter((entry) => entry.database === group);
      const sections = RENDER_ORDER.map((item) => {
        const items = scoped.filter((entry) => entry.kind === item);
        if (items.length === 0) return null;
        const lines = items.map((entry) => {
          const head =
            entry.aliases.length > 0 ? `${entry.name}（${entry.aliases.join('、')}）` : entry.name;
          const tail = entry.tables.length > 0 ? ` [${entry.tables.join(', ')}]` : '';
          const body = entry.definition || entry.expression;
          const detail = entry.expression && entry.definition ? `：${entry.expression}` : '';
          const mark = item === KIND_RULE ? `[${entry.severity}] ` : '';
          const facts = payloadFacts(entry);
          const bodyText = truncateBody(
            [body ? `${body}${detail}` : '', facts.join(' · ')]
              .filter((part) => part !== '')
              .join(' · ')
          );
          const line = `- ${mark}**${head}**${tail}`;
          return bodyText === '' ? line : `${line} — ${bodyText}`;
        });
        return `${groupHeading ? '### ' : '## '}${KIND_TITLES[item]}\n${lines.join('\n')}`;
      }).filter(Boolean);
      if (sections.length === 0) return null;
      return groupHeading ? `## 数据库 ${group}\n${sections.join('\n')}` : sections.join('\n');
    }).filter(Boolean);

    return [
      '# 业务本体论',
      '',
      '以下是人类维护的领域知识，按数据库分组，先读对应库那一节再决定怎么查数据：',
      '同一个词在这里有确定含义，关系标了业务叫法与两端，指标有确定口径，约束标了强度与范围，样例给了问法。',
      '表结构与完整的连接关系用 query_catalog；这里只给业务含义，不重复结构。',
      '',
      ...blocks,
    ].join('\n');
  }

  /** @returns {Array<string>} 已维护本体论的库名 */
  databases() {
    return [
      ...new Set(
        this.db
          .prepare("SELECT DISTINCT database FROM ontology WHERE database <> '' ORDER BY database")
          .all()
          .map((row) => row.database)
      ),
    ];
  }
}

module.exports = {
  OntologyStore,
  OntologyError,
  KINDS,
  SEVERITIES,
  KIND_CONCEPT,
  KIND_TERM,
  KIND_RULE,
  KIND_METRIC,
  KIND_RELATION,
  KIND_EXAMPLE,
};
