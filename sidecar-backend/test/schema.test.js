'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  discoverSchema,
  listTables,
  fetchCatalogCards,
  normalizeTable,
  normalizeColumn,
  normalizeRelationship,
  parseJsonField,
} = require('../src/schema');

function tableCard(name, columns) {
  return {
    id: `table:app:main.${name}`,
    kind: 'table',
    database_name: 'app',
    schema_name: 'main',
    table_name: name,
    evidence_json: JSON.stringify({
      DatabaseName: 'app', SchemaName: 'main', TableName: name,
      PrimaryKey: 'id', ColumnCount: columns.length,
    }),
    details_json: JSON.stringify([
      {
        section: 'key_columns',
        data_json: JSON.stringify({
          columns: columns.map((column, index) => ({
            DatabaseName: 'app', SchemaName: 'main', TableName: name,
            ColumnName: column.name, Type: column.type, Ordinal: column.ordinal ?? index,
            PrimaryKey: column.name === 'id', NotNull: column.name === 'id',
            UniqueKey: column.name === 'id', Indexed: false,
            Comment: column.comment ?? '',
          })),
        }),
      },
    ]),
  };
}

function relationshipCard(from, to) {
  return {
    id: `relationship:app:main.${from}.account_id->app:main.${to}.id`,
    kind: 'relationship',
    database_name: 'app',
    schema_name: 'main',
    table_name: from,
    column_name: 'account_id',
    source: 'foreign_key',
    evidence_json: JSON.stringify({
      FromDatabaseName: 'app', FromSchemaName: 'main', FromTableName: from, FromColumnName: 'account_id',
      ToDatabaseName: 'app', ToSchemaName: 'main', ToTableName: to, ToColumnName: 'id',
      RelType: 'one_to_many', IsCrossDatabase: false, Source: 'foreign_key',
    }),
  };
}

function stubClient(handler) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return handler(name, args);
    },
  };
}

const ACCOUNTS = tableCard('accounts', [
  { name: 'id', type: 'integer' },
  { name: 'name', type: 'text' },
]);
const USERS = tableCard('users', [{ name: 'id', type: 'integer' }]);

test('parseJsonField：对象直传、字符串解析、失败回落', () => {
  assert.deepStrictEqual(parseJsonField({ a: 1 }), { a: 1 });
  assert.deepStrictEqual(parseJsonField('{"a":1}'), { a: 1 });
  assert.strictEqual(parseJsonField('not json', 'x'), 'x');
  assert.strictEqual(parseJsonField(null, 'x'), 'x');
});

test('normalizeColumn：保留列注释，其余字段按需归一化', () => {
  const column = normalizeColumn({
    DatabaseName: 'app', SchemaName: 'main', TableName: 'accounts', ColumnName: 'id',
    Type: 'integer', NotNull: true, PrimaryKey: true, UniqueKey: true, Indexed: false, Ordinal: 0,
    Comment: '入库时间',
  });
  assert.deepStrictEqual(column, {
    database: 'app', schema: 'main', table: 'accounts', name: 'id',
    type: 'integer', comment: '入库时间',
    notNull: true, primaryKey: true, unique: true, indexed: false, ordinal: 0,
  });
});

test('normalizeColumn：没有注释时给空串，不塞 null', () => {
  // 注释是「库里已有的业务语境」：本体论可以据此起草，Schema 页也才说得清这列是什么
  assert.strictEqual(normalizeColumn({ ColumnName: 'x' }).comment, '');
  assert.strictEqual(normalizeColumn({ ColumnName: 'x', Comment: null }).comment, '');
});

test('normalizeTable：列注释从 details_json 一路带到列上', () => {
  const table = normalizeTable(
    tableCard('accounts', [{ name: 'id', type: 'integer', comment: '账号主键' }])
  );
  assert.strictEqual(table.columns[0].comment, '账号主键');
});

test('normalizeTable：从 details_json 提取列并按 ordinal 排序', () => {
  // 故意打乱顺序，验证会按 ordinal 重排
  const card = tableCard('accounts', [
    { name: 'name', type: 'text', ordinal: 1 },
    { name: 'id', type: 'integer', ordinal: 0 },
  ]);
  const table = normalizeTable(card);
  assert.strictEqual(table.name, 'accounts');
  assert.strictEqual(table.primaryKey, 'id');
  assert.deepStrictEqual(table.columns.map((c) => c.name), ['id', 'name']);
  assert.strictEqual(table.columns[0].primaryKey, true);
});

test('normalizeTable：details_json 缺失时列为空但不报错', () => {
  const table = normalizeTable({ table_name: 'x', database_name: 'app', evidence_json: '{}' });
  assert.deepStrictEqual(table.columns, []);
  assert.strictEqual(table.columnCount, 0);
});

