'use strict';

const fs = require('node:fs');

/**
 * 数据库类型与连接模板。
 *
 * 白名单是实测得来的：喂一个不存在的 type，GraphJin 会回
 * `unsupported database type "zzz": supported types are postgres, mysql, ...`
 * （见 docs/graphjin-3.21.14-baseline.md §12.1）。
 * 不在白名单里的名字一定会被拒，所以 TiDB / CockroachDB 这类只能以
 * postgres / mysql 协议接入，平台侧用「别名模板」承载这个映射。
 */

/** 配置层接受的类型；driverVerified 为 false 的是白名单通过但连接层未实现 */
const SUPPORTED_TYPES = [
  'postgres',
  'mysql',
  'mariadb',
  'sqlite',
  'oracle',
  'mongodb',
  'mssql',
  'snowflake',
  'bigquery',
  'redshift',
  'nanodb',
  'cassandra',
  'clickhouse',
];

/** 实测连接层报 unsupported database type 的类型（基线 §12.2） */
const UNVERIFIED_DRIVERS = new Set(['clickhouse', 'redshift', 'bigquery', 'nanodb', 'cassandra']);

const FIELD_MODE = 'fields';
const PATH_MODE = 'path';
const DSN_MODE = 'dsn';

const BUILT_IN_TYPES = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    wireType: 'postgres',
    mode: FIELD_MODE,
    defaultPort: 5432,
    dsnExample: 'postgres://user:pass@127.0.0.1:5432/db?sslmode=disable',
    driverVerified: true,
    note: 'CockroachDB / TiDB 等兼容库用这个协议接入',
  },
  {
    id: 'mysql',
    label: 'MySQL',
    wireType: 'mysql',
    mode: FIELD_MODE,
    defaultPort: 3306,
    dsnExample: 'user:pass@tcp(127.0.0.1:3306)/db',
    driverVerified: true,
    note: 'TiDB / OceanBase 的 MySQL 兼容模式用这个协议接入',
  },
  {
    id: 'mariadb',
    label: 'MariaDB',
    wireType: 'mariadb',
    mode: FIELD_MODE,
    defaultPort: 3306,
    dsnExample: 'user:pass@tcp(127.0.0.1:3306)/db',
    driverVerified: true,
  },
  {
    id: 'sqlite',
    label: 'SQLite',
    wireType: 'sqlite',
    mode: PATH_MODE,
    defaultPort: null,
    dsnExample: 'file:app.db',
    driverVerified: true,
    note: '必须给 path 或 connection_string，否则报 requires a connection string or path',
  },
  {
    id: 'oracle',
    label: 'Oracle',
    wireType: 'oracle',
    mode: FIELD_MODE,
    defaultPort: 1521,
    dsnExample: 'oracle://user:pass@127.0.0.1:1521/service',
    driverVerified: true,
  },
  {
    id: 'mongodb',
    label: 'MongoDB',
    wireType: 'mongodb',
    mode: FIELD_MODE,
    defaultPort: 27017,
    dsnExample: 'mongodb://user:pass@127.0.0.1:27017/db',
    driverVerified: true,
  },
  {
    id: 'mssql',
    label: 'SQL Server',
    wireType: 'mssql',
    mode: FIELD_MODE,
    defaultPort: 1433,
    dsnExample: 'sqlserver://user:pass@127.0.0.1:1433?database=db',
    driverVerified: true,
    note: '类型名必须写 mssql，写 sqlserver 会被拒',
  },
  {
    id: 'snowflake',
    label: 'Snowflake',
    wireType: 'snowflake',
    mode: DSN_MODE,
    defaultPort: null,
    dsnExample: 'user:pass@account/db',
    driverVerified: true,
    note: '必须给 connection_string，否则报 snowflake requires connection_string',
  },
  {
    id: 'bigquery',
    label: 'BigQuery',
    wireType: 'bigquery',
    mode: DSN_MODE,
    defaultPort: null,
    dsnExample: 'bigquery://project/dataset',
    driverVerified: false,
  },
  {
    id: 'redshift',
    label: 'Redshift',
    wireType: 'redshift',
    mode: FIELD_MODE,
    defaultPort: 5439,
    dsnExample: 'postgres://user:pass@host:5439/db',
    driverVerified: false,
  },
  {
    id: 'nanodb',
    label: 'NanoDB',
    wireType: 'nanodb',
    mode: FIELD_MODE,
    defaultPort: null,
    dsnExample: '',
    driverVerified: false,
  },
  {
    id: 'cassandra',
    label: 'Cassandra',
    wireType: 'cassandra',
    mode: FIELD_MODE,
    defaultPort: 9042,
    dsnExample: '',
    driverVerified: false,
  },
  {
    id: 'clickhouse',
    label: 'ClickHouse',
    wireType: 'clickhouse',
    mode: FIELD_MODE,
    defaultPort: 9000,
    dsnExample: 'clickhouse://127.0.0.1:9000/db',
    driverVerified: false,
  },
];

