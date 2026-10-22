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
const { parseSseMessages } = require('./mcp-client');

const MCP_PATH = '/api/v1/mcp';

/** 平台自己的本体论工具名。GraphJin 没有这个名字，不会撞车 */
const ONTOLOGY_TOOL_NAME = 'business_ontology';

/**
 * 本体论工具的描述。
 *
 * 措辞是给模型看的，所以要写清「什么时候必须调」：模型只会用它看得懂的理由去调工具。
 */
const ONTOLOGY_TOOL = {
  name: ONTOLOGY_TOOL_NAME,
  description:
    'Read the human-maintained business ontology before writing any query: business terms and the schema they map to, business concepts and what they mean, business rules with their severity, and named metrics with their exact definitions. Call it first whenever a question uses business language, asks for a metric, or might violate a rule. Table structure and relationships are not here — use query_catalog for those.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['term', 'concept', 'rule', 'metric'],
        description: 'Optional: return only this section instead of the whole ontology.',
      },
      database: {
        type: 'string',
        description:
          'Optional: return only the ontology of one database. Each database has its own terms, concepts, rules and metrics — read the section for the database you are about to query.',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

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

/** 请求体解析失败时返回 null：不是 JSON-RPC 的请求照旧透传给上游，由它去报错 */
function safeParseBody(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 读上游的一条 JSON-RPC 消息：GraphJin 恒返回 SSE，测试假上游返回纯 JSON，两种都要认 */
async function readUpstreamMessage(upstream) {
  const text = await upstream.text();
  const frames = parseSseMessages(text);
  if (frames.length > 0) return frames[0];
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 按上游的格式回写：SSE 进 SSE 出，JSON 进 JSON 出，客户端不用分辨 */
async function sendMergedMessage(response, upstream, message) {
  const headers = {};
  for (const [name, value] of upstream.headers.entries()) {
    if (!HOP_BY_HOP.has(name)) headers[name] = value;
  }
  headers['Access-Control-Allow-Origin'] = '*';

  if ((upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
    delete headers['content-length'];
    response.writeHead(upstream.status, headers);
    response.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    return;
  }
  const body = JSON.stringify(message);
  response.writeHead(upstream.status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** 本体论工具的应答。GraphJin 不在线也答得出来——学业务不依赖数据库 */
function sendOntologyResult(response, requestMessage, ontology, { kind = null, database = null } = {}) {
  const entries = ontology.entries.filter(
    (entry) =>
      (!kind || entry.kind === kind) &&
      (database === null || entry.database === database)
  );
  const text = ontology.render({ kind, database });
  const result = {
    content: [{ type: 'text', text }],
    structuredContent: { kind: 'business-ontology', count: entries.length, entries },
    isError: false,
  };
  // 与 GraphJin 保持同一格式：恒为 SSE。客户端两种都收，但混着发容易踩坑
  const body = `event: message\ndata: ${JSON.stringify({
    jsonrpc: '2.0',
    id: requestMessage.id ?? null,
    result,
  })}\n\n`;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
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
 * @param {Function} [options.ontology] 返回 {document, entries, renderFor}；没有维护本体论时返回 null
 * @returns {{path: string, handle: Function}}
 */
function createMcpGateway({ resolveTarget, secret, verify = verifyToken, ontology = null }) {
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

      const body = request.method === 'POST' ? await readBody(request) : undefined;
      const message = body && body.length > 0 ? safeParseBody(body) : null;
      const business = ontology ? ontology() : null;

      // 本体论工具由平台自己答：不转发、也不要求 GraphJin 在线。
      // 放在运行检查之前 —— 「这是什么生意」不该因为库没启动就答不出来。
      if (
        business &&
        message?.method === 'tools/call' &&
        message?.params?.name === ONTOLOGY_TOOL_NAME
      ) {
        const args = message.params.arguments ?? {};
        sendOntologyResult(response, message, business, {
          kind: typeof args.kind === 'string' ? args.kind : null,
          database: typeof args.database === 'string' && args.database ? args.database : null,
        });
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

      // 本体论注入：initialize 带 instructions（模型无需调用就拿到语境），
      // tools/list 追加工具（需要时能主动读）。没有维护本体论时走原样透传。
      const mergeOntology =
        business !== null &&
        request.method === 'POST' &&
        (message?.method === 'initialize' || message?.method === 'tools/list');

      if (!mergeOntology) {
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
        return;
      }

      const merged = await readUpstreamMessage(upstream);
      if (merged?.result) {
        if (message.method === 'initialize') {
          const existing = typeof merged.result.instructions === 'string' ? merged.result.instructions : '';
          merged.result.instructions = existing
            ? `${existing}\n\n${business.document}`
            : business.document;
        }
        if (message.method === 'tools/list') {
          merged.result.tools = [...(merged.result.tools ?? []), ONTOLOGY_TOOL];
        }
      }
      await sendMergedMessage(response, upstream, merged ?? { jsonrpc: '2.0', id: null, error: { code: -32603, message: '上游响应无法解析' } });
    },
  };
}

module.exports = { createMcpGateway, MCP_PATH, ONTOLOGY_TOOL_NAME, ONTOLOGY_TOOL };
