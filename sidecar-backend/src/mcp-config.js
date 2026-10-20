'use strict';

/**
 * 生成 MCP 客户端配置。
 *
 * 实测依据（v3.21.14）：
 * - 官方 `graphjin mcp add` 会把 server URL 规范化到 `/api/v1/mcp`，这就是标准端点；
 * - 启动横幅里给的 `"args": ["mcp", "--server", url]` 是**错的**，v3.21.14 没有 --server flag，
 *   官方原话是「there is no --server or --token flag anywhere else」；
 * - 内置 stdio proxy（`args: ["mcp"]`）依赖 client.json，且实测会把请求发到旧路径并缺 Accept 头，
 *   服务端返回 400（见 docs/graphjin-3.21.14-baseline.md §8）。
 *
 * 因此平台默认生成 **HTTP 传输** 配置：直连 /api/v1/mcp，不经过有缺陷的内置 proxy。
 */

const MCP_ENDPOINT_PATH = '/api/v1/mcp';

const TRANSPORT_HTTP = 'http';
const TRANSPORT_STDIO = 'stdio';

/**
 * 已知客户端。configPath 为各客户端约定俗成的配置文件位置，具体以客户端版本为准。
 */
const CLIENTS = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    transports: [TRANSPORT_HTTP, TRANSPORT_STDIO],
    configPath: {
      win32: '%APPDATA%\\Claude\\claude_desktop_config.json',
      darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
      linux: '~/.config/Claude/claude_desktop_config.json',
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    transports: [TRANSPORT_HTTP, TRANSPORT_STDIO],
    configPath: { win32: '%USERPROFILE%\\.cursor\\mcp.json', darwin: '~/.cursor/mcp.json', linux: '~/.cursor/mcp.json' },
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    transports: [TRANSPORT_HTTP],
    configPath: {
      win32: '%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json',
      darwin: '~/.codeium/windsurf/mcp_config.json',
      linux: '~/.codeium/windsurf/mcp_config.json',
    },
  },
  {
    id: 'generic',
    label: '其它支持 mcpServers 的客户端',
    transports: [TRANSPORT_HTTP],
    configPath: { win32: 'mcp.json', darwin: 'mcp.json', linux: 'mcp.json' },
  },
];

/**
 * 把服务地址规范化成 MCP 端点。
 *
 * @param {string} baseUrl 形如 http://127.0.0.1:8083
 * @returns {string} 形如 http://127.0.0.1:8083/api/v1/mcp
 */
function normalizeEndpoint(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('baseUrl 不能为空');
  }
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith(MCP_ENDPOINT_PATH)) return trimmed;
  return `${trimmed}${MCP_ENDPOINT_PATH}`;
}

/**
 * 生成单个 server 条目。
 *
 * @param {Object} options
 * @param {string} options.baseUrl
 * @param {string} [options.transport] http（默认）或 stdio
 * @param {string} [options.binPath] stdio 传输下 graphjin 可执行文件路径
 * @param {string} [options.token] 访问平台网关用的 JWT
 * @returns {Object} mcpServers 里的一个条目
 */
function buildServerEntry({ baseUrl, transport = TRANSPORT_HTTP, binPath = null, token = null }) {
  const endpoint = normalizeEndpoint(baseUrl);

  if (transport === TRANSPORT_STDIO) {
    return {
      command: binPath ?? 'graphjin',
      args: ['mcp'],
      // 内置 proxy 从 client.json 读目标地址，必须先 setup 一次
      prerequisite: `graphjin mcp setup ${endpoint.replace(MCP_ENDPOINT_PATH, '')}`,
      caveat: 'v3.21.14 的内置 proxy 实测会 400（请求发到旧路径且缺 Accept 头），仅作兜底选项',
    };
  }

  // 连平台网关时必须带令牌：网关靠它确定「是谁」，再据此注入行过滤用的用户标识
  if (token) {
    return { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } };
  }
  return { type: 'http', url: endpoint };
}

/**
 * 生成完整客户端配置。
 *
 * @param {Object} options
 * @param {string} options.baseUrl
 * @param {string} [options.name] server 名称，默认 GraphJin
 * @param {string} [options.transport]
 * @param {string} [options.binPath]
 * @param {string} [options.token] 访问平台网关用的 JWT
 * @returns {{mcpServers: Object, endpoint: string, transport: string}}
 */
function buildClientConfig({ baseUrl, name = 'GraphJin', transport = TRANSPORT_HTTP, binPath = null, token = null }) {
  return {
    mcpServers: { [name]: buildServerEntry({ baseUrl, transport, binPath, token }) },
    endpoint: normalizeEndpoint(baseUrl),
    transport,
  };
}

/**
 * 生成可直接粘贴执行的官方命令。
 *
 * 用 GraphJin 自带的 `mcp add`（已实测存在 --client / --server 参数），
 * 而不是臆造第三方 CLI 的语法。
 *
 * @param {Object} options
 * @param {string} options.baseUrl
 * @param {string} [options.binPath]
 * @returns {Array<{label: string, command: string}>}
 */
function buildCliCommands({ baseUrl, binPath = 'graphjin' }) {
  const serverOrigin = normalizeEndpoint(baseUrl).replace(MCP_ENDPOINT_PATH, '');
  return [
    { label: 'Claude Code', command: `${binPath} mcp add claude ${serverOrigin}` },
    { label: 'Codex', command: `${binPath} mcp add codex ${serverOrigin}` },
    { label: '全部', command: `${binPath} mcp add all ${serverOrigin}` },
  ];
}

/**
 * @param {string} [platform] process.platform 风格；缺省取当前平台
 * @returns {Array<{id: string, label: string, transports: string[], configPath: string}>}
 */
function listClients(platform = process.platform) {
  return CLIENTS.map((client) => ({
    id: client.id,
    label: client.label,
    transports: client.transports,
    configPath: client.configPath[platform] ?? client.configPath.linux,
  }));
}

module.exports = {
  MCP_ENDPOINT_PATH,
  TRANSPORT_HTTP,
  TRANSPORT_STDIO,
  CLIENTS,
  buildClientConfig,
  buildServerEntry,
  buildCliCommands,
  listClients,
  normalizeEndpoint,
};
