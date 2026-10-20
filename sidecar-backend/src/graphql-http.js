'use strict';

/**
 * 走 HTTP GraphQL 端点执行查询，可携带用户级身份。
 *
 * 为什么不用 MCP 的 `execute_graphql`：实测（scripts/verify-identity.js）MCP 转发时
 * 会丢掉自定义请求头，`header_variables` 拿不到 `X-User-Code`，行过滤退化成 0 行。
 * 数据查询必须走 `/api/v1/graphql`，MCP 只负责配置类操作。
 */

const GRAPHQL_PATH = '/api/v1/graphql';

/**
 * @param {string} baseUrl GraphJin 的 baseUrl，形如 http://127.0.0.1:9000
 * @param {Object} options
 * @param {string} options.query GraphQL 文本
 * @param {string} [options.role] 以哪个角色执行
 * @param {string} [options.userCode] 用户标识，写入 X-User-Code（供 $user_code 过滤）
 * @param {number} [options.timeoutMs] 超时，默认 30 秒
 * @returns {Promise<Object>} GraphQL 响应体 `{ data, errors }`
 */
async function executeGraphql(baseUrl, { query, role = null, userCode = null, timeoutMs = 30_000 } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new Error('baseUrl 不能为空');
  if (typeof query !== 'string' || query.trim() === '') throw new Error('query 不能为空');

  const headers = { 'Content-Type': 'application/json' };
  if (role) headers['X-User-Role'] = role;
  if (userCode) headers['X-User-Code'] = userCode;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${GRAPHQL_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GraphQL 请求失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GraphQL 返回不是 JSON：${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { executeGraphql, GRAPHQL_PATH };
