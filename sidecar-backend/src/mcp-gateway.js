'use strict';

/**
 * MCP 网关：外部客户端带 JWT 进来，转成 GraphJin 认的身份头出去。
 *
 * 为什么要这一层：
 * - GraphJin 的 legacy 角色模式实测不从 JWT 解析角色，原生 JWT 通道走不通；
 * - 但 `X-User-Role` + `header_variables`（`X-User-Code` → `$user_code`）实测可用；
 * - 直接把这两个头开放给外部客户端等于没有认证（谁都能自称 admin），
 *   所以外部只认平台签发的 JWT，验签通过后才在回环连接上补这两个头。
 *
 * 上游必须是回环地址：GraphJin 仍以 `auth.type: none` 运行，谁能直连谁就能冒充 admin。
 */

const { Readable } = require('node:stream');

const { JwtError, bearerToken, verifyToken } = require('./jwt');

const MCP_PATH = '/api/v1/mcp';

/** 逐跳头不进不出，其余按原样转发 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {Object} payload
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  response.end(body);
}

/** JSON-RPC 风格的错误体，MCP 客户端能直接读懂 */
function rpcError(response, status, message) {
  sendJson(response, status, { jsonrpc: '2.0', id: null, error: { code: -32001, message } });
}

/**
 * 收集请求体。MCP 的 initialize / tools/call 都是小 JSON，不需要流式上传。
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Buffer>}
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/**
 * @param {Object} options
 * @param {() => string|null} options.resolveTarget 返回当前 GraphJin 的 baseUrl，未运行返回 null
 * @param {string} options.secret JWT 签名密钥
 * @param {Function} [options.verify] 便于测试注入
 * @returns {{path: string, handle: Function}}
 */
function createMcpGateway({ resolveTarget, secret, verify = verifyToken }) {
  return {
    path: MCP_PATH,

    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    async handle(request, response) {
      if (!['POST', 'GET', 'DELETE'].includes(request.method)) {
        sendJson(response, 405, { error: 'method not allowed' });
        return;
      }

      const token = bearerToken(request.headers.authorization);
      let claims;
      try {
        claims = verify(token, secret);
      } catch (error) {
        const message = error instanceof JwtError ? error.message : `令牌校验失败：${error.message}`;
        rpcError(response, 401, message);
        return;
      }

      const target = resolveTarget();
      if (!target) {
        rpcError(response, 503, 'GraphJin 未运行，请先在平台里启动');
        return;
      }

      const headers = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (HOP_BY_HOP.has(name) || name === 'authorization' || name === 'x-user-role' || name === 'x-user-code') {
          continue;
        }
        if (typeof value === 'string') headers[name] = value;
      }
      // 身份只来自校验通过的 token，客户端自带的那两个头一律丢弃
      headers['X-User-Role'] = String(claims.role);
      if (claims.user_code) headers['X-User-Code'] = String(claims.user_code);

      const body = request.method === 'POST' ? await readBody(request) : undefined;

      let upstream;
      try {
        upstream = await fetch(`${target}${MCP_PATH}`, {
          method: request.method,
          headers,
          body,
        });
      } catch (error) {
        rpcError(response, 502, `无法连接 GraphJin：${error.message}`);
        return;
      }

      const responseHeaders = {};
      for (const [name, value] of upstream.headers.entries()) {
        if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value;
      }
      responseHeaders['Access-Control-Allow-Origin'] = '*';
      response.writeHead(upstream.status, responseHeaders);

      // SSE（text/event-stream）必须边收边发，buffer 会让客户端一直等
      if (!upstream.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body).pipe(response);
    },
  };
}

module.exports = { createMcpGateway, MCP_PATH };
