'use strict';

const { DatabaseSync } = require('node:sqlite');

/**
 * 用户 / 组织管理，本地 SQLite 存储。
 *
 * 这里的 role 直接就是 GraphJin 的角色名 —— 方案 B 下权限规则挂在
 * `roles[].tables[]` 上，所以平台里的角色必须与 GraphJin 的角色一一对应，
 * 由 syncRolesToGraphJin 负责把本地出现过的角色补进 GraphJin 配置。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
`;

/** 参数缺失或取值不合法 */
class UserStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserStoreError';
  }
}

class UserStore {
  /**
   * @param {string} dbPath SQLite 文件路径，传 ':memory:' 可建内存库
   */
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  static #now() {
    return new Date().toISOString();
  }

  #requireText(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new UserStoreError(`${field} 不能为空`);
    }
    return value.trim();
  }

  /** @returns {{id: number, name: string, created_at: string}} */
  createOrganization(name) {
    const clean = this.#requireText(name, '组织名');
    const statement = this.db.prepare(
      'INSERT INTO organizations (name, created_at) VALUES (?, ?) RETURNING id, name, created_at'
    );
    try {
      return statement.get(clean, UserStore.#now());
    } catch (error) {
      throw new UserStoreError(`创建组织失败：${error.message}`);
    }
  }

  /** @returns {Array<Object>} */
  listOrganizations() {
    return this.db.prepare('SELECT id, name, created_at FROM organizations ORDER BY id').all();
  }

  /**
   * 删除组织。
   *
   * 组织下有成员时拒绝：外键是 ON DELETE CASCADE，直接删会连带丢掉成员记录，
   * 这种不可逆的连带删除不该藏在一次点击后面。
   *
   * @param {number} organizationId
   * @returns {{deleted: boolean, members: number}}
   */
  deleteOrganization(organizationId) {
    if (!Number.isInteger(organizationId)) throw new UserStoreError('organizationId 必须是整数');
    const { count } = this.db
      .prepare('SELECT COUNT(*) AS count FROM users WHERE organization_id = ?')
      .get(organizationId);
    if (count > 0) throw new UserStoreError(`组织下还有 ${count} 个成员，请先删除成员`);

    const result = this.db.prepare('DELETE FROM organizations WHERE id = ?').run(organizationId);
    return { deleted: result.changes > 0, members: count };
  }

  /**
   * @param {Object} input
   * @param {number} input.organizationId
   * @param {string} input.name
   * @param {string} input.email
   * @param {string} input.role GraphJin 角色名
   */
  createUser({ organizationId, name, email, role }) {
    if (!Number.isInteger(organizationId)) throw new UserStoreError('organizationId 必须是整数');
    const cleanName = this.#requireText(name, '用户名');
    const cleanEmail = this.#requireText(email, '邮箱');
    const cleanRole = this.#requireText(role, '角色');

    const statement = this.db.prepare(
      `INSERT INTO users (organization_id, name, email, role, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id, organization_id, name, email, role, created_at`
    );
    try {
      return statement.get(organizationId, cleanName, cleanEmail, cleanRole, UserStore.#now());
    } catch (error) {
      throw new UserStoreError(`创建用户失败：${error.message}`);
    }
  }

  /** @param {number} [organizationId] 不传则列出全部 */
  listUsers(organizationId = null) {
    if (organizationId === null) {
      return this.db
        .prepare('SELECT id, organization_id, name, email, role, created_at FROM users ORDER BY id')
        .all();
    }
    return this.db
      .prepare(
        'SELECT id, organization_id, name, email, role, created_at FROM users WHERE organization_id = ? ORDER BY id'
      )
      .all(organizationId);
  }

  findUserByEmail(email) {
    return (
      this.db
        .prepare('SELECT id, organization_id, name, email, role, created_at FROM users WHERE email = ?')
        .get(email) ?? null
    );
  }

  /** @returns {boolean} 是否真的更新了 */
  setUserRole(userId, role) {
    if (!Number.isInteger(userId)) throw new UserStoreError('userId 必须是整数');
    const cleanRole = this.#requireText(role, '角色');
    const result = this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(cleanRole, userId);
    return result.changes > 0;
  }

  /**
   * 改成员资料。角色单独走 setUserRole，避免一次误操作同时改两件正交的事。
   *
   * @param {number} userId
   * @param {{name?: string, email?: string}} input
   * @returns {Object|null} 更新后的行；用户不存在时 null
   */
  updateUser(userId, { name, email } = {}) {
    if (!Number.isInteger(userId)) throw new UserStoreError('userId 必须是整数');
    const cleanName = this.#requireText(name, '用户名');
    const cleanEmail = this.#requireText(email, '邮箱');

    try {
      return (
        this.db
          .prepare(
            `UPDATE users SET name = ?, email = ? WHERE id = ?
             RETURNING id, organization_id, name, email, role, created_at`
          )
          .get(cleanName, cleanEmail, userId) ?? null
      );
    } catch (error) {
      throw new UserStoreError(`更新用户失败：${error.message}`);
    }
  }

  /** @returns {boolean} */
  deleteUser(userId) {
    if (!Number.isInteger(userId)) throw new UserStoreError('userId 必须是整数');
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return result.changes > 0;
  }

  /** 平台里出现过的全部角色名，用于与 GraphJin 对齐 @returns {string[]} */
  listRoles() {
    const rows = this.db.prepare('SELECT DISTINCT role FROM users ORDER BY role').all();
    return rows.map((row) => row.role);
  }
}

/**
 * 把本地出现过的角色补齐到 GraphJin 配置里。
 *
 * 方案 B 下角色必须先存在，否则 roles[].tables 规则会被拒。
 *
 * @param {Object} options
 * @param {UserStore} options.store
 * @param {import('./graphjin').GraphJinService} options.service
 * @param {string[]} [options.roleNames] 显式指定要对齐的角色；缺省取库里出现过的角色
 * @returns {Promise<{created: string[], existing: string[]}>}
 */
async function syncRolesToGraphJin({ store, service, roleNames = null }) {
  const localRoles = roleNames ?? store.listRoles();
  if (localRoles.length === 0) return { created: [], existing: [] };

  const config = await service.readConfig('roles');
  const existing = new Set((config.roles ?? []).map((role) => role.name));
  const missing = localRoles.filter((role) => !existing.has(role));
  if (missing.length === 0) return { created: [], existing: localRoles };

  await service.applyConfig({ roles: missing.map((name) => ({ name })) });
  return { created: missing, existing: localRoles.filter((role) => existing.has(role)) };
}

module.exports = { UserStore, UserStoreError, syncRolesToGraphJin };
