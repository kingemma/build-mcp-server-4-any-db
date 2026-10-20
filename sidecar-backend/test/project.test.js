'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  renderDevYaml,
  renderSource,
  mergeSourceBlock,
  upsertSourcesBlock,
  replaceRolesBlock,
  removeProjectSource,
} = require('../src/project');

const BASE = { appName: 'Demo', port: 8080, sources: [] };

const SQLITE = { type: 'sqlite', path: 'app.db', default: true };

test('renderDevYaml: 缺少 appName 或 port 时抛错', () => {
  assert.throws(() => renderDevYaml({ ...BASE, appName: '' }), /appName 不能为空/);
  assert.throws(() => renderDevYaml({ ...BASE, port: 0 }), /port 必须是正整数/);
});

test('renderDevYaml: 缺少 sources 时抛错', () => {
  assert.throws(() => renderDevYaml(BASE), /sources 不能为空/);
});

test('renderDevYaml: 输出 sources 数组且不出现 databases', () => {
  const yaml = renderDevYaml({
    ...BASE,
    sources: [{ name: 'app', ...SQLITE }],
  });
  assert.match(yaml, /\nsources:/);
  assert.match(yaml, / {2}- name: "app"/);
  assert.match(yaml, / {4}kind: database/);
  // databases 与 sources 在 3.21.14 不能共存
  assert.doesNotMatch(yaml, /^\s*databases:/m);
  assert.doesNotMatch(yaml, /^database:/m);
});

test('renderDevYaml: 端口与应用名写入正确', () => {
  const yaml = renderDevYaml({
    ...BASE,
    appName: 'My App',
    port: 9099,
    sources: [{ name: 'app', ...SQLITE }],
  });
  assert.match(yaml, /app_name: My App/);
  // 只监听回环：GraphJin 本身不做认证，暴露到 0.0.0.0 等于谁都能直连冒充 admin
  assert.match(yaml, /host_port: 127\.0\.0\.1:9099/);
});

test('renderDevYaml: 写入用户标识头变量', () => {
  const yaml = renderDevYaml({ ...BASE, sources: [{ name: 'app', ...SQLITE }] });
  // 行过滤模板里要用 $user_code，缺了这段过滤器会退化成 0 行
  assert.match(yaml, /header_variables:\n {2}user_code: "X-User-Code"/);
});

test('renderSource: 只输出有值的字段，数字不加引号', () => {
  const rendered = renderSource('app', { type: 'postgres', host: '127.0.0.1', port: 5432 });
  assert.match(rendered, /type: "postgres"/);
  assert.match(rendered, /host: "127\.0\.0\.1"/);
  assert.match(rendered, /port: 5432/);
  assert.doesNotMatch(rendered, /password/);
});

test('renderSource: 缺省 kind 为 database，default 为 true 时才写', () => {
  assert.match(renderSource('a', { type: 'sqlite', default: true }), /kind: database/);
  assert.match(renderSource('a', { type: 'sqlite', default: true }), /default: true/);
  assert.doesNotMatch(renderSource('a', { type: 'sqlite' }), /default/);
});

test('renderSource: 未指定 access 时写入安全默认', () => {
  const rendered = renderSource('a', { type: 'sqlite' });
  assert.match(rendered, /access:\n {6}read: "authenticated"\n {6}write: "blocked"\n {6}delete: "blocked"/);
});

const DEV_YAML = `app_name: Demo
mode: dev
sources:
  - name: "app"
    kind: database
    type: "sqlite"
    path: "app.db"
    default: true
    access:
      read: "authenticated"
      write: "blocked"
      delete: "blocked"
roles:
  - name: admin
`;

test('mergeSourceBlock: 新增源，access 默认写入，其余段逐字保留', () => {
  const merged = mergeSourceBlock(DEV_YAML, {
    analytics: { type: 'sqlite', path: 'analytics.db' },
  });

  assert.match(merged, / {2}- name: "analytics"/);
  assert.match(merged, / {4}kind: database/);
  assert.match(merged, / {4}path: "analytics\.db"/);
  assert.match(merged, / {4}access:\n {6}read: "authenticated"/);
  assert.match(merged, /roles:\n {2}- name: admin/);
  assert.doesNotMatch(merged, /^\s*databases:/m);
});

