'use strict';

const MCP_PROTOCOL_VERSION = '2025-06-18';
// GraphJin 要求 Accept 同时声明两者，缺一即返回 400
const ACCEPT_HEADER = 'application/json, text/event-stream';

/** JSON-RPC 层错误 */
class McpProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = code;
    this.data = data;
  }
}

/** MCP 工具执行失败（GraphJin 返回的 success: false 也归于此） */
class McpToolError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = 'McpToolError';
    this.payload = payload;
  }
}

/**
 * 解析 SSE 响应体，取出所有 data 帧里的 JSON-RPC 消息。
 * GraphJin 即使 Accept 声明了 application/json，响应仍是 text/event-stream。
 *
 * @param {string} body 原始响应体
 * @returns {Array<Object>} JSON-RPC 消息列表
 */
function parseSseMessages(body) {
  const messages = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const json = line.slice(5).trim();
    if (json === '') continue;
    messages.push(JSON.parse(json));
  }
  return messages;
}

/**
 * 把 MCP 工具的 content 还原为可用值：能解析成 JSON 就解析，否则返回原文。
 *
 * @param {Object} result tools/call 的 result
 * @returns {*} 解析后的结果
 */
function unwrapToolResult(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

  if (result?.isError) {
    throw new McpToolError(text || 'MCP 工具执行失败', result);
  }
  if (text === '') return result;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * GraphJin MCP HTTP 客户端。
 *
 * 使用要点（均为实测约束）：
 * - 必须先 initialize，再发 notifications/initialized，之后才能调业务方法；
 * - initialize 响应头里的 Mcp-Session-Id 必须回传，否则服务端报
 *   "method xxx is invalid during session initialization"；
 * - 角色通过 X-User-Role 头传递，GraphQL 端点不认这个头，只有 MCP 端点认。
 */
class McpClient {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl 形如 http://127.0.0.1:8083
   * @param {string} [options.role] 以哪个角色调用，配置类操作需要 'admin'
   * @param {Object} [options.clientInfo] 客户端标识
   */
  constructor({ baseUrl, role = null, clientInfo = { name: 'mcp-builder', version: '0.1.0' } }) {
    if (!baseUrl) throw new Error('baseUrl 不能为空');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.role = role;
    this.clientInfo = clientInfo;
    this.sessionId = null;
    this.requestId = 0;
  }

  get endpoint() {
    return `${this.baseUrl}/api/v1/mcp`;
  }

  get isConnected() {
    return this.sessionId !== null;
  }

  #nextId() {
    this.requestId += 1;
    return this.requestId;
  }

  async #send(payload) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: ACCEPT_HEADER,
    };
    if (this.role) headers['X-User-Role'] = this.role;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new McpProtocolError(response.status, `MCP HTTP ${response.status}: ${detail}`);
    }

    const incomingSessionId = response.headers.get('Mcp-Session-Id');
    if (incomingSessionId) this.sessionId = incomingSessionId;

    const messages = parseSseMessages(await response.text());
    // 通知类消息没有响应体
    if (messages.length === 0) return null;

    const matched =
      payload.id === undefined ? null : messages.find((message) => message.id === payload.id);
    const message = matched ?? messages[0];
    if (message.error) {
      throw new McpProtocolError(message.error.code, message.error.message, message.error.data);
    }
    return message.result ?? null;
  }

  /** 完成握手，之后才能调用业务方法 */
  async connect() {
    const result = await this.#send({
      jsonrpc: '2.0',
      id: this.#nextId(),
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
    });
    await this.#send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    return result;
  }

  /** @returns {Promise<Array<Object>>} 当前角色可见的工具列表 */
  async listTools() {
    const result = await this.#send({
      jsonrpc: '2.0',
      id: this.#nextId(),
      method: 'tools/list',
      params: {},
    });
    return result?.tools ?? [];
  }

  /**
   * 调用一个 MCP 工具。
   *
   * @param {string} name 工具名
   * @param {Object} [args] 工具入参
   * @returns {Promise<*>} 已解包的结果
   */
  async callTool(name, args = {}) {
    const result = await this.#send({
      jsonrpc: '2.0',
      id: this.#nextId(),
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return unwrapToolResult(result);
  }
}

module.exports = { McpClient, McpProtocolError, McpToolError, parseSseMessages };
