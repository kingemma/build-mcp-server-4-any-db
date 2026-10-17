const PORT_KEY = 'mcpb.backendPort';

let currentPort = Number(localStorage.getItem(PORT_KEY) ?? 0);
let requestId = 0;

/**
 * 后端 HTTP 端口。Tauri 启动后端后从 ready 通知里取到，开发模式下手动填。
 * @returns {number}
 */
export function getPort() {
  return currentPort;
}

/**
 * @param {number} port
 */
export function setPort(port) {
  currentPort = Number(port) || 0;
  localStorage.setItem(PORT_KEY, String(currentPort));
}

/**
 * 调用后端 JSON-RPC。
 *
 * @param {string} method 方法名
 * @param {Object} [params] 参数
 * @returns {Promise<*>} result
 */
export async function rpc(method, params = {}) {
  if (!currentPort) {
    throw new Error('尚未设置后端端口，请先在设置页填写');
  }
  requestId += 1;
  const response = await fetch(`http://127.0.0.1:${currentPort}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
  });

  const payload = await response.json();
  if (payload.error) {
    throw new Error(`[${payload.error.code}] ${payload.error.message}`);
  }
  return payload.result;
}

/**
 * 不抛异常的调用，用于探活这类允许失败的场景。
 *
 * @param {string} method
 * @param {Object} [params]
 * @returns {Promise<{ok: boolean, data?: *, error?: string}>}
 */
export async function rpcSafe(method, params = {}) {
  try {
    return { ok: true, data: await rpc(method, params) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 探活后端，顺便确认端口可用。
 * @returns {Promise<boolean>}
 */
export async function ping() {
  const result = await rpcSafe('ping');
  return result.ok && result.data === 'pong';
}
