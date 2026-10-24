'use strict';

/**
 * 「哪些角色可以访问哪个库」的本地存储。
 *
 * 为什么单独一张表而不是从 grants 推断：source 模式下「没有 grant」不等于「拒绝」
 * （实测：外来角色能读全表），所以必须显式记下「这个库配过角色清单」这件事本身，
 * 否则无法区分「没配过（不限制）」与「配过但只允许 admin」。
 *
 * `admin` 永远隐式允许，不落表——写进去反而会让人以为要手动维护。
 */

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS database_access (
  database TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (database, role)
);
CREATE TABLE IF NOT EXISTS database_access_config (
  database TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL
);
`;

class DatabaseAccessStore {
  /**
   * @param {string} dbPath SQLite 文件路径，传 ':memory:' 可建内存库
   */
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  /**
   * 某库允许的角色清单。
   *
   * @param {string} database
   * @returns {string[]|null} null 表示这个库从没配过（调用方按「不限制」处理）
   */
  rolesFor(database) {
    const configured = this.db
      .prepare('SELECT 1 AS ok FROM database_access_config WHERE database = ?')
      .get(database);
    if (!configured) return null;
    return this.db
      .prepare('SELECT role FROM database_access WHERE database = ? ORDER BY role')
      .all(database)
      .map((row) => row.role);
  }

  /**
   * 覆写某库的角色清单。传空数组表示「只允许 admin」——与「没配过」是两种状态。
   *
   * @param {string} database
   * @param {string[]} roles
   * @returns {string[]} 写进去的角色（去重、去掉 admin 与空值）
   */
  setRoles(database, roles) {
    if (typeof database !== 'string' || database === '') {
      throw new Error('database 不能为空');
    }
    if (!Array.isArray(roles)) throw new Error('roles 必须是字符串数组');

    const cleaned = [...new Set(roles.map((role) => String(role).trim()))].filter(
      (role) => role !== '' && role !== 'admin'
    );

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM database_access WHERE database = ?').run(database);
      const insert = this.db.prepare('INSERT INTO database_access (database, role) VALUES (?, ?)');
      for (const role of cleaned) insert.run(database, role);
      this.db
        .prepare(
          `INSERT INTO database_access_config (database, updated_at) VALUES (?, ?)
           ON CONFLICT(database) DO UPDATE SET updated_at = excluded.updated_at`
        )
        .run(database, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return cleaned;
  }

  /** 关掉底层连接；进程退出与测试清理时用，避免 Windows 上文件被占住 */
  close() {
    this.db.close();
  }

  /**
   * 全部配置，供权限页一次取回。
   *
   * @returns {{ access: Object, configured: string[] }} access 形如 { finance: [role] }
   */
  list() {
    const configured = this.db
      .prepare('SELECT database FROM database_access_config ORDER BY database')
      .all()
      .map((row) => row.database);
    const access = {};
    for (const database of configured) access[database] = this.rolesFor(database) ?? [];
    return { access, configured };
  }
}

module.exports = { DatabaseAccessStore };
