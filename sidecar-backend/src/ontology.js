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
 * 四类条目共用一张表：形状足够接近（名称 / 别名 / 定义 / 关联表），拆四张表只会让
 * CRUD 与导出多写四遍。
 */

const { DatabaseSync } = require('node:sqlite');

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ontology_kind ON ontology(kind, database);
`;

/** 条目归属的库。同一个词在不同库可以有不同的含义，所以它是主键的一部分 */
const DATABASE_FIELD = 'database';

/** 业务概念：实体及其含义，可跨多张表 */
const KIND_CONCEPT = 'concept';
/** 术语：口语 / 黑话与 schema 的映射，最轻的一层 */
const KIND_TERM = 'term';
/** 业务规则：不变量与状态机，决定 AI 该不该做某个操作 */
const KIND_RULE = 'rule';
/** 指标：命名聚合，统一口径 */
const KIND_METRIC = 'metric';

const KINDS = [KIND_CONCEPT, KIND_TERM, KIND_RULE, KIND_METRIC];

/** 规则强度：info 只是说明，enforce 是硬约束 */
const SEVERITIES = ['info', 'warn', 'enforce'];

/** 渲染顺序：先建立词汇，再讲实体，然后是约束，最后是口径 */
const RENDER_ORDER = [KIND_TERM, KIND_CONCEPT, KIND_RULE, KIND_METRIC];

const KIND_TITLES = {
  [KIND_TERM]: '术语表',
  [KIND_CONCEPT]: '业务概念',
  [KIND_RULE]: '业务规则',
  [KIND_METRIC]: '指标口径',
};

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

class OntologyStore {
  /**
   * @param {string} dbPath SQLite 文件路径
   */
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** 给老表补 database 列：本体论按库归属是后加的，升级不能丢已有条目 */
  #migrate() {
    const existing = new Set(
      this.db.prepare('PRAGMA table_info(ontology)').all().map((column) => column.name)
    );
    if (!existing.has(DATABASE_FIELD)) {
      this.db.exec(`ALTER TABLE ontology ADD COLUMN ${DATABASE_FIELD} TEXT NOT NULL DEFAULT ''`);
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

    const columns = [
      cleanDatabase,
      cleanKind,
      cleanName,
      JSON.stringify(parseList(aliases)),
      cleanDefinition,
      JSON.stringify(parseList(tables)),
      cleanExpression,
      severity,
    ];
    const now = new Date().toISOString();

    if (Number.isInteger(id)) {
      const updated = this.db
        .prepare(
          `UPDATE ontology SET database = ?, kind = ?, name = ?, aliases = ?, definition = ?,
           tables = ?, expression = ?, severity = ?, updated_at = ? WHERE id = ?`
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
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const entries = this.list({ kind, database });
    if (entries.length === 0) return '';

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
          return `- ${mark}**${head}**${tail} — ${body}${detail}`;
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
      '同一个词在这里有确定含义，指标有确定口径，约束标了强度。',
      '表结构与关系请用 query_catalog，这里不重复。',
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
};
