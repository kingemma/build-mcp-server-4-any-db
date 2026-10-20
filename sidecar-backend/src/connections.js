'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureKeystoreKey } = require('./keystore');

/**
 * 本地连接记录。
 *
 * 测试通过 / 启动成功的库连接落到本地 SQLite，连接页和 Schema 页都从这里取数。
 * payload 整段加密：里面含 password / connection_string，明文写入等于把数据库
 * 凭据摊在磁盘上。密钥复用 GraphJin 的 keystore key（base64 的 32 字节），
 * 与 GraphJin 自己加密 secret 用的是同一把。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  app_name TEXT NOT NULL,
  wire_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  dbname TEXT,
  user TEXT,
  db_path TEXT,
  schema_name TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  has_secret INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name, project_dir)
);
CREATE INDEX IF NOT EXISTS idx_connections_project ON connections(project_dir);
`;

/**
 * 摘要字段明文落列。
 *
 * payload 换 key 后解不开，但这些字段不是秘密；独立成列后列表仍然能显示
 * 目标与「需重新录入」，不至于整行变成空白。
 */
const SUMMARY_COLUMNS = [
  ['host', 'TEXT'],
  ['port', 'INTEGER'],
  ['dbname', 'TEXT'],
  ['user', 'TEXT'],
  ['db_path', 'TEXT'],
  ['schema_name', 'TEXT'],
  ['is_default', 'INTEGER NOT NULL DEFAULT 0'],
  ['has_secret', 'INTEGER NOT NULL DEFAULT 0'],
];

/** 测试通过 */
const STATUS_VERIFIED = 'verified';
/** 启动成功 */
const STATUS_CONNECTED = 'connected';

const ORIGIN_TEST = 'test';
const ORIGIN_START = 'start';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const PAYLOAD_VERSION = 'v1';

/** 连接记录参数不合法 */
class ConnectionStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnectionStoreError';
  }
}

/**
 * 按字段形态判断录入方式，供 UI 回填表单。
 *
 * @param {Object} config dev.yml 里的单库连接配置
 * @returns {'fields'|'path'|'dsn'}
 */
function detectMode(config) {
  if (config?.connection_string) return 'dsn';
  if (config?.path) return 'path';
  return 'fields';
}

function decodeKey(base64) {
  const key = Buffer.from(String(base64), 'base64');
  if (key.length !== 32) {
    throw new ConnectionStoreError('keystore key 必须是 base64 编码的 32 字节');
  }
  return key;
}

/**
 * @param {Buffer} key 32 字节密钥
 * @param {Object} value 待加密的连接配置
 * @returns {string} v1:iv:tag:ciphertext（各段 base64）
 */
function seal(key, value) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    PAYLOAD_VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * 解密失败返回 null：换过 keystore key 或记录被截断时，只降级这一行，
 * 不让整个列表接口挂掉。
 *
 * @param {Buffer} key
 * @param {string} payload
 * @returns {Object|null}
 */
function unseal(key, payload) {
  try {
    const [version, iv, tag, data] = String(payload).split(':');
    if (version !== PAYLOAD_VERSION) return null;
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return null;
  }
}

class ConnectionStore {
  /**
   * @param {string} dbPath SQLite 文件路径，传 ':memory:' 可建内存库
   * @param {Object} [options]
   * @param {string} [options.secretKey] 覆盖 keystore key（测试用），base64 的 32 字节
   */
  constructor(dbPath, { secretKey = null } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.#migrate();
    this.key = decodeKey(secretKey ?? ensureKeystoreKey());
  }

  close() {
    this.db.close();
  }

  static #now() {
    return new Date().toISOString();
  }

  #requireText(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConnectionStoreError(`${field} 不能为空`);
    }
    return value.trim();
  }

  /** 给已有表补摘要列：老版本只建了 payload，直接 SELECT 新列会报错 */
  #migrate() {
    const existing = new Set(
      this.db.prepare('PRAGMA table_info(connections)').all().map((column) => column.name)
    );
    for (const [name, type] of SUMMARY_COLUMNS) {
      if (existing.has(name)) continue;
      this.db.exec(`ALTER TABLE connections ADD COLUMN ${name} ${type}`);
    }
  }

  /** 从配置里抽出可明文的摘要字段 */
  #describe(config) {
    return {
      host: typeof config.host === 'string' ? config.host : null,
      port: Number.isInteger(config.port) ? config.port : null,
      dbname: typeof config.dbname === 'string' ? config.dbname : null,
      user: typeof config.user === 'string' ? config.user : null,
      dbPath: typeof config.path === 'string' ? config.path : null,
      schemaName: typeof config.schema === 'string' ? config.schema : null,
      isDefault: config.default === true ? 1 : 0,
      hasSecret: config.password || config.connection_string ? 1 : 0,
    };
  }

  /** 列表与详情共用的摘要，永远不带出密码字段 */
  #summarize(row, readable) {
    return {
      id: row.id,
      name: row.name,
      projectDir: row.project_dir,
      appName: row.app_name,
      wireType: row.wire_type,
      mode: row.mode,
      status: row.status,
      origin: row.origin,
      /** false 表示 payload 解不开，UI 应提示重新录入 */
      readable,
      /**
       * 是否由当前运行实例加载。这里恒为 false：存储层看不到进程状态，
       * connections.list 会在出口按运行态覆盖成真实值。
       */
      active: false,
      host: row.host ?? null,
      port: row.port ?? null,
      dbname: row.dbname ?? null,
      user: row.user ?? null,
      path: row.db_path ?? null,
      schema: row.schema_name ?? null,
      isDefault: row.is_default === 1,
      hasSecret: row.has_secret === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 保存或更新一条连接。同一 name + project_dir 视为同一条记录。
   *
   * project_dir 统一转绝对路径：表单里填的是相对路径，启动后
   * supervisor.status() 回的是绝对路径，不归一化会存成两条。
   *
   * @param {Object} input
   * @param {string} input.name dev.yml 里的库名
   * @param {string} input.projectDir 项目目录
   * @param {Object} input.config 该库的连接配置
   * @param {string} [input.appName]
   * @param {string} [input.status] verified / connected
   * @param {string} [input.origin] test / start
   * @returns {Object} 保存后的记录（含解密后的 config）
   */
  save({
    name,
    projectDir,
    config,
    appName = 'MCP Builder',
    status = STATUS_VERIFIED,
    origin = ORIGIN_TEST,
  }) {
    const cleanName = this.#requireText(name, '连接名');
    const cleanProject = path.resolve(this.#requireText(projectDir, '项目目录'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new ConnectionStoreError('连接配置必须是对象');
    }
    const wireType = this.#requireText(config.type, '连接类型');
    if (![STATUS_VERIFIED, STATUS_CONNECTED].includes(status)) {
      throw new ConnectionStoreError(`status 只能是 ${STATUS_VERIFIED} / ${STATUS_CONNECTED}`);
    }
    if (![ORIGIN_TEST, ORIGIN_START].includes(origin)) {
      throw new ConnectionStoreError(`origin 只能是 ${ORIGIN_TEST} / ${ORIGIN_START}`);
    }

    const summary = this.#describe(config);
    const now = ConnectionStore.#now();
    const statement = this.db.prepare(
      `INSERT INTO connections
         (name, project_dir, app_name, wire_type, mode, status, origin,
          host, port, dbname, user, db_path, schema_name, is_default, has_secret,
          payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, project_dir) DO UPDATE SET
         app_name = excluded.app_name,
         wire_type = excluded.wire_type,
         mode = excluded.mode,
         status = excluded.status,
         origin = excluded.origin,
         host = excluded.host,
         port = excluded.port,
         dbname = excluded.dbname,
         user = excluded.user,
         db_path = excluded.db_path,
         schema_name = excluded.schema_name,
         is_default = excluded.is_default,
         has_secret = excluded.has_secret,
         payload = excluded.payload,
         updated_at = excluded.updated_at
       RETURNING id`
    );
    const row = statement.get(
      cleanName,
      cleanProject,
      appName,
      wireType,
      detectMode(config),
      status,
      origin,
      summary.host,
      summary.port,
      summary.dbname,
      summary.user,
      summary.dbPath,
      summary.schemaName,
      summary.isDefault,
      summary.hasSecret,
      seal(this.key, config),
      now,
      now
    );
    return this.get(row.id);
  }

  /** @returns {Array<Object>} 按最近更新排序，不含 config / 密码 */
  list() {
    return this.db
      .prepare('SELECT * FROM connections ORDER BY updated_at DESC, id DESC')
      .all()
      .map((row) => this.#summarize(row, unseal(this.key, row.payload) !== null));
  }

  /**
   * @param {number} id
   * @returns {Object|null} 含解密后的 config，供「填入表单 / 直接启动」使用
   */
  get(id) {
    if (!Number.isInteger(id)) throw new ConnectionStoreError('id 必须是整数');
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
    if (!row) return null;
    const config = unseal(this.key, row.payload);
    return { ...this.#summarize(row, config !== null), config };
  }

  /** @returns {boolean} 是否真的删除了 */
  remove(id) {
    if (!Number.isInteger(id)) throw new ConnectionStoreError('id 必须是整数');
    return this.db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
  }
}

module.exports = {
  ConnectionStore,
  ConnectionStoreError,
  STATUS_VERIFIED,
  STATUS_CONNECTED,
  ORIGIN_TEST,
  ORIGIN_START,
  detectMode,
};
