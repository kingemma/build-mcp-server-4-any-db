'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { McpClient } = require('./mcp-client');
const { discoverSchema } = require('./schema');
const { migrateLegacyRoleTables } = require('./permissions');

/**
 * legacy 项目（`databases:` + `roles[].tables`）到 source 模式的迁移。
 *
 * 为什么必须走配置 API 而不是直接改文本：
 * - `roles[].tables` 是嵌套结构，文本级删除极易改坏；
 * - GraphJin 自己会在写配置时把整份文件格式化回写，文本改动会被覆盖。
 *
 * 实测顺序（.probe/verify-source-migration-flow.js，9 项全过）：
 * 1. remove_roles 删掉带 tables 的角色（一步里「更新再删除」会被校验拒绝）；
 * 2. 单独重建角色（grants 里的角色必须已存在）；
 * 3. 写 sources（GraphJin 同时会把 databases 从文件里清掉）；
 * 4. 兜底删除残留的 databases 顶层块。
 */

/** 从 dev.yml 里移除 `databases:` 顶层块（含其缩进内容）。 */
function removeLegacyDatabasesBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^databases\s*:/.test(line));
  if (start < 0) return text;

  const inline = lines[start].slice(lines[start].indexOf(':') + 1).trim();
  if (inline !== '') {
    throw new Error('dev.yml 的 databases 用了 flow 风格，平台无法安全迁移，请改成块风格后重试');
  }

  let end = start + 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') {
      end = i + 1;
      continue;
    }
    if (/^ */.exec(lines[i])[0].length === 0) break;
    end = i + 1;
  }

  lines.splice(start, end - start);
  return lines.join('\n');
}

/**
 * 解析 legacy `databases:` 块里的连接信息。
 *
 * 配置 API 返回的连接密码是 `[REDACTED]`，所以真实凭据只能从文件里读。
 *
 * @param {string} text dev.yml 内容
 * @returns {Object} { name: { type, host, port, dbname, user, password, path, schema, connection_string, default } }
 */
function readLegacyDatabases(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^databases\s*:/.test(line));
  if (start < 0) return {};

  const inline = lines[start].slice(lines[start].indexOf(':') + 1).trim();
  if (inline !== '') {
    throw new Error('dev.yml 的 databases 用了 flow 风格，平台无法安全迁移，请改成块风格后重试');
  }

  const result = {};
  let entryIndent = null;
  let fieldIndent = null;
  let current = null;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = /^ */.exec(line)[0].length;
    if (indent === 0) break;

    const stripped = line.trim().replace(/\s+#.*$/, '');
    const match = /^("[^"]*"|'[^']*'|[^:\s][^:]*)\s*:\s*(.*)$/.exec(stripped);
    if (!match) continue;

    const key = stripQuotes(match[1]);
    const value = match[2].trim();

    if (entryIndent === null) {
      // 第一个缩进行就是库名
      entryIndent = indent;
      current = key;
      result[current] = {};
      if (value !== '') throw new Error(`dev.yml 的库 ${key} 用了 flow 风格，平台无法安全迁移`);
      continue;
    }

    if (indent === entryIndent) {
      current = key;
      result[current] = {};
      if (value !== '') throw new Error(`dev.yml 的库 ${key} 用了 flow 风格，平台无法安全迁移`);
      continue;
    }

    if (fieldIndent === null) fieldIndent = indent;
    if (indent < fieldIndent) continue;
    if (!current) continue;

    if (value === '') continue;
    result[current][key] = parseScalar(value);
  }

  return result;
}

/**
 * 去掉标量两端引号。
 *
 * @param {string} raw
 * @returns {string}
 */
