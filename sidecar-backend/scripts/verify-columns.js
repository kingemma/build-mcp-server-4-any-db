'use strict';

/**
 * 列管控（task 2.6）真机验证。
 *
 * 要回答三个问题：
 * 1. `roles[].tables[].query.columns` 传字符串数组时，是「白名单」还是别的语义；
 * 2. 查询白名单之外的列，GraphJin 是报错、静默置 null，还是照常返回；
 * 3. 是否支持 `{ allow: [...], block: [...] }` 对象形态（source mode 的 grants 是另一种写法，不能套用）。
 *
 * 顺带 dump `get_current_config` 的 roles 形态，供 2.7 安全策略预览面板做 diff 归一化。
 *
 * 用法：
 *   GRAPHJIN_BIN=D:/.../graphjin.exe node scripts/verify-columns.js
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { McpClient } = require('../src/mcp-client');
const { GraphJinService } = require('../src/graphjin');

const BIN = process.env.GRAPHJIN_BIN;
if (!BIN) {
  console.error('请设置 GRAPHJIN_BIN 指向 graphjin 可执行文件');
  process.exit(2);
}

const DEV_YML = (port) => `app_name: Columns Verify
mode: dev
host_port: 0.0.0.0:${port}
web_ui: false
log_level: "warn"
production: false
default_block: false
secret_key: verify-secret

identity:
  role_claims: ["roles"]
  admin_roles: ["admin"]

auth:
  type: none
  development: true

mcp:
  allow_config_updates: true
  allow_dev_tools: true

system:
  root_access:
    gj_config: admin
  capabilities:
    catalog.read: true
    config.read: true
    config.write: true
    dev_tools.read: true
    security.read: true

artifacts:
  auto_init: true
  globals_path: ./config
  poll_seconds: 15
  schema: _graphjin

databases:
  app:
    type: sqlite
    path: app.db
    default: true
`;

function createProject(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dev.yml'), DEV_YML(port), 'utf8');

  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec(
    'CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, plan TEXT, status TEXT, mrr_cents INTEGER)'
  );
  db.exec(`INSERT INTO accounts (id, name, plan, status, mrr_cents) VALUES
    (1, 'alpha', 'free', 'active', 100),
    (2, 'beta', 'pro', 'active', 200)`);
  db.close();
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitReady(baseUrl, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      });
      if (response.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`GraphJin 在 ${timeoutMs}ms 内未就绪`);
}

async function callAsRole(baseUrl, role, query) {
  const client = new McpClient({ baseUrl, role });
  await client.connect();
  return client.callTool('execute_graphql', { query });
}

function errorMessage(result) {
  const first = result?.errors?.[0];
  return typeof first === 'string' ? first : (first?.message ?? '');
}

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function note(name, detail) {
  console.log(`NOTE  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphjin-cols-'));
  const port = await pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  createProject(dir, port);

  const child = spawn(BIN, ['serve', '--path', dir], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  console.log(`项目目录 ${dir}，端口 ${port}`);

  try {
    await waitReady(baseUrl);
    const service = new GraphJinService({ baseUrl, role: 'admin' });
    await service.connect();
    await service.assertLegacyMode();

    // ---- 1. 数组形态：columns: [id, name] ----
    const arrayPatch = {
      roles: [
        {
          name: 'col_allow',
          tables: [
            {
              name: 'accounts',
              database: 'app',
              query: { block: false, columns: ['id', 'name'] },
              insert: { block: true },
              update: { block: true },
              delete: { block: true },
            },
          ],
        },
      ],
    };
    const appliedArray = await service.applyConfig(arrayPatch);
    record('写入 columns 数组形态成功', appliedArray?.success === true,
      JSON.stringify(appliedArray?.errors ?? appliedArray?.changes));

    const allowed = await callAsRole(baseUrl, 'col_allow', 'query { accounts { id name } }');
    const allowedRows = allowed?.data?.accounts ?? [];
    record('白名单内的列可正常查询', allowedRows.length === 2,
      JSON.stringify(allowedRows));

    const withOutside = await callAsRole(
      baseUrl,
      'col_allow',
      'query { accounts { id name plan mrr_cents } }'
    );
    note('查询白名单之外列的原始返回', JSON.stringify(withOutside));
    const outsideRows = withOutside?.data?.accounts ?? [];
    const leaked = outsideRows.some(
      (row) => row?.plan !== null && row?.plan !== undefined && row?.mrr_cents !== null && row?.mrr_cents !== undefined
    );
    record('白名单外的列不会返回真实值', !leaked,
      leaked ? `泄漏：${JSON.stringify(outsideRows)}` : JSON.stringify(outsideRows));

    // ---- 2. 对象形态：columns: { allow: [...] } ----
    const allowObjectPatch = {
      roles: [
        {
          name: 'col_obj',
          tables: [
            {
              name: 'accounts',
              database: 'app',
              query: { block: false, columns: { allow: ['id', 'name'] } },
              insert: { block: true },
              update: { block: true },
              delete: { block: true },
            },
          ],
        },
      ],
    };
    let objectAllowAccepted = false;
    try {
      const applied = await service.applyConfig(allowObjectPatch);
      objectAllowAccepted = applied?.success === true;
      note('columns 对象形态 { allow: [...] }', JSON.stringify(applied?.errors ?? applied?.changes));
    } catch (error) {
      note('columns 对象形态 { allow: [...] } 被拒', error.message);
    }
    note('对象 allow 形态是否被接受', String(objectAllowAccepted));

    // ---- 3. 对象形态：columns: { block: [...] } ----
    const blockObjectPatch = {
      roles: [
        {
          name: 'col_block',
          tables: [
            {
              name: 'accounts',
              database: 'app',
              query: { block: false, columns: { block: ['mrr_cents'] } },
              insert: { block: true },
              update: { block: true },
              delete: { block: true },
            },
          ],
        },
      ],
    };
    let objectBlockAccepted = false;
    try {
      const applied = await service.applyConfig(blockObjectPatch);
      objectBlockAccepted = applied?.success === true;
      note('columns 对象形态 { block: [...] }', JSON.stringify(applied?.errors ?? applied?.changes));
    } catch (error) {
      note('columns 对象形态 { block: [...] } 被拒', error.message);
    }
    note('对象 block 形态是否被接受', String(objectBlockAccepted));

    // ---- 4. 补集模拟：block 语义用「全部列减去阻止列」的白名单表达 ----
    const complementPatch = {
      roles: [
        {
          name: 'col_complement',
          tables: [
            {
              name: 'accounts',
              database: 'app',
              query: { block: false, columns: ['id', 'name', 'plan', 'status'] },
              insert: { block: true },
              update: { block: true },
              delete: { block: true },
            },
          ],
        },
      ],
    };
    const appliedComplement = await service.applyConfig(complementPatch);
    record('补集白名单（排除 mrr_cents）写入成功', appliedComplement?.success === true,
      JSON.stringify(appliedComplement?.errors ?? appliedComplement?.changes));

    const complementRows = await callAsRole(
      baseUrl,
      'col_complement',
      'query { accounts { id name plan status mrr_cents } }'
    );
    note('补集白名单下的原始返回', JSON.stringify(complementRows));
    const complementData = complementRows?.data?.accounts ?? [];
    const complementLeaked = complementData.some(
      (row) => row?.mrr_cents !== null && row?.mrr_cents !== undefined
    );
    record('补集白名单可屏蔽指定列', !complementLeaked, JSON.stringify(complementData));

    // ---- 5. dump 当前配置，供 2.7 的 diff 归一化对齐字段 ----
    const current = await service.readConfig('all');
    note('get_current_config(all) 顶层键', JSON.stringify(Object.keys(current ?? {})));
    note('roles 形态', JSON.stringify(current?.roles ?? null).slice(0, 1200));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    for (const check of failed) console.log(`  FAIL ${check.name}: ${check.detail ?? ''}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`验证异常: ${error.stack ?? error.message}`);
  process.exit(1);
});
