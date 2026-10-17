'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderDevYaml, renderDatabase } = require('../src/project');

const BASE = { appName: 'Demo', port: 8080, databases: {} };

test('renderDevYaml: 缺少 appName 或 port 时抛错', () => {
  assert.throws(() => renderDevYaml({ ...BASE, appName: '' }), /appName 不能为空/);
  assert.throws(() => renderDevYaml({ ...BASE, port: 0 }), /port 必须是正整数/);
});

test('renderDevYaml: 缺少 databases 时抛错', () => {
  assert.throws(() => renderDevYaml(BASE), /databases 不能为空/);
});

test('renderDevYaml: 输出 databases map 且不出现 sources', () => {
  const yaml = renderDevYaml({
    ...BASE,
    databases: { app: { type: 'sqlite', path: 'app.db', default: true } },
  });
  assert.match(yaml, /\ndatabases:/);
  assert.match(yaml, /  app:/);
  assert.doesNotMatch(yaml, /\bsources:/);
  // 单数 database 会让服务端 panic
  assert.doesNotMatch(yaml, /^database:/m);
});

test('renderDevYaml: 端口与应用名写入正确', () => {
  const yaml = renderDevYaml({
    ...BASE,
    appName: 'My App',
    port: 9099,
    databases: { app: { type: 'sqlite', path: 'a.db' } },
  });
  assert.match(yaml, /app_name: My App/);
  assert.match(yaml, /host_port: 0\.0\.0\.0:9099/);
});

test('renderDatabase: 只输出有值的字段', () => {
  const rendered = renderDatabase('app', { type: 'postgres', host: '127.0.0.1', port: 5432 });
  assert.match(rendered, /type: "postgres"/);
  assert.match(rendered, /host: "127\.0\.0\.1"/);
  // 数字不加引号
  assert.match(rendered, /port: 5432/);
  assert.doesNotMatch(rendered, /password/);
});

test('renderDatabase: default 为 true 时才写 default', () => {
  assert.match(renderDatabase('a', { type: 'sqlite', default: true }), /default: true/);
  assert.doesNotMatch(renderDatabase('a', { type: 'sqlite' }), /default/);
});
