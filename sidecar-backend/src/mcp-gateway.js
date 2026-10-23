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
const { searchEntries, describeObject } = require('./ontology-catalog');

const MCP_PATH = '/api/v1/mcp';

/** 平台自己的本体论工具名。GraphJin 没有这个名字，不会撞车 */
const ONTOLOGY_TOOL_NAME = 'business_ontology';
/** 单个对象的画像工具 */
const DESCRIBE_TOOL_NAME = 'describe_business_object';

/**
 * 本体论工具的描述。
 *
 * 措辞是给模型看的，所以要写清「什么时候必须调」：模型只会用它看得懂的理由去调工具。
 */
const ONTOLOGY_TOOL = {
  name: ONTOLOGY_TOOL_NAME,
  description:
    'Read the human-maintained business ontology: terms and the columns they map to (with real value domains), business concepts, relations that say which foreign key a business name refers to and which way it points, business rules with their severity and the form that enforces them, named metrics with grain, unit, time window and an executable fragment, and worked examples mapping a question to a verified query. The handshake already gives you a catalog of what exists; call this without arguments for the whole ontology, with kind/database for one section, or with query to search by the words a question uses. Use it before writing any query that involves business language, a metric, or a rule. Table structure itself is not here — use query_catalog for that.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['term', 'concept', 'relation', 'rule', 'metric', 'example'],
        description: 'Optional: return only this section instead of the whole ontology.',
      },
      database: {
        type: 'string',
        description:
          'Optional: return only the ontology of one database. Each database has its own terms, concepts, relations, rules, metrics and examples — read the section for the database you are about to query.',
      },
      query: {
        type: 'string',
        description:
          'Optional: search the ontology by wording — pass the business words from the question (a term, an alias, a table name). Returns the few most relevant entries with why they matched.',
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

/** 单个对象的完整画像：概念 + 相关关系/规则/指标/样例 */
const DESCRIBE_TOOL = {
  name: DESCRIBE_TOOL_NAME,
  description:
    'Get the full picture of one business object: its definition, the tables it spans, the relations touching it, and the rules, metrics and worked examples that reference the same tables. Use it once you know which object a question is about; it saves reading the whole ontology.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The business name or alias of the object, as people say it in questions.',
      },
      database: {
        type: 'string',
        description: 'Optional: narrow the lookup to one database.',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/**
 * GraphJin 自带一个 agent 工具，它跑在 GraphJin 进程里，看不见平台注入的本体论。
 *
 * 不移除它（有客户端就是冲它来的，移除等于断人一条路），而是把这件事写进描述：
 * 模型看到「这个工具看不到业务语境」，就会先用本体论、再把要点带进问题里。
 */
const AGENT_TOOL_NAME = 'ask_graphjin_agent';

/**
 * 给上游 agent 工具补一句提醒。
 *
 * @param {Array<Object>} tools
 * @returns {Array<Object>}
 */
function annotateUpstreamTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    if (tool?.name !== AGENT_TOOL_NAME || typeof tool.description !== 'string') return tool;
    if (tool.description.includes('does not see the platform')) return tool;
    return {
      ...tool,
      description: `${tool.description} (This tool runs inside GraphJin and does not see the platform's business ontology: read business_ontology first and put the relevant terms, metrics and rules into your question.)`,
    };
  });
}

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

/** 可用类别从工具 schema 取：只维护一份，避免描述与实际行为漂移 */
const ONTOLOGY_KINDS = ONTOLOGY_TOOL.inputSchema.properties.kind.enum;

/**
 * 「没有内容」必须答出「为什么没有」，不能回一段空字符串。
 *
 * 空文本对模型的含义是「这里没有任何约束」——正好诱导它违反本来存在的规则。
 * 所以空结果要说清三件事：问的是哪个库哪一类、哪些库有本体论、结构该去哪拿。
 *
 * @param {Object} input
 * @param {string|null} input.kind
 * @param {string|null} input.database
 * @param {string[]} [input.databases] 已维护本体论的库
 * @returns {string}
 */
