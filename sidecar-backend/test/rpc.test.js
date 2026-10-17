'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { RpcRouter, RpcError, METHOD_NOT_FOUND, INVALID_REQUEST, INVALID_PARAMS, PARSE_ERROR } =
  require('../src/rpc');

test('ping 返回结果', async () => {
  const router = new RpcRouter().register('ping', () => 'pong');
  const response = await router.dispatch({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.deepStrictEqual(response, { jsonrpc: '2.0', id: 1, result: 'pong' });
});

test('未知方法返回 METHOD_NOT_FOUND', async () => {
  const router = new RpcRouter();
  const response = await router.dispatch({ jsonrpc: '2.0', id: 2, method: 'nope' });
  assert.strictEqual(response.error.code, METHOD_NOT_FOUND);
  assert.strictEqual(response.id, 2);
});

test('缺少 jsonrpc 字段视为非法请求', async () => {
  const router = new RpcRouter();
  const response = await router.dispatch({ id: 3, method: 'ping' });
  assert.strictEqual(response.error.code, INVALID_REQUEST);
});

test('RpcError 原样透传 code 与 data', async () => {
  const router = new RpcRouter().register('bad', () => {
    throw new RpcError(-32001, '自定义业务错误', { hint: 'x' });
  });
  const response = await router.dispatch({ jsonrpc: '2.0', id: 4, method: 'bad' });
  assert.strictEqual(response.error.code, -32001);
  assert.deepStrictEqual(response.error.data, { hint: 'x' });
});

test('invalidParams 辅助方法', async () => {
  const router = new RpcRouter().register('p', () => {
    throw RpcError.invalidParams('email 不能为空');
  });
  const response = await router.dispatch({ jsonrpc: '2.0', id: 5, method: 'p' });
  assert.strictEqual(response.error.code, INVALID_PARAMS);
});

test('处理器抛普通异常转成内部错误', async () => {
  const router = new RpcRouter().register('boom', () => {
    throw new Error('boom');
  });
  const response = await router.dispatch({ jsonrpc: '2.0', id: 6, method: 'boom' });
  assert.strictEqual(response.error.code, -32603);
  assert.strictEqual(response.error.message, 'boom');
});

test('通知（无 id）不返回响应', async () => {
  let called = false;
  const router = new RpcRouter().register('note', () => {
    called = true;
  });
  const response = await router.dispatch({ jsonrpc: '2.0', method: 'note', params: {} });
  assert.strictEqual(response, null);
  assert.strictEqual(called, true);
});

test('handleLine：空行忽略，非法 JSON 返回 parse error', async () => {
  const router = new RpcRouter();
  assert.strictEqual(await router.handleLine('   '), null);
  const response = await router.handleLine('{not json');
  assert.strictEqual(response.error.code, PARSE_ERROR);
});

test('handleLine：正常一行返回响应', async () => {
  const router = new RpcRouter().register('ping', () => 'pong');
  const response = await router.handleLine('{"jsonrpc":"2.0","id":7,"method":"ping"}');
  assert.deepStrictEqual(response, { jsonrpc: '2.0', id: 7, result: 'pong' });
});