test('normalizeRelationship：解析 From/To 与关系类型', () => {
  const rel = normalizeRelationship(relationshipCard('invoices', 'accounts'));
  assert.strictEqual(rel.fromTable, 'invoices');
  assert.strictEqual(rel.fromColumn, 'account_id');
  assert.strictEqual(rel.toTable, 'accounts');
  assert.strictEqual(rel.toColumn, 'id');
  assert.strictEqual(rel.relType, 'one_to_many');
  assert.strictEqual(rel.crossDatabase, false);
});

test('fetchCatalogCards：truncated 为 true 时继续翻页', async () => {
  const client = stubClient(async (_name, args) => {
    const offset = args.offset;
    if (offset === 0) return { revision: 'r1', cards: [ACCOUNTS], truncated: true };
    return { revision: 'r1', cards: [USERS], truncated: false };
  });

  const result = await fetchCatalogCards(client, { kind: 'table', pageSize: 1 });
  assert.strictEqual(result.cards.length, 2);
  assert.strictEqual(result.truncated, false);
  assert.deepStrictEqual(client.calls.map((c) => c.args.offset), [0, 1]);
  assert.deepStrictEqual(client.calls[0].args.where, { kind: { eq: 'table' } });
});

test('fetchCatalogCards：带 database 时在 where 里追加过滤', async () => {
  const client = stubClient(async () => ({ cards: [], truncated: false }));
  await fetchCatalogCards(client, { kind: 'column', database: 'app' });
  assert.deepStrictEqual(client.calls[0].args.where, {
    kind: { eq: 'column' }, database_name: { eq: 'app' },
  });
});

test('fetchCatalogCards：空页立即停止，不会空转', async () => {
  const client = stubClient(async () => ({ cards: [], truncated: true }));
  const result = await fetchCatalogCards(client, { kind: 'table' });
  assert.strictEqual(client.calls.length, 1);
  assert.strictEqual(result.cards.length, 0);
});

test('discoverSchema：表、列、关系一次拿全', async () => {
  const client = stubClient(async (_name, args) => {
    const kind = args.where.kind.eq;
    if (kind === 'table') return { revision: 'r1', cards: [ACCOUNTS], truncated: false };
    if (kind === 'relationship') return { cards: [relationshipCard('users', 'accounts')], truncated: false };
    return { cards: [], truncated: false };
  });

  const schema = await discoverSchema(client);
  assert.strictEqual(schema.revision, 'r1');
  assert.strictEqual(schema.tables.length, 1);
  assert.strictEqual(schema.tables[0].name, 'accounts');
  assert.deepStrictEqual(schema.tables[0].columns.map((c) => c.name), ['id', 'name']);
  assert.strictEqual(schema.relationships.length, 1);
  assert.strictEqual(schema.relationships[0].fromTable, 'users');
});

test('discoverSchema：withColumns 为 false 时清空列', async () => {
  const client = stubClient(async (_name, args) => {
    if (args.where.kind.eq === 'table') return { cards: [ACCOUNTS], truncated: false };
    return { cards: [], truncated: false };
  });

  const schema = await discoverSchema(client, { withColumns: false, withRelationships: false });
  assert.deepStrictEqual(schema.tables[0].columns, []);
  assert.deepStrictEqual(schema.relationships, []);
});

test('discoverSchema：表卡片没有列时退回按 column 查询', async () => {
  const bare = { table_name: 'accounts', database_name: 'app', schema_name: 'main', evidence_json: '{}' };
  const client = stubClient(async (_name, args) => {
    if (args.where.kind.eq === 'table') return { cards: [bare], truncated: false };
    if (args.where.kind.eq === 'column') {
      return {
        cards: [{
          evidence_json: JSON.stringify({
            DatabaseName: 'app', SchemaName: 'main', TableName: 'accounts',
            ColumnName: 'name', Type: 'text', Ordinal: 1,
          }),
        }],
        truncated: false,
      };
    }
    return { cards: [], truncated: false };
  });

  const schema = await discoverSchema(client);
  assert.deepStrictEqual(schema.tables[0].columns.map((c) => c.name), ['name']);
  assert.strictEqual(schema.tables[0].columnCount, 1);
});

test('listTables：只返回表清单且有序', async () => {
  const client = stubClient(async () => ({ cards: [USERS, ACCOUNTS], truncated: false }));
  const tables = await listTables(client);
  assert.deepStrictEqual(tables.map((t) => t.name), ['accounts', 'users']);
  assert.ok(!('columns' in tables[0]));
});
