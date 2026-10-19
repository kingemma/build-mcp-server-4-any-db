'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderDevYaml, renderDatabase, mergeDatabaseBlock } = require('../src/project');

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

const DEV_YAML = `app_name: Demo
mode: dev
databases:
  app:
    type: "sqlite"
    path: "app.db"
    default: true
roles:
  - name: admin
`;

test('mergeDatabaseBlock: 新增库，其余段逐字保留', () => {
  const merged = mergeDatabaseBlock(DEV_YAML, {
    analytics: { type: 'sqlite', path: 'analytics.db' },
  });
  assert.match(merged, /  app:\n {4}type: "sqlite"\n {4}path: "app\.db"\n {4}default: true/);
  assert.match(merged, /  analytics:\n {4}type: "sqlite"\n {4}path: "analytics\.db"/);
  assert.match(merged, /roles:\n {2}- name: admin/);
  assert.doesNotMatch(merged, /\bsources:/);
});

test('mergeDatabaseBlock: 已存在的库原地更新，不重复追加', () => {
  const merged = mergeDatabaseBlock(DEV_YAML, {
    app: { type: 'sqlite', path: 'new.db', default: true },
  });
  assert.match(merged, /path: "new\.db"/);
  assert.doesNotMatch(merged, /app\.db/);
  assert.strictEqual(merged.match(/^ {2}app:$/gm).length, 1);
});

test('mergeDatabaseBlock: 新默认库会摘掉其它库的 default', () => {
  const merged = mergeDatabaseBlock(DEV_YAML, {
    analytics: { type: 'sqlite', path: 'analytics.db', default: true },
  });
  assert.strictEqual((merged.match(/default: true/g) ?? []).length, 1);
  assert.match(merged, /analytics:[\s\S]*default: true/);
  assert.doesNotMatch(merged, /app\.db"\n {4}default: true/);
});

test('mergeDatabaseBlock: 未改动的条目保留注释', () => {
  const yaml = 'databases:\n  app:\n    type: "sqlite" # 主库\n    path: "app.db"\n';
  const merged = mergeDatabaseBlock(yaml, { analytics: { type: 'sqlite', path: 'a.db' } });
  assert.match(merged, /# 主库/);
  assert.match(merged, /analytics:/);
});

test('mergeDatabaseBlock: 幂等，且缺 databases 段时报错', () => {
  const once = mergeDatabaseBlock(DEV_YAML, { analytics: { type: 'sqlite', path: 'a.db' } });
  const twice = mergeDatabaseBlock(once, { analytics: { type: 'sqlite', path: 'a.db' } });
  assert.strictEqual(twice, once);
  assert.throws(() => mergeDatabaseBlock('app_name: Demo\n', {}), /缺少 databases 段/);
});

test('mergeDatabaseBlock: 支持手写引号键，原地更新不重复', () => {
  const yaml = 'databases:\n  "app":\n    type: "sqlite"\n    path: "app.db"\nroles:\n';
  const merged = mergeDatabaseBlock(yaml, {
    app: { type: 'sqlite', path: 'new.db' },
    analytics: { type: 'sqlite', path: 'a.db' },
  });

  assert.strictEqual(merged.match(/^ {2}(?:"?app"?):$/gm).length, 1);
  assert.match(merged, /path: "new\.db"/);
  assert.doesNotMatch(merged, /app\.db/);
  assert.match(merged, /analytics:/);
  assert.match(merged, /roles:/);
});

test('mergeDatabaseBlock: flow 风格 databases 段会转成块风格并保留其它配置', () => {
  const yaml = `app_name: Demo
databases: { app: { type: sqlite, path: app.db, default: true }, old: { type: postgres, host: db } }
roles:
  - name: admin
`;
  const merged = mergeDatabaseBlock(yaml, {
    analytics: { type: 'sqlite', path: 'a.db', default: true },
  });

  assert.match(merged, /^databases:$/m);
  assert.match(merged, /  app:\n {4}type: "sqlite"\n {4}path: "app\.db"/);
  assert.match(merged, /  old:\n {4}type: "postgres"\n {4}host: "db"/);
  assert.match(merged, /  analytics:\n {4}type: "sqlite"\n {4}path: "a\.db"\n {4}default: true/);
  // 新默认库摘掉旧默认库
  assert.strictEqual((merged.match(/default: true/g) ?? []).length, 1);
  assert.match(merged, /roles:\n {2}- name: admin/);
});

test('mergeDatabaseBlock: 块内的单行 flow 条目按条目识别，不会重复新增', () => {
  const yaml = 'databases:\n  app: { type: sqlite, path: app.db }\n  other:\n    type: sqlite\n';
  const merged = mergeDatabaseBlock(yaml, {
    app: { type: 'sqlite', path: 'new.db' },
  });

  assert.strictEqual(merged.match(/^ {2}app:/gm).length, 1);
  assert.match(merged, /path: "new\.db"/);
  assert.match(merged, /  other:\n {4}type: sqlite/);
});

test('mergeDatabaseBlock: 兼容 GraphJin 回写的 4 空格缩进', () => {
  const yaml = `app_name: Demo
databases:
    app:
        type: sqlite
        path: app.db
        default: true
    old:
        type: postgres
        host: db
roles:
    - name: admin
      tables: []
default_block: false
`;
  const merged = mergeDatabaseBlock(yaml, {
    analytics: { type: 'sqlite', path: 'a.db', default: true },
  });

  assert.match(merged, /^databases:$/m);
  assert.match(merged, /^ {4}analytics:\n {8}type: "sqlite"\n {8}path: "a\.db"\n {8}default: true/m);
  assert.match(merged, /^ {4}app:\n {8}type: sqlite/m);
  assert.match(merged, /^ {4}old:\n {8}type: postgres/m);
  assert.ok(merged.indexOf('analytics:') < merged.indexOf('default_block:'));
  assert.strictEqual((merged.match(/default: true/g) ?? []).length, 1);
  assert.match(merged, /roles:\n {4}- name: admin/);
});

test('mergeDatabaseBlock: flow 段未闭合时报错', () => {
  assert.throws(
    () => mergeDatabaseBlock('databases: { app: { type: sqlite }\nroles:\n', {}),
    /flow 段未闭合/
  );
});

test('mergeDatabaseBlock: databases 段含 merge key 时拒绝合并', () => {
  const yaml = 'databases:\n  app:\n    <<: *defaults\n    path: app.db\nroles:\n';
  assert.throws(
    () => mergeDatabaseBlock(yaml, { analytics: { type: 'sqlite', path: 'a.db' } }),
    /merge key/
  );
});

test('mergeDatabaseBlock: databases 段含 anchor / alias 时拒绝合并', () => {
  const anchored = 'databases:\n  app: &base\n    type: sqlite\n    path: app.db\n';
  assert.throws(() => mergeDatabaseBlock(anchored, {}), /anchor \/ alias/);
  assert.throws(() => mergeDatabaseBlock('databases:\n  app: *base\n', {}), /anchor \/ alias/);
});

test('mergeDatabaseBlock: databases 段之外的 anchor 不影响合并', () => {
  const yaml = `app_name: Demo
system: &defaults
  debug: true
databases:
  app:
    type: sqlite
    path: app.db
`;
  const merged = mergeDatabaseBlock(yaml, { analytics: { type: 'sqlite', path: 'a.db' } });
  assert.match(merged, /system: &defaults/);
  assert.match(merged, /analytics:/);
});
