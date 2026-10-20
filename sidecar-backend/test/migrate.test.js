'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isLegacyConfig,
  readLegacyDatabases,
  removeLegacyDatabasesBlock,
  normalizeRole,
} = require('../src/migrate');

const LEGACY = `app_name: Demo
host_port: 127.0.0.1:8080
roles:
  - name: admin
databases:
  app:
    type: sqlite
    path: "app.db"
    default: true
  analytics:
    type: postgres
    host: 127.0.0.1
    port: 5432
    dbname: analytics
    user: reader
    password: "p@ss:word"
`;

test('isLegacyConfig: 只有 databases 段算 legacy', () => {
  assert.strictEqual(isLegacyConfig(LEGACY), true);
  assert.strictEqual(isLegacyConfig('sources:\n  - name: app\n'), false);
});

test('readLegacyDatabases: 解析出连接字段（含真实密码）', () => {
  const parsed = readLegacyDatabases(LEGACY);
  assert.deepStrictEqual(parsed.app, { type: 'sqlite', path: 'app.db', default: true });
  assert.strictEqual(parsed.analytics.host, '127.0.0.1');
  assert.strictEqual(parsed.analytics.port, 5432);
  // 配置 API 会把密码脱敏，迁移只能从文件里拿
  assert.strictEqual(parsed.analytics.password, 'p@ss:word');
});

test('readLegacyDatabases: 兼容 4 空格缩进与引号键', () => {
  const yaml = `databases:
    "app":
        type: sqlite
        path: app.db
`;
  assert.deepStrictEqual(readLegacyDatabases(yaml), { app: { type: 'sqlite', path: 'app.db' } });
});

test('readLegacyDatabases: flow 风格直接拒绝', () => {
  assert.throws(() => readLegacyDatabases('databases: { app: { type: sqlite } }\n'), /flow 风格/);
});

test('removeLegacyDatabasesBlock: 只删 databases 块，其余逐字保留', () => {
  const output = removeLegacyDatabasesBlock(LEGACY);
  assert.doesNotMatch(output, /^databases:/m);
  assert.match(output, /^roles:$/m);
  assert.match(output, /app_name: Demo/);
  // databases 之后的兄弟段不能被连带删掉
  assert.ok(output.trimEnd().endsWith('- name: admin'));
});

test('removeLegacyDatabasesBlock: 没有 databases 段时原样返回', () => {
  const text = 'sources:\n  - name: app\n';
  assert.strictEqual(removeLegacyDatabasesBlock(text), text);
});

test('normalizeRole: 把 Go 结构体的 PascalCase 表规则折成小写', () => {
  const role = normalizeRole({
    name: 'analyst',
    tables: [
      {
        Name: 'orders',
        database: 'app',
        Query: { Block: false, Filters: ['{ a: 1 }'], Columns: ['id'] },
        Insert: { Block: true },
        Update: null,
        Delete: { Block: true },
      },
    ],
  });

  assert.deepStrictEqual(role, {
    name: 'analyst',
    tables: [
      {
        name: 'orders',
        database: 'app',
        query: { block: false, filters: ['{ a: 1 }'], columns: ['id'] },
        insert: { block: true },
        update: {},
        delete: { block: true },
      },
    ],
  });
});

test('normalizeRole: database 为空串时保留空串（由调用方回落到默认库）', () => {
  const role = normalizeRole({ name: 'r', tables: [{ Name: 't', database: '' }] });
  assert.strictEqual(role.tables[0].database, '');
});
