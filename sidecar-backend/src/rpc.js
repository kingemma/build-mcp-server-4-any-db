'use strict';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** 业务处理器抛出的错误，会原样带上 code 与 data 返回给调用方 */
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  static invalidParams(message, data) {
    return new RpcError(INVALID_PARAMS, message, data);
  }
}

/**
 * JSON-RPC 2.0 路由器，同时服务两种传输：
 * Tauri 通过 stdin/stdout 的行分隔 JSON 调用，前端通过 HTTP POST /rpc 调用。
 */
class RpcRouter {
  constructor() {
    this.handlers = new Map();
  }

  /**
   * @param {string} method 方法名
   * @param {(params: any) => Promise<any> | any} handler
   */
  register(method, handler) {
    this.handlers.set(method, handler);
    return this;
  }

  /**
   * 分发一条请求。
   *
   * @param {Object} request 已解析的 JSON-RPC 请求
   * @returns {Promise<Object|null>} 响应对象；通知类请求返回 null
   */
  async dispatch(request) {
    if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: '非法请求' } };
    }

    const { id, method, params } = request;
    if (typeof method !== 'string') {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: INVALID_REQUEST, message: '缺少 method' } };
    }

    // 没有 id 的是通知，按规范不回响应
    const isNotification = id === undefined;
    try {
      const handler = this.handlers.get(method);
      if (!handler) {
        throw new RpcError(METHOD_NOT_FOUND, `未知方法: ${method}`);
      }
      const result = await handler(params);
      return isNotification ? null : { jsonrpc: '2.0', id, result: result ?? null };
    } catch (error) {
      if (isNotification) return null;
      if (error instanceof RpcError) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: error.code, message: error.message, data: error.data },
        };
      }
      // 不吞异常：把消息回给调用方，堆栈留在服务端日志
      // fetch failed 的原因（ECONNREFUSED / terminated）只在 cause 里，必须一起打
      const cause = error.cause ? `\n[cause] ${error.cause.stack ?? error.cause.message ?? error.cause}` : '';
      const target = params?.baseUrl ? ` baseUrl=${params.baseUrl}` : '';
      console.error(`[rpc] ${method} 失败:${target} ${error.stack ?? error.message}${cause}`);
      return {
        jsonrpc: '2.0',
        id,
        error: { code: INTERNAL_ERROR, message: error.message },
      };
    }
  }

  /**
   * 处理一行文本，解析失败时返回 parse error 响应。
   *
   * @param {string} line
   * @returns {Promise<Object|null>}
   */
  async handleLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') return null;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'JSON 解析失败' } };
    }
    return this.dispatch(request);
  }
}

module.exports = { RpcRouter, RpcError, PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR };
