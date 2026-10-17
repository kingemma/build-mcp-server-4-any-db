'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 生成 GraphJin 项目配置（方案 B 形态）。
 *
 * 只输出 `databases:` map —— 实测两条硬约束：
 * - 配置 `sources` 后 `roles[].tables` 会被拒；
 * - 单数 `database:` 会让服务端在 update_current_config 时 panic 退出。
 */

const DEV_YAML_TEMPLATE = `app_name: {appName}
mode: dev
host_port: 0.0.0.0:{port}
web_ui: {webUi}
log_level: "info"
production: false
default_block: false
secret_key: {secretKey}

identity:
  role_claims: ["roles"]
  admin_roles: ["admin"]

auth:
  type: none
  development: true

mcp:
  allow_config_updates: true
  allow_dev_tools: true

system:
  root_access:
    gj_config: admin
  capabilities:
    catalog.read: true
    config.read: true
    config.write: true
    dev_tools.read: true
    security.read: true

artifacts:
  auto_init: true
  globals_path: ./config
  poll_seconds: 15
  schema: _graphjin

databases:
{databases}
`;

/**
 * 把一个数据库连接渲染成 YAML 片段。
 *
 * @param {string} name 库名，会写入 RoleTable.database
 * @param {Object} conn 连接信息
 * @returns {string} YAML 片段
 */
function renderDatabase(name, conn) {
  const lines = [`  ${name}:`];
  const keys = [
    'type',
    'host',
    'port',
    'dbname',
    'user',
    'password',
    'path',
    'schema',
    'connection_string',
  ];
  for (const key of keys) {
    const value = conn[key];
    if (value === undefined || value === null || value === '') continue;
    lines.push(`    ${key}: ${typeof value === 'number' ? value : JSON.stringify(String(value))}`);
  }
  if (conn.default === true) lines.push('    default: true');
  return lines.join('\n');
}

/**
 * 渲染 dev.yml 全文。
 *
 * @param {Object} options
 * @param {string} options.appName 应用名
 * @param {number} options.port 监听端口
 * @param {Object} options.databases 库名 → 连接信息
 * @param {boolean} [options.webUi] 是否开启内置控制台
 * @param {string} [options.secretKey] 本地开发用的密钥
 * @returns {string} dev.yml 内容
 */
function renderDevYaml({ appName, port, databases, webUi = false, secretKey = 'local-dev-secret' }) {
  if (!appName) throw new Error('appName 不能为空');
  if (!Number.isInteger(port) || port <= 0) throw new Error('port 必须是正整数');
  if (!databases || Object.keys(databases).length === 0) {
    throw new Error('databases 不能为空：方案 B 要求至少配置一个库');
  }

  const rendered = Object.entries(databases)
    .map(([name, conn]) => renderDatabase(name, conn))
    .join('\n');

  return DEV_YAML_TEMPLATE.replace('{appName}', appName)
    .replace('{port}', String(port))
    .replace('{webUi}', String(webUi))
    .replace('{secretKey}', secretKey)
    .replace('{databases}', rendered);
}

/**
 * 在目标目录写出 dev.yml。
 *
 * @param {Object} options 同 renderDevYaml，另需 dir
 * @param {string} options.dir 项目目录
 * @returns {string} 写出的 dev.yml 路径
 */
function createProject({ dir, ...options }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'dev.yml');
  fs.writeFileSync(file, renderDevYaml(options), 'utf8');
  return file;
}

/**
 * 把一批连接合并进已有的 dev.yml。
 *
 * GraphJin 执行 update_current_config 后会把配置写回 dev.yml（roles 等都在里面），
 * 所以启动时不能整份重渲染 —— 那会冲掉权限。这里只改 `databases:` 块，其余内容
 * 逐字保留。
 *
 * @param {string} text dev.yml 内容
 * @param {Object} databases 库名 → 连接信息
 * @returns {string} 合并后的内容
 */
function mergeDatabaseBlock(text, databases) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^databases:\s*$/.test(line));
  if (start < 0) throw new Error('dev.yml 缺少 databases 段，无法合并连接');

  // 块 = databases: 之后连续的缩进行；空行不算结束，碰到下一个顶层键才停
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    if (!/^\s/.test(lines[i])) break;
    end = i + 1;
  }

  const entries = [];
  let current = null;
  for (let i = start + 1; i < end; i += 1) {
    const header = /^ {2}([^\s:#][^:]*):\s*$/.exec(lines[i]);
    if (header) {
      current = { name: header[1], lines: [lines[i]] };
      entries.push(current);
    } else if (current) {
      current.lines.push(lines[i]);
    }
  }

  const provided = Object.entries(databases ?? {});
  const defaultName = provided.find(([, conn]) => conn?.default === true)?.[0] ?? null;

  for (const [name, conn] of provided) {
    const rendered = renderDatabase(name, conn).split('\n');
    const existing = entries.find((entry) => entry.name === name);
    if (existing) existing.lines = rendered;
    else entries.push({ name, lines: rendered });
  }

  // GraphJin 只允许一个默认库：新设为 default 时把其它条目的 default 去掉
  if (defaultName) {
    for (const entry of entries) {
      if (entry.name === defaultName) continue;
      entry.lines = entry.lines.filter((line) => !/^\s+default:\s*true\s*$/.test(line));
    }
  }

  const block = entries.flatMap((entry) => entry.lines);
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n');
}

/**
 * 就地合并 dev.yml 里的 databases 段。
 *
 * @param {string} file dev.yml 路径
 * @param {Object} databases 库名 → 连接信息
 * @returns {string} 同一个路径
 */
function mergeProjectDatabases(file, databases) {
  if (!databases || Object.keys(databases).length === 0) return file;
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, mergeDatabaseBlock(text, databases), 'utf8');
  return file;
}

module.exports = {
  renderDevYaml,
  renderDatabase,
  createProject,
  mergeDatabaseBlock,
  mergeProjectDatabases,
};
