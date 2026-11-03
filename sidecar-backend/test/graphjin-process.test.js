'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { canBindPort, pickFreePort } = require('../src/graphjin-process');

/** 占住一个端口，模拟「端口被别的程序 / 系统保留区间接管」 */
function occupyPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('canBindPort：被占用时为 false，释放后为 true', async () => {
  const server = await occupyPort();
  const { port } = server.address();

  try {
    assert.strictEqual(await canBindPort(port), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.strictEqual(await canBindPort(port), true);
});

test('canBindPort：非法端口直接判定不可用', async () => {
  assert.strictEqual(await canBindPort(0), false);
  assert.strictEqual(await canBindPort(70_000), false);
  assert.strictEqual(await canBindPort(Number.NaN), false);
});

test('pickFreePort：落在候选段内且真的能 bind', async () => {
  for (let i = 0; i < 5; i += 1) {
    const port = await pickFreePort();
    assert.ok(port >= 20_000 && port <= 29_999, `端口 ${port} 超出候选段 20000-29999`);
    assert.strictEqual(await canBindPort(port), true);
  }
});
