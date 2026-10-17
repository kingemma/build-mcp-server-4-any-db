'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MCP_ENDPOINT_PATH,
  buildClientConfig,
  buildServerEntry,
  buildCliCommands,
  listClients,
  normalizeEndpoint,
} = require('../src/mcp-config');

test('normalizeEndpoint：补上 /api/v1/mcp 且不重复', () => {
  assert.strictEqual(
    normalizeEndpoint('http://127.0.0.1:8083'),
    'http://127.0.0.1:8083/api/v1/mcp'
  );
  assert.strictEqual(
    normalizeEndpoint('http://127.0.0.1:8083/api/v1/mcp'),
    'http://127.0.0.1:8083/api/v1/mcp'
  );
  assert.strictEqual(
    normalizeEndpoint('http://127.0.0.1:8083/'),
    'http://127.0.0.1:8083/api/v1/mcp'
  );
});

test('normalizeEndpoint：空地址报错', () => {
  assert.throws(() => normalizeEndpoint(''), /baseUrl 不能为空/);
  assert.throws(() => normalizeEndpoint(null), /baseUrl 不能为空/);
});

test('HTTP 传输：生成 type/url 直连端点', () => {
  const entry = buildServerEntry({ baseUrl: 'http://127.0.0.1:9000' });
  assert.deepStrictEqual(entry, {
    type: 'http',
    url: 'http://127.0.0.1:9000/api/v1/mcp',
  });
});

test('HTTP 传输不依赖有缺陷的内置 proxy', () => {
  const entry = buildServerEntry({ baseUrl: 'http://127.0.0.1:9000' });
  assert.ok(!('args' in entry));
  // 官方横幅里的 --server 参数在 v3.21.14 并不存在
  assert.ok(!JSON.stringify(entry).includes('--server'));
});

test('stdio 传输：给出前置命令与已知问题说明', () => {
  const entry = buildServerEntry({
    baseUrl: 'http://127.0.0.1:9000',
    transport: 'stdio',
    binPath: 'C:/bin/graphjin.exe',
  });
  assert.strictEqual(entry.command, 'C:/bin/graphjin.exe');
  assert.deepStrictEqual(entry.args, ['mcp']);
  assert.match(entry.prerequisite, /mcp setup http:\/\/127\.0\.0\.1:9000/);
  assert.match(entry.caveat, /400/);
});

test('buildClientConfig：默认名 GraphJin，可改名', () => {
  const config = buildClientConfig({ baseUrl: 'http://127.0.0.1:9000' });
  assert.deepStrictEqual(Object.keys(config.mcpServers), ['GraphJin']);
  assert.strictEqual(config.endpoint, 'http://127.0.0.1:9000/api/v1/mcp');
  assert.strictEqual(config.transport, 'http');

  const renamed = buildClientConfig({ baseUrl: 'http://x', name: 'saas-ops' });
  assert.deepStrictEqual(Object.keys(renamed.mcpServers), ['saas-ops']);
});

test('buildCliCommands：使用已验证存在的 graphjin mcp add 参数', () => {
  const commands = buildCliCommands({ baseUrl: 'http://127.0.0.1:9000', binPath: 'graphjin' });
  const joined = commands.map((c) => c.command).join('\n');
  assert.match(joined, /graphjin mcp add claude http:\/\/127\.0\.0\.1:9000/);
  assert.match(joined, /graphjin mcp add codex http:\/\/127\.0\.0\.1:9000/);
  // 命令里带的是服务根地址，端点由 graphjin 自行规范化
  assert.ok(!joined.includes(MCP_ENDPOINT_PATH));
});

test('listClients：按平台给出配置路径', () => {
  const clients = listClients('win32');
  const ids = clients.map((c) => c.id);
  assert.ok(ids.includes('claude-desktop'));
  assert.ok(ids.includes('cursor'));
  for (const client of clients) {
    assert.strictEqual(typeof client.configPath, 'string');
  }
  const mac = listClients('darwin').find((c) => c.id === 'claude-desktop');
  assert.match(mac.configPath, /Library\/Application Support/);
});