function emptyOntologyText({ kind, database, databases }) {
  const maintained =
    Array.isArray(databases) && databases.length > 0 ? databases.join('、') : '（无）';

  // 库名根本不在已维护清单里：这是「你问错了库」，比「这一类没条目」更该直说
  if (database !== null && !(Array.isArray(databases) && databases.includes(database))) {
    return `数据库「${database}」没有维护业务本体论。已维护的库：${maintained}。表结构请用 query_catalog。`;
  }

  const scope = [];
  if (database !== null) scope.push(`库=${database}`);
  if (kind !== null) scope.push(`类别=${kind}`);
  const where = scope.length > 0 ? `（${scope.join('，')}）` : '';
  return `当前条件下没有本体论条目${where}。已维护的库：${maintained}。表结构请用 query_catalog。`;
}

/**
 * 回一条 tools/call 结果。
 *
 * 与 GraphJin 保持同一格式：恒为 SSE。客户端两种都收，但混着发容易踩坑。
 */
function sendToolResult(response, requestMessage, { text, isError, structuredContent = null }) {
  const result = {
    content: [{ type: 'text', text }],
    isError,
    ...(structuredContent ? { structuredContent } : {}),
  };
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

/**
 * 本体论工具的应答。GraphJin 不在线也答得出来——学业务不依赖数据库。
 *
 * 三个模式共用一个工具：无参/按类别/按库取全文、`query` 检索、以及类别非法时的
 * 明确报错。参数非法走 `isError: true` 的**工具结果**，而不是让异常冒到 HTTP 层：
 * 客户端看到的应该是一句「类别不认识，可用的是这些」，不是 502。
 */
function sendOntologyResult(
  response,
  requestMessage,
  ontology,
  { kind = null, database = null, query = '' } = {}
) {
  if (kind !== null && !ONTOLOGY_KINDS.includes(kind)) {
    sendToolResult(response, requestMessage, {
      text: `未知类别「${kind}」，可用：${ONTOLOGY_KINDS.join(' / ')}`,
      isError: true,
      structuredContent: {
        kind: 'business-ontology',
        error: 'invalid-kind',
        availableKinds: ONTOLOGY_KINDS,
      },
    });
    return;
  }

  // 检索模式：模型带着问题里的说法来，只回最相关的几条（附带命中理由）
  if (query !== '') {
    const matches = searchEntries(ontology.entries ?? [], query, { database, limit: 5 });
    if (matches.length === 0) {
      const maintained = (ontology.databases ?? []).join('、') || '（无）';
      sendToolResult(response, requestMessage, {
        text: `没有匹配「${query}」的条目。已维护的库：${maintained}。可以先不传参看目录，或换一个说法（别名、表名）再试。`,
        isError: false,
        structuredContent: { kind: 'business-ontology', query, count: 0, matches: [] },
      });
      return;
    }

    const text = [
      `# 业务本体论（检索：${query}）`,
      '',
      '按相关性排序，命中理由如下：',
      ...matches.map(
        (match) => `- ${match.entry.name}（${match.entry.kind} · ${match.entry.database}）：${match.matchedBy.join('；')}`
      ),
      '',
      ontology.renderEntries(matches.map((match) => match.entry)),
    ].join('\n');

    sendToolResult(response, requestMessage, {
      text,
      isError: false,
      structuredContent: {
        kind: 'business-ontology',
        query,
        count: matches.length,
        matches: matches.map((match) => ({
          id: match.entry.id,
          kind: match.entry.kind,
          name: match.entry.name,
          database: match.entry.database,
          matchedBy: match.matchedBy,
        })),
      },
    });
    return;
  }

  const entries = (ontology.entries ?? []).filter(
    (entry) => (!kind || entry.kind === kind) && (database === null || entry.database === database)
  );
  const rendered = ontology.render({ kind, database });
  const text =
    rendered === '' ? emptyOntologyText({ kind, database, databases: ontology.databases }) : rendered;

  sendToolResult(response, requestMessage, {
    text,
    isError: false,
    structuredContent: {
      kind: 'business-ontology',
      count: entries.length,
      entries,
      ...(rendered === '' ? { maintainedDatabases: ontology.databases ?? [] } : {}),
    },
  });
}

/**
 * 对象画像的应答。
 *
 * 找不到时不说「没有」就完事：给出最接近的几条候选，模型才有下一步可走。
 */
function sendDescribeResult(response, requestMessage, ontology, { name, database = null }) {
  const found = describeObject(ontology.entries ?? [], name, { database });

  if (!found) {
    const suggestions = searchEntries(ontology.entries ?? [], name, { database, limit: 3 });
    const hint =
      suggestions.length > 0
        ? `最接近的是：${suggestions.map((item) => item.entry.name).join('、')}。`
        : '可以先调 business_ontology 看目录，确认对象叫什么。';
    sendToolResult(response, requestMessage, {
      text: `没有名为「${name}」的对象。${hint}`,
      isError: false,
      structuredContent: { kind: 'business-object', name, found: false, suggestions: suggestions.map((item) => item.entry.name) },
    });
    return;
  }

  const related = found.related;
  const text = [
    `# 业务对象：${found.entry.name}`,
    '',
    `库 ${found.entry.database} · 涉及 ${found.tables.length} 张表 · 相关条目 ${related.length} 条`,
    '',
    ontology.renderEntries([found.entry, ...related]),
  ].join('\n');

  sendToolResult(response, requestMessage, {
    text,
    isError: false,
    structuredContent: {
      kind: 'business-object',
      name: found.entry.name,
      found: true,
      entry: found.entry,
      tables: found.tables,
      related: related.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
      })),
    },
  });
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
      // 把角色传下去：同一个库，受限角色不该看到被屏蔽表的语义
      const business = ontology ? ontology(claims?.role ?? null) : null;

      // 本体论工具由平台自己答：不转发、也不要求 GraphJin 在线。
      // 放在运行检查之前 —— 「这是什么生意」不该因为库没启动就答不出来。
      if (
        business &&
        message?.method === 'tools/call' &&
        message?.params?.name === ONTOLOGY_TOOL_NAME
      ) {
        const args = message.params.arguments ?? {};
        sendOntologyResult(response, message, business, {
          kind: typeof args.kind === 'string' && args.kind ? args.kind : null,
          database: typeof args.database === 'string' && args.database ? args.database : null,
          query: typeof args.query === 'string' ? args.query.trim() : '',
        });
        return;
      }

      // 对象画像同样是平台自己答：它只读本体论，不需要数据库在线
      if (
        business &&
        message?.method === 'tools/call' &&
        message?.params?.name === DESCRIBE_TOOL_NAME
      ) {
        const args = message.params.arguments ?? {};
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (name === '') {
          sendToolResult(response, message, {
            text: 'describe_business_object 需要 name：传对象在业务里的叫法（或别名）。',
            isError: true,
            structuredContent: { kind: 'business-object', error: 'missing-name' },
          });
          return;
        }
        sendDescribeResult(response, message, business, {
          name,
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
          // 握手只给目录：它是每次会话的固定成本，全文按需取。
          // 没有目录（旧调用方）时退回全文，保证升级期间不丢能力。
          const handshake = business.catalog || business.document;
          merged.result.instructions = existing ? `${existing}\n\n${handshake}` : handshake;
        }
        if (message.method === 'tools/list') {
          merged.result.tools = [
            ...annotateUpstreamTools(merged.result.tools),
            ONTOLOGY_TOOL,
            DESCRIBE_TOOL,
          ];
        }
      }
      await sendMergedMessage(response, upstream, merged ?? { jsonrpc: '2.0', id: null, error: { code: -32603, message: '上游响应无法解析' } });
    },
  };
}

module.exports = {
  createMcpGateway,
  MCP_PATH,
  ONTOLOGY_TOOL_NAME,
  ONTOLOGY_TOOL,
  DESCRIBE_TOOL_NAME,
  DESCRIBE_TOOL,
  AGENT_TOOL_NAME,
  annotateUpstreamTools,
};
