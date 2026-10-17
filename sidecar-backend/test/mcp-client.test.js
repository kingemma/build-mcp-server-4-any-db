'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseSseMessages } = require('../src/mcp-client');

test('parseSseMessages: 解析多帧 SSE 响应', () => {
  const body = [
    'event: message',
    '',
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    '',
    'event: message',
    '',
    'data: {"jsonrpc":"2.0","id":2,"result":{"ok":false}}',
    '',
  ].join('\n');

  assert.deepStrictEqual(parseSseMessages(body), [
    { jsonrpc: '2.0', id: 1, result: { ok: true } },
    { jsonrpc: '2.0', id: 2, result: { ok: false } },
  ]);
});

test('parseSseMessages: 忽略空 data 与非 data 行', () => {
  const body = ['event: message', 'data:', 'data: {"id":1}', ': keep-alive'].join('\n');
  assert.deepStrictEqual(parseSseMessages(body), [{ id: 1 }]);
});

test('parseSseMessages: 空响应体返回空数组', () => {
  assert.deepStrictEqual(parseSseMessages(''), []);
});

test('McpClient: 缺少 baseUrl 时构造失败', () => {
  const { McpClient } = require('../src/mcp-client');
  assert.throws(() => new McpClient({}), /baseUrl 不能为空/);
});

test('McpClient: endpoint 去掉结尾斜杠后拼接', () => {
  const { McpClient } = require('../src/mcp-client');
  const client = new McpClient({ baseUrl: 'http://127.0.0.1:8085/' });
  assert.strictEqual(client.endpoint, 'http://127.0.0.1:8085/api/v1/mcp');
  assert.strictEqual(client.isConnected, false);
});
