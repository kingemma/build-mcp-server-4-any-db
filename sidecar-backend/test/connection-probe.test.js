'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { probeConnection } = require('../src/connection-probe');

const SQLITE_CONNECTION = { type: 'sqlite', path: 'app.db' };

test('probeConnection：进程起不来时返回失败结果而不是抛错', async () => {
  const result = await probeConnection({
    name: 'app',
    connection: { type: 'clickhouse' },
    createProcess: () => ({
      start: async () => {
        throw new Error('unsupported database type "clickhouse"');
      },
      stop: async () => {},
    }),
  });

  assert.strictEqual(result.success, false);
  assert.match(result.errors[0], /unsupported database type/);
});

test('probeConnection：成功时返回 validate_config 结果并停止进程', async () => {
  let stopped = false;
  const result = await probeConnection({
    name: 'app',
    connection: SQLITE_CONNECTION,
    createProcess: () => ({
      start: async () => {},
      baseUrl: 'http://127.0.0.1:1',
      stop: async () => {
        stopped = true;
      },
    }),
    createService: () => ({
      connect: async () => {},
      mcp: {
        callTool: async (tool, params) => ({ success: true, tool, params }),
      },
    }),
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.tool, 'validate_config');
  assert.deepStrictEqual(result.params.sources, [{ name: 'app', kind: 'database', ...SQLITE_CONNECTION }]);
  assert.strictEqual(stopped, true);
});

test('probeConnection：临时项目用完即删', async () => {
  let projectDir = '';
  await probeConnection({
    name: 'app',
    connection: SQLITE_CONNECTION,
    createProcess: (options) => {
      projectDir = options.projectDir;
      return {
        start: async () => {},
        baseUrl: 'http://127.0.0.1:1',
        stop: async () => {},
      };
    },
    createService: () => ({
      connect: async () => {},
      mcp: { callTool: async () => ({ success: true }) },
    }),
  });

  assert.ok(projectDir !== '');
  assert.strictEqual(fs.existsSync(projectDir), false);
});
