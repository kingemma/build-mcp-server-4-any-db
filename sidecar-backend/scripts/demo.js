'use strict';

/**
 * 端到端演示：把目前完成的后端能力串起来跑一遍。
 *
 * 后端以 stdin/stdout JSON-RPC 与调用方通信（Tauri 就是这么接的），
 * 这个脚本扮演 Tauri 的角色，依次演示：
 *   起 GraphJin → 发现 Schema → 建组织/用户 → 生成并应用权限矩阵
 *   → 用不同角色真实执行查询验证拦截 → 生成 MCP 客户端配置
 *
 * 用法：node scripts/demo.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-builder-demo-'));
const dbPath = path.join(workDir, 'users.db');
const projectDir = path.join(workDir, 'project');

function heading(text) {
  console.log(`\n${'─'.repeat(64)}\n${text}\n${'─'.repeat(64)}`);
}

function show(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

/** 扮演 Tauri：后端的一条 stdio JSON-RPC 连接 */
class BackendClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method) {
        this.notifications.push(message);
        return;
      }
      const resolver = this.pending.get(message.id);
      if (resolver) {
        this.pending.delete(message.id);
        resolver(message);
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  }

  async call(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`调用 ${method} 超时`)), 120_000);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await promise;
    if (response.error) {
      throw new Error(`${method} 失败 [${response.error.code}] ${response.error.message}`);
    }
    return response.result;
  }
}

async function main() {
  fs.mkdirSync(projectDir, { recursive: true });
  const db = new DatabaseSync(path.join(projectDir, 'app.db'));
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, plan TEXT, mrr_cents INTEGER);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id), amount_cents INTEGER);
    INSERT INTO accounts (id, name, plan, mrr_cents) VALUES
      (1,'alpha','pro',100),(2,'beta','free',0),(3,'gamma','pro',300),(4,'delta','free',0);
  `);
  db.close();

  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, MCP_BUILDER_DB: dbPath },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const backend = new BackendClient(child);

  try {
    heading('1. 后端启动（Tauri ↔ 后端的 stdio JSON-RPC 契约）');
    const ready = await new Promise((resolve) => {
      const poll = () => {
        const found = backend.notifications.find((n) => n.method === 'ready');
        if (found) return resolve(found);
        setTimeout(poll, 50);
      };
      poll();
    });
    show('后端 HTTP 端口', ready.params.port);
    show('ping', await backend.call('ping'));

    heading('2. 拉起 GraphJin（进程编排，崩溃可自动重启）');
    const started = await backend.call('graphjin.start', {
      projectDir,
      appName: 'MCP Builder Demo',
      databases: { app: { type: 'sqlite', path: 'app.db', default: true } },
    });
    show('运行状态', `running=${started.running} port=${started.port} pid=${started.pid}`);
    const health = await backend.call('graphjin.health');
    show('探活', `healthy=${health.healthy} httpStatus=${health.httpStatus}`);
    const baseUrl = started.baseUrl;

    heading('3. Schema 发现');
    const tables = await backend.call('schema.tables', { baseUrl });
    show('表清单', tables.map((t) => `${t.name}(pk=${t.primaryKey})`).join(', '));
    const schema = await backend.call('schema.discover', { baseUrl });
    show('accounts 列', schema.tables.find((t) => t.name === 'accounts').columns.map((c) => `${c.name}:${c.type}`).join(', '));
    show('外键关系', schema.relationships.map((r) => `${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn} (${r.relType})`).join(' | '));

    heading('4. 组织与用户');
    const org = await backend.call('users.createOrganization', { name: 'Acme' });
    show('组织', `${org.id} / ${org.name}`);
    const alice = await backend.call('users.create', {
      organizationId: org.id, name: 'Alice', email: 'alice@acme.test', role: 'admin',
    });
    const bob = await backend.call('users.create', {
      organizationId: org.id, name: 'Bob', email: 'bob@acme.test', role: 'readonly',
    });
    show('用户', `${alice.name}=${alice.role}, ${bob.name}=${bob.role}`);

    heading('5. 权限矩阵（方案 B：roles[].tables + 四项操作开关）');
    const matrix = {
      admin: {
        accounts: {
          query: { enabled: true, limit: 100 },
          insert: { enabled: true },
          update: { enabled: true },
          delete: { enabled: true },
        },
      },
      readonly: {
        accounts: {
          query: { enabled: true, limit: 2, filters: ['{ id: { _gt: 0 } }'] },
          insert: { enabled: false },
          update: { enabled: false },
          delete: { enabled: false },
        },
      },
    };
    show('矩阵摘要', await backend.call('permissions.summarize', { database: 'app', matrix }));
    const applied = await backend.call('permissions.apply', { baseUrl, database: 'app', matrix });
    show('补齐的角色', applied.synced.created);
    show('写入结果', `success=${applied.applied.success} changes=${JSON.stringify(applied.applied.changes)}`);

    heading('6. 用真实查询验证权限是否生效');
    const adminRows = await backend.call('graphql.execute', {
      baseUrl, role: 'admin', query: 'query { accounts(limit: 50) { id name } }',
    });
    show('admin 查询', `${adminRows.data.accounts.length} 行`);

    const roRows = await backend.call('graphql.execute', {
      baseUrl, role: 'readonly', query: 'query { accounts { id name } }',
    });
    show('readonly 查询（受 limit 2 约束）', `${roRows.data.accounts.length} 行 ids=${JSON.stringify(roRows.data.accounts.map((r) => r.id))}`);

    const roInsert = await backend.call('graphql.execute', {
      baseUrl, role: 'readonly',
      query: 'mutation { accounts(insert: { name: "hack", plan: "free", mrr_cents: 0 }) { id } }',
    });
    show('readonly 写入', roInsert.errors?.[0]?.message ?? '未拦截！');

    const adminInsert = await backend.call('graphql.execute', {
      baseUrl, role: 'admin',
      query: 'mutation { accounts(insert: { name: "new-co", plan: "free", mrr_cents: 0 }) { id } }',
    });
    show('admin 写入', adminInsert.errors ? JSON.stringify(adminInsert.errors) : '成功');

    heading('7. MCP 客户端配置（1.8）');
    const config = await backend.call('mcp.clientConfig', { baseUrl, name: 'MCP Builder Demo' });
    console.log(JSON.stringify(config.mcpServers, null, 2));
    show('端点', config.endpoint);
    for (const command of config.cliCommands) show(`命令 · ${command.label}`, command.command);
    const clients = await backend.call('mcp.clients');
    show('已知客户端', clients.map((c) => c.id).join(', '));

    heading('8. 收尾');
    const stopped = await backend.call('graphjin.stop');
    show('停止后', `running=${stopped.running}`);
    console.log(`\n演示完成。工作目录：${workDir}`);
  } catch (error) {
    console.error(`\n演示失败：${error.message}`);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
}

main();
