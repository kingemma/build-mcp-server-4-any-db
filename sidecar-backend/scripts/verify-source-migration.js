'use strict';

/**
 * legacy → source 模式迁移验证。
 *
 * 走平台真实入口：写一份 legacy dev.yml（databases + roles[].tables）→
 * supervisor.start 触发迁移 → 断言文件、配置与运行时行为（过滤、写拦截）。
 *
 * 用法：node scripts/verify-source-migration.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { GraphJinSupervisor, resolveGraphJinBinary } = require('../src/supervisor');
const { GraphJinService } = require('../src/graphjin');
const { executeGraphql } = require('../src/graphql-http');

const checks = [];
function record(name, pass, detail) {
  checks.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function legacyYaml(port, dbPath = 'app.db') {
  return `app_name: Migration Verify
mode: dev
host_port: 127.0.0.1:${port}
web_ui: false
log_level: "warn"
production: false
default_block: false
secret_key: migration-verify-secret

auth:
  type: none
  development: true

header_variables:
  user_code: "X-User-Code"

roles:
  - name: admin
  - name: analyst
    tables:
      - name: orders
        database: app
        query:
          block: false
          filters: ['{ owner_code: { _eq: $user_code } }']
        insert:
          block: false
        update:
          block: true
        delete:
          block: true

databases:
  app:
    type: sqlite
    path: ${dbPath}
    default: true
`;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-builder-migration-'));
  const devYaml = path.join(dir, 'dev.yml');

  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, owner_code TEXT, status TEXT);
    INSERT INTO orders VALUES (1,'user-a','paid'),(2,'user-a','paid'),(3,'user-b','paid');
  `);
  db.close();

  const supervisor = new GraphJinSupervisor({ binPath: resolveGraphJinBinary() });
  try {
    const { pickFreePort } = require('../src/graphjin-process');
    fs.writeFileSync(devYaml, legacyYaml(await pickFreePort()), 'utf8');

    const status = await supervisor.start({ projectDir: dir });
    record('迁移执行成功', status.migration?.ok === true, JSON.stringify(status.migration ?? null));

    const text = fs.readFileSync(devYaml, 'utf8');
    record('dev.yml 不再含 databases', !/^databases\s*:/m.test(text));
    record('dev.yml 已改为 sources', /^sources\s*:/m.test(text));

    const service = new GraphJinService({ baseUrl: status.baseUrl });
    await service.connect();
    const config = await service.readConfig('all');
    record('配置里只剩 sources', (config.sources ?? []).length === 1, `${(config.sources ?? []).length} 条`);
    const analyst = (config.roles ?? []).find((role) => role.name === 'analyst');
    record('roles[].tables 已清空', (analyst?.tables ?? []).length === 0, JSON.stringify(analyst?.tables ?? []));

    const grants = config.sources?.[0]?.access?.grants ?? [];
    record(
      'grants 按 legacy 读规则生成',
      grants.some((grant) => grant.role === 'analyst' && grant.tables?.[0]?.name === 'orders'),
      JSON.stringify(grants)
    );
    record(
      '写/删降级为 blocked',
      config.sources?.[0]?.access?.write === 'blocked' && config.sources?.[0]?.access?.delete === 'blocked',
      JSON.stringify(config.sources?.[0]?.access ?? {})
    );

    const query = async (role, userCode, text) =>
      executeGraphql(status.baseUrl, { query: text, role, userCode });

    const filtered = await query('analyst', 'user-a', 'query { orders { id } }');
    record(
      '迁移后行过滤仍生效',
      (filtered?.data?.orders ?? []).length === 2,
      JSON.stringify(filtered?.data ?? filtered?.errors ?? null)
    );

    const blocked = await query(
      'analyst',
      'user-a',
      'mutation { orders(insert: { owner_code: "user-a", status: "paid" }) { id } }'
    );
    record('迁移后写入被拦', Boolean(blocked?.errors?.length), blocked?.errors?.[0]?.message ?? '');
  } finally {
    await supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 场景 B：数据源连不上时迁移也必须成功。
  // 回归 https://github.com/kingemma/build-mcp-server-4-any-db —— 走配置 API 写会触发
  // reload，重连失败会整次拒绝（unable to open database file）。
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-builder-migration-broken-'));
  const brokenYaml = path.join(brokenDir, 'dev.yml');
  const brokenSupervisor = new GraphJinSupervisor({ binPath: resolveGraphJinBinary() });
  try {
    const { pickFreePort } = require('../src/graphjin-process');
    fs.writeFileSync(brokenYaml, legacyYaml(await pickFreePort(), 'missing-dir/app.db'), 'utf8');
    const status = await brokenSupervisor.start({ projectDir: brokenDir });
    record('数据库不可达时迁移仍成功', status.migration?.ok === true, JSON.stringify(status.migration ?? null));
    const text = fs.readFileSync(brokenYaml, 'utf8');
    record('不可达项目也已转为 sources', /^sources\s*:/m.test(text) && !/^databases\s*:/m.test(text));
    record('不可达数据源保留在 sources 里', /missing-dir[\\/]app\.db/.test(text));
  } catch (error) {
    record('数据库不可达时迁移仍成功', false, error.message);
  } finally {
    await brokenSupervisor.stop();
    fs.rmSync(brokenDir, { recursive: true, force: true });
  }

  const failed = checks.filter((pass) => !pass).length;
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed}，失败 ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