const { dataDir, dataFile } = require('./paths');

/** 模板校验不通过 */
class DbTemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DbTemplateError';
  }
}

function readTemplates() {
  const file = dataFile('db-templates.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeTemplates(templates) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(dataFile('db-templates.json'), `${JSON.stringify(templates, null, 2)}\n`, 'utf8');
}

/**
 * 内置类型（含自定义模板）。
 *
 * @returns {Array<Object>}
 */
function listTypes() {
  return [...BUILT_IN_TYPES, ...readTemplates()];
}

/**
 * 新增一个别名模板。
 *
 * @param {Object} input
 * @param {string} input.id 英文标识，会作为下拉的 value
 * @param {string} input.label 显示名
 * @param {string} input.wireType 真实写进 dev.yml 的 type，必须在白名单内
 * @param {number} [input.defaultPort]
 * @param {string} [input.note]
 * @returns {Array<Object>} 保存后的全部模板
 */
function addTemplate(input) {
  const id = String(input?.id ?? '').trim();
  const label = String(input?.label ?? '').trim();
  const wireType = String(input?.wireType ?? '').trim();
  const mode = input?.mode ?? FIELD_MODE;

  if (!id) throw new DbTemplateError('模板标识不能为空');
  if (!label) throw new DbTemplateError('模板名称不能为空');
  if (!SUPPORTED_TYPES.includes(wireType)) {
    throw new DbTemplateError(
      `wireType 必须是白名单内的类型：${SUPPORTED_TYPES.join(', ')}`
    );
  }
  if (![FIELD_MODE, PATH_MODE, DSN_MODE].includes(mode)) {
    throw new DbTemplateError('mode 只能是 fields / path / dsn');
  }
  if (BUILT_IN_TYPES.some((item) => item.id === id)) {
    throw new DbTemplateError(`标识 ${id} 与内置类型冲突`);
  }

  const templates = readTemplates();
  const index = templates.findIndex((item) => item.id === id);
  const template = {
    id,
    label,
    wireType,
    mode,
    defaultPort: Number.isInteger(input?.defaultPort) ? input.defaultPort : null,
    dsnExample: input?.dsnExample ?? '',
    driverVerified: !UNVERIFIED_DRIVERS.has(wireType),
    note: input?.note ?? `自定义模板，实际以 ${wireType} 协议接入`,
    custom: true,
  };
  if (index >= 0) templates[index] = template;
  else templates.push(template);

  writeTemplates(templates);
  return templates;
}

/**
 * 删除一个自定义模板。内置类型不可删。
 *
 * @param {string} id
 * @returns {Array<Object>} 删除后的全部模板
 */
function removeTemplate(id) {
  const templates = readTemplates().filter((item) => item.id !== id);
  writeTemplates(templates);
  return templates;
}

module.exports = {
  BUILT_IN_TYPES,
  SUPPORTED_TYPES,
  UNVERIFIED_DRIVERS,
  FIELD_MODE,
  PATH_MODE,
  DSN_MODE,
  DbTemplateError,
  listTypes,
  addTemplate,
  removeTemplate,
};
