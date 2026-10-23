'use strict';

/**
 * Schema 发现：把 GraphJin 的 `query_catalog` 卡片转换成平台内部的结构化模型。
 *
 * 实测的卡片形态（v3.21.14）：
 * - table：evidence_json 给主键与列数，details_json 里有一段 data_json.columns 含完整列定义
 * - column：evidence_json 含 Type / NotNull / PrimaryKey / UniqueKey / Indexed / Ordinal
 * - relationship：evidence_json 含 From/To 两端的库表列与 RelType、IsCrossDatabase
 * - 返回体带 truncated，需要按 offset 翻页，单次 limit 上限 500
 */

const KIND_TABLE = 'table';
const KIND_COLUMN = 'column';
const KIND_RELATIONSHIP = 'relationship';

const DEFAULT_PAGE_SIZE = 200;
// 防御性上限：catalog 很大时不至于无限翻页
const MAX_PAGES = 25;

/** JSON 字段可能是字符串也可能是对象，统一解析；失败则返回兜底值 */
function parseJsonField(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * 翻页取回某一类 catalog 卡片。
 *
 * @param {Object} client 具备 callTool 的 MCP 客户端
 * @param {Object} options
 * @param {string} options.kind table / column / relationship
 * @param {string} [options.database] 只取某个库
 * @param {number} [options.pageSize]
 * @returns {Promise<{cards: Array<Object>, revision: string|null, truncated: boolean}>}
 */
async function fetchCatalogCards(client, { kind, database = null, pageSize = DEFAULT_PAGE_SIZE }) {
  const cards = [];
  let revision = null;
  let offset = 0;
  let truncated = true;

  for (let page = 0; page < MAX_PAGES && truncated; page += 1) {
    const where = { kind: { eq: kind } };
    if (database) where.database_name = { eq: database };

    const result = await client.callTool('query_catalog', {
      where,
      limit: pageSize,
      offset,
    });

    revision = result?.revision ?? revision;
    const batch = result?.cards ?? [];
    cards.push(...batch);
    truncated = result?.truncated === true;
    offset += pageSize;
    // 服务端也可能返回空页，避免空转
    if (batch.length === 0) break;
  }

  return { cards, revision, truncated };
}

/**
 * 从 table 卡片的 details_json 里提取列定义。
 *
 * @param {Object} card table 卡片
 * @returns {Array<Object>} 原始列对象，提取不到时为空数组
 */
function extractRawColumns(card) {
  const sections = parseJsonField(card.details_json, []);
  if (!Array.isArray(sections)) return [];

  for (const section of sections) {
    const data = parseJsonField(section?.data_json, null);
    if (data && Array.isArray(data.columns)) return data.columns;
  }
  return [];
}

/**
 * @param {Object} raw catalog 里的列对象（来自 details_json 或 column 卡片的 evidence）
 * @returns {Object} 规范化列
 */
function normalizeColumn(raw) {
  return {
    database: raw.DatabaseName ?? raw.database_name ?? null,
    schema: raw.SchemaName ?? raw.schema_name ?? null,
    table: raw.TableName ?? raw.table_name ?? null,
    name: raw.ColumnName ?? raw.column_name ?? null,
    type: raw.Type ?? null,
    // 注释是「库里已有的业务语境」：本体论可以据此起草，Schema 页也才说得清这列是什么。
    // catalog 的 column 卡片与 details_json.columns 都带 Comment，之前丢掉了。
    comment: raw.Comment ?? '',
    notNull: raw.NotNull === true,
    primaryKey: raw.PrimaryKey === true,
    unique: raw.UniqueKey === true,
    indexed: raw.Indexed === true,
    ordinal: Number.isInteger(raw.Ordinal) ? raw.Ordinal : null,
  };
}

/**
 * @param {Object} card catalog 的 table 卡片
 * @returns {Object} 规范化表
 */
function normalizeTable(card) {
  const evidence = parseJsonField(card.evidence_json, {});
  const columns = extractRawColumns(card).map(normalizeColumn);
  columns.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

  return {
    database: card.database_name ?? evidence.DatabaseName ?? null,
    schema: card.schema_name ?? evidence.SchemaName ?? null,
    name: card.table_name ?? evidence.TableName ?? null,
    primaryKey: evidence.PrimaryKey ?? null,
    columnCount: evidence.ColumnCount ?? columns.length,
    comment: evidence.Comment ?? '',
    columns,
  };
}

/**
 * @param {Object} card catalog 的 relationship 卡片
 * @returns {Object} 规范化关系
 */
function normalizeRelationship(card) {
  const evidence = parseJsonField(card.evidence_json, {});
  return {
    fromDatabase: evidence.FromDatabaseName ?? card.database_name ?? null,
    fromSchema: evidence.FromSchemaName ?? null,
    fromTable: evidence.FromTableName ?? card.table_name ?? null,
    fromColumn: evidence.FromColumnName ?? card.column_name ?? null,
    toDatabase: evidence.ToDatabaseName ?? null,
    toSchema: evidence.ToSchemaName ?? null,
    toTable: evidence.ToTableName ?? null,
    toColumn: evidence.ToColumnName ?? null,
    relType: evidence.RelType ?? null,
    crossDatabase: evidence.IsCrossDatabase === true,
    source: evidence.Source ?? card.source ?? null,
  };
}

/**
 * 发现完整 Schema。
 *
 * @param {Object} client 具备 callTool 的 MCP 客户端
 * @param {Object} [options]
 * @param {string} [options.database] 限定库名
 * @param {boolean} [options.withColumns] 默认 true
 * @param {boolean} [options.withRelationships] 默认 true
 * @returns {Promise<{revision: string|null, tables: Array<Object>, relationships: Array<Object>}>}
 */
async function discoverSchema(client, {
  database = null,
  withColumns = true,
  withRelationships = true,
} = {}) {
  const tableResult = await fetchCatalogCards(client, { kind: KIND_TABLE, database });
  let tables = tableResult.cards.map(normalizeTable);

  // details_json 里没有列时，退回按 column 单独取一次并按表归组
  if (withColumns) {
    const missing = tables.filter((table) => table.columns.length === 0);
    if (missing.length > 0) {
      const columnResult = await fetchCatalogCards(client, { kind: KIND_COLUMN, database });
      const byTable = new Map();
      for (const card of columnResult.cards) {
        const column = normalizeColumn(parseJsonField(card.evidence_json, {}));
        const key = `${column.database}::${column.schema}::${column.table}`;
        if (!byTable.has(key)) byTable.set(key, []);
        byTable.get(key).push(column);
      }
      tables = tables.map((table) => {
        const key = `${table.database}::${table.schema}::${table.name}`;
        const found = byTable.get(key);
        if (!found) return table;
        found.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
        return { ...table, columns: found, columnCount: found.length };
      });
    }
  } else {
    tables = tables.map((table) => ({ ...table, columns: [] }));
  }

  let relationships = [];
  if (withRelationships) {
    const relResult = await fetchCatalogCards(client, { kind: KIND_RELATIONSHIP, database });
    relationships = relResult.cards.map(normalizeRelationship);
  }

  tables.sort((a, b) => `${a.database}${a.name}`.localeCompare(`${b.database}${b.name}`));
  return { revision: tableResult.revision, tables, relationships };
}

/**
 * 只要表清单（不带列），用于权限矩阵的表选择器。
 *
 * @param {Object} client
 * @param {Object} [options]
 * @returns {Promise<Array<{database: string, schema: string, name: string, primaryKey: string|null}>>}
 */
async function listTables(client, { database = null } = {}) {
  const result = await fetchCatalogCards(client, { kind: KIND_TABLE, database });
  return result.cards
    .map((card) => {
      const evidence = parseJsonField(card.evidence_json, {});
      return {
        database: card.database_name ?? evidence.DatabaseName ?? null,
        schema: card.schema_name ?? evidence.SchemaName ?? null,
        name: card.table_name ?? evidence.TableName ?? null,
        primaryKey: evidence.PrimaryKey ?? null,
      };
    })
    .sort((a, b) => `${a.database}${a.name}`.localeCompare(`${b.database}${b.name}`));
}

module.exports = {
  KIND_TABLE,
  KIND_COLUMN,
  KIND_RELATIONSHIP,
  discoverSchema,
  listTables,
  fetchCatalogCards,
  normalizeTable,
  normalizeColumn,
  normalizeRelationship,
  parseJsonField,
};