function stripQuotes(raw) {
  const text = String(raw).trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/**
 * 解析 YAML 标量（只覆盖连接配置会出现的类型）。
 *
 * @param {string} raw
 * @returns {*}
 */
function parseScalar(raw) {
  const text = String(raw).trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return stripQuotes(text);
}

/**
 * 归一化一个操作配置。
 *
 * get_current_config 是 Go 结构体直出：`Block` / `Filters` / `Columns`，
 * 与 update_current_config 要求的 `block` / `filters` / `columns` 不同。
 *
 * @param {Object|null} raw
 * @returns {Object}
 */
function normalizeOperation(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const result = {};
  const block = raw.block ?? raw.Block;
  if (block !== undefined) result.block = block;
  const filters = raw.filters ?? raw.Filters;
  if (Array.isArray(filters) && filters.length > 0) result.filters = filters;
  const columns = raw.columns ?? raw.Columns;
  if (Array.isArray(columns) && columns.length > 0) result.columns = columns;
  return result;
}

/**
 * 归一化角色及其表规则。
 *
 * @param {Object} role
 * @returns {{name: string, tables: Array<Object>}}
 */
function normalizeRole(role) {
  const tables = (role?.tables ?? []).map((table) => ({
    name: table.name ?? table.Name,
    database: table.database ?? table.Database ?? '',
    query: normalizeOperation(table.query ?? table.Query),
    insert: normalizeOperation(table.insert ?? table.Insert),
    update: normalizeOperation(table.update ?? table.Update),
    delete: normalizeOperation(table.delete ?? table.Delete),
  }));
  return { name: role?.name, tables };
}

/**
 * 判断 dev.yml 是否还是 legacy 形态。
 *
 * @param {string} text
 * @returns {boolean}
 */
function isLegacyConfig(text) {
  return /^databases\s*:/m.test(text);
}

/**
 * 把 legacy 项目迁移成 source 模式。
 *
 * 调用前必须有一个跑在 legacy 配置上的实例（迁移要靠配置 API 改写文件）。
 *
 * @param {Object} options
 * @param {string} options.projectDir 项目目录
 * @param {string} options.baseUrl 运行中的 GraphJin 地址
 * @param {string} [options.role] 调用配置 API 的角色，缺省 admin
 * @returns {Promise<Object>} { migrated, backup, conflicts, sources }
 */
async function migrateLegacyProject({ projectDir, baseUrl, role = 'admin' }) {
  const devYaml = path.join(path.resolve(projectDir), 'dev.yml');
  const text = fs.readFileSync(devYaml, 'utf8');
  if (!isLegacyConfig(text)) {
    return { migrated: false, backup: null, conflicts: [], sources: [] };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(path.dirname(devYaml), `dev.yml.legacy-${stamp}.bak`);
  fs.copyFileSync(devYaml, backup);

  try {
    const connections = readLegacyDatabases(text);
    const client = new McpClient({ baseUrl, role });
    await client.connect();

    const config = await client.callTool('get_current_config', { section: 'all' });
    const roles = (Array.isArray(config.roles) ? config.roles : []).map(normalizeRole);
    const defaultDatabase =
      Object.entries(connections).find(([, conn]) => conn.default === true)?.[0] ??
      Object.keys(connections)[0] ??
      null;

    const schema = await discoverSchema(client, { withRelationships: false });
    const columnsByTable = {};
    for (const table of schema.tables ?? []) {
      columnsByTable[table.name] = (table.columns ?? []).map((column) => column.name);
    }

    const conflicts = [];
    const sources = [];
    for (const [name, conn] of Object.entries(connections)) {
      const scopedRoles = roles.map((roleConfig) => ({
        ...roleConfig,
        tables: (roleConfig.tables ?? []).filter(
          // 配置 API 读回的 database 可能是空串，空串必须回落到默认库
          (table) => (table.database || defaultDatabase) === name
        ),
      }));
      const { access, conflicts: roleConflicts } = migrateLegacyRoleTables({
        roles: scopedRoles,
        columnsByTable,
        adminRoles: ['admin'],
      });
      for (const conflict of roleConflicts) {
        conflicts.push({ ...conflict, database: name });
      }

      sources.push({ name, kind: 'database', ...conn, access });
    }

    const roleNames = roles.map((roleConfig) => roleConfig.name).filter(Boolean);
    const removable = roleNames.filter((name) => {
      const roleConfig = roles.find((candidate) => candidate.name === name);
      return name !== 'admin' && (roleConfig?.tables ?? []).length > 0;
    });

    if (removable.length > 0) {
      await client.callTool('update_current_config', { remove_roles: removable });
    }
    await rebuildRoles(client, roleNames);

    const written = await client.callTool('update_current_config', { sources });
    if (written?.success === false) {
      const reason = (written.errors ?? [written.message]).filter(Boolean).join('; ');
      throw new Error(`写入 sources 失败：${reason}`);
    }

    const remaining = fs.readFileSync(devYaml, 'utf8');
    if (isLegacyConfig(remaining)) {
      fs.writeFileSync(devYaml, removeLegacyDatabasesBlock(remaining), 'utf8');
    }

    return { migrated: true, backup, conflicts, sources: sources.map((source) => source.name) };
  } catch (error) {
    // 让 supervisor 能拿到备份路径并在失败时回滚
    error.backup = backup;
    throw error;
  }
}

/**
 * 重建角色（不带 tables）。
 *
 * @param {McpClient} client
 * @param {string[]} roleNames
 * @returns {Promise<void>}
 */
async function rebuildRoles(client, roleNames) {
  const names = [...new Set(['admin', ...roleNames])].filter(Boolean);
  const result = await client.callTool('update_current_config', {
    roles: names.map((name) => ({ name })),
  });
  if (result?.success === false) {
    const reason = (result.errors ?? [result.message]).filter(Boolean).join('; ');
    throw new Error(`重建角色失败：${reason}`);
  }
}

module.exports = {
  isLegacyConfig,
  readLegacyDatabases,
  removeLegacyDatabasesBlock,
  normalizeRole,
  normalizeOperation,
  migrateLegacyProject,
};
