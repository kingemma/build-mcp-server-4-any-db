import i18n from '../i18n';

const PORT_KEY = 'mcpb.backendPort';

/** Electron 主进程注入的端口；浏览器里没有这个对象 */
const injectedPort = Number(globalThis.mcpBuilder?.backendPort ?? 0);

let currentPort = injectedPort || Number(localStorage.getItem(PORT_KEY) ?? 0);
let requestId = 0;

/**
 * 是否运行在桌面外壳里。
 * @returns {boolean}
 */
export function isDesktop() {
  return Boolean(globalThis.mcpBuilder?.isDesktop);
}

/**
 * 后端 HTTP 端口。桌面端由 Electron 注入，浏览器里手填。
 * @returns {number}
 */
export function getPort() {
  return injectedPort || currentPort;
}

/**
 * @param {number} port
 */
export function setPort(port) {
  currentPort = Number(port) || 0;
  // 桌面端的端口来自主进程，手填的值不参与
  if (!injectedPort) localStorage.setItem(PORT_KEY, String(currentPort));
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
    throw new Error(i18n.global.t('errors.portMissing'));
  }
  requestId += 1;
  const response = await fetch(`http://127.0.0.1:${currentPort}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
  });

  const payload = await response.json();
  if (payload.error) {
    throw new Error(
      i18n.global.t('errors.requestFailed', {
        code: payload.error.code,
        message: payload.error.message,
      })
    );
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
