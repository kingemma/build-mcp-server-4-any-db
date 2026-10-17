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

module.exports = { renderDevYaml, renderDatabase, createProject };