test('mergeSourceBlock: 已存在的源原地更新，不重复追加且保留 access', () => {
  const merged = mergeSourceBlock(DEV_YAML, {
    app: { type: 'sqlite', path: 'new.db', default: true },
  });

  assert.match(merged, /path: "new\.db"/);
  assert.doesNotMatch(merged, /app\.db/);
  assert.strictEqual(merged.match(/^ {2}- name: "app"$/gm).length, 1);
  assert.match(merged, /access:\n {6}read: "authenticated"/);
});

test('mergeSourceBlock: 新默认源会摘掉其它源的 default', () => {
  const merged = mergeSourceBlock(DEV_YAML, {
    analytics: { type: 'sqlite', path: 'analytics.db', default: true },
  });

  assert.strictEqual((merged.match(/default: true/g) ?? []).length, 1);
  assert.match(merged, /analytics[\s\S]*default: true/);
  assert.doesNotMatch(merged, /app\.db"\n {4}default: true/);
});

test('mergeSourceBlock: 不在已知字段里的配置逐字保留', () => {
  const yaml = `sources:
  - name: app
    kind: database
    type: sqlite
    path: app.db
    read_only: true
    access:
      read: "authenticated"
`;
  const merged = mergeSourceBlock(yaml, { app: { type: 'sqlite', path: 'new.db' } });
  assert.match(merged, /read_only: true/);
  assert.match(merged, /path: "new\.db"/);
  assert.match(merged, /access:\n {6}read: "authenticated"/);
});

test('mergeSourceBlock: 幂等，且缺 sources 段时报错', () => {
  const once = mergeSourceBlock(DEV_YAML, { analytics: { type: 'sqlite', path: 'a.db' } });
  const twice = mergeSourceBlock(once, { analytics: { type: 'sqlite', path: 'a.db' } });
  assert.strictEqual(twice, once);
  assert.throws(
    () => mergeSourceBlock('app_name: Demo\n', { analytics: { type: 'sqlite', path: 'a.db' } }),
    /缺少 sources 段/
  );
});

test('mergeSourceBlock: 支持手写引号键，原地更新不重复', () => {
  const yaml = 'sources:\n  - name: "app"\n    type: "sqlite"\n    path: "app.db"\nroles:\n';
  const merged = mergeSourceBlock(yaml, {
    app: { type: 'sqlite', path: 'new.db' },
    analytics: { type: 'sqlite', path: 'a.db' },
  });

  assert.strictEqual(merged.match(/^ {2}- name: "?app"?$/gm).length, 1);
  assert.match(merged, /path: "new\.db"/);
  assert.doesNotMatch(merged, /app\.db/);
  assert.match(merged, /- name: "analytics"/);
  assert.match(merged, /roles:/);
});

test('mergeSourceBlock: 兼容 GraphJin 回写的 4 空格缩进', () => {
  const yaml = `app_name: Demo
sources:
    - name: app
      kind: database
      type: sqlite
      path: app.db
      default: true
      access:
        read: authenticated
        write: blocked
    - name: old
      kind: database
      type: postgres
      host: db
roles:
    - name: admin
      tables: []
default_block: false
`;
  const merged = mergeSourceBlock(yaml, {
    analytics: { type: 'sqlite', path: 'a.db', default: true },
  });

  assert.match(merged, /^ {4}- name: "?analytics"?\n {6}kind: "?database"?/m);
  assert.match(merged, /^ {4}- name: app\n {6}kind: database/m);
  assert.match(merged, /^ {4}- name: old\n {6}kind: database/m);
  assert.ok(merged.indexOf('analytics') < merged.indexOf('default_block:'));
  assert.strictEqual((merged.match(/default: true/g) ?? []).length, 1);
  assert.match(merged, /roles:\n {4}- name: admin/);
});

test('mergeSourceBlock: flow 风格的 sources 段直接拒绝', () => {
  assert.throws(
    () => mergeSourceBlock('sources: [{ name: app }]\n', { app: { type: 'sqlite' } }),
    /flow 风格/
  );
});

test('mergeSourceBlock: sources 段含 merge key 时拒绝合并', () => {
  const yaml = 'sources:\n  - name: app\n    <<: *defaults\n    path: app.db\nroles:\n';
  assert.throws(() => mergeSourceBlock(yaml, { analytics: { type: 'sqlite', path: 'a.db' } }), /merge key/);
});

test('mergeSourceBlock: sources 段含 anchor / alias 时拒绝合并', () => {
  const anchored = 'sources:\n  - name: app\n    path: &base app.db\n';
  const aliased = 'sources:\n  - name: app\n    path: *base\n';
  assert.throws(() => mergeSourceBlock(anchored, { app: { type: 'sqlite' } }), /anchor \/ alias/);
  assert.throws(() => mergeSourceBlock(aliased, { app: { type: 'sqlite' } }), /anchor \/ alias/);
});

test('mergeSourceBlock: sources 段之外的 anchor 不影响合并', () => {
  const yaml = `app_name: Demo
system: &defaults
  debug: true
sources:
  - name: app
    type: sqlite
    path: app.db
`;
  const merged = mergeSourceBlock(yaml, { analytics: { type: 'sqlite', path: 'a.db' } });
  assert.match(merged, /system: &defaults/);
  assert.match(merged, /- name: "analytics"/);
});

test('renderSource: 渲染 grants 与表分类', () => {
  const yaml = renderSource('app', {
    type: 'sqlite',
    path: 'app.db',
    access: {
      read: 'owner',
      write: 'blocked',
      delete: 'blocked',
      owner_column: 'owner_code',
      admin_tables: ['secrets'],
      blocked_tables: ['audit_log'],
      grants: [
        {
          role: 'analyst',
          tables: [{ name: 'orders', columns: ['id', 'name'], filter: '{ id: { _gt: 0 } }' }],
        },
      ],
    },
  });

  assert.match(yaml, /owner_column: "owner_code"/);
  assert.match(yaml, /admin_tables: \["secrets"\]/);
  assert.match(yaml, /blocked_tables: \["audit_log"\]/);
  assert.match(yaml, /grants:\n\s+- role: "analyst"/);
  assert.match(yaml, /columns: \["id", "name"\]/);
  assert.match(yaml, /filter: "\{ id: \{ _gt: 0 \} \}"/);
});

test('upsertSourcesBlock: 没有 sources 段时追加到文件末尾', () => {
  const legacy = 'app_name: Demo\nroles:\n  - name: admin\n\ndatabases:\n  app:\n    type: sqlite\n';
  const next = upsertSourcesBlock(legacy, [{ name: 'app', type: 'sqlite', path: 'app.db' }]);
  assert.match(next, /^sources:$/m);
  assert.match(next, /- name: "app"/);
  assert.match(next, /databases:/);
});

test('replaceRolesBlock: 整块重写，后面的兄弟段不受影响', () => {
  const text = 'roles:\n  - name: admin\n  - name: analyst\n    tables:\n      - name: orders\nsystem:\n  x: 1\n';
  const next = replaceRolesBlock(text, ['admin', 'analyst']);
  assert.doesNotMatch(next, /tables:/);
  assert.match(next, /roles:\n  - name: "admin"\n  - name: "analyst"\nsystem:/);
});

function writeDevYaml(sources) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-remove-'));
  const file = path.join(dir, 'dev.yml');
  fs.writeFileSync(file, renderDevYaml({ ...BASE, sources }), 'utf8');
  return file;
}

test('removeProjectSource: 只删指定库，其余条目与 access 保留', () => {
  const file = writeDevYaml([
    { name: 'app', ...SQLITE },
    { name: 'other', type: 'sqlite', path: 'other.db' },
  ]);

  assert.strictEqual(removeProjectSource(file, 'app'), true);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /- name: "app"/);
  assert.match(text, /- name: "other"/);
  assert.match(text, /access:/);
});

test('removeProjectSource: 删掉默认库时把 default 交给剩下的第一条', () => {
  const file = writeDevYaml([
    { name: 'app', ...SQLITE },
    { name: 'other', type: 'sqlite', path: 'other.db' },
  ]);

  removeProjectSource(file, 'app');
  // 少了默认库，GraphJin 就不知道该用哪个源，必须就近补上
  assert.match(fs.readFileSync(file, 'utf8'), /- name: "other"\n {4}default: true/);
});

test('removeProjectSource: 库里没有这个名字时返回 false 且不改文件', () => {
  const file = writeDevYaml([{ name: 'app', ...SQLITE }]);
  const before = fs.readFileSync(file, 'utf8');

  assert.strictEqual(removeProjectSource(file, 'nope'), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});
