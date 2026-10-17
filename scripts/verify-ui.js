'use strict';

/**
 * UI 冒烟验证。
 *
 * 真实链路：进程内起后端（临时数据目录）→ 静态服务 dist → Edge headless（CDP）
 * 注入后端端口 → 连接页看已保存连接 → 点「启动」→ Schema 页切库看结构。
 *
 * 用法：npm run build && npm run verify:ui
 * 依赖：本机 Edge（或用 EDGE_BIN 指定 Chromium 内核浏览器）。
 *
 * 截图落在临时目录，控制台会打印路径。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function resolveEdge() {
  if (process.env.EDGE_BIN) return process.env.EDGE_BIN;
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  const found = candidates.find((file) => file && fs.existsSync(file));
  if (!found) throw new Error('找不到 Edge/Chrome，请用 EDGE_BIN 指定浏览器可执行文件');
  return found;
}

/** 静态服务 dist；hash 路由只需 index.html 兜底 */
function serveDist() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
  };
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
    let file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(DIST)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 极简 CDP 客户端，够 evaluate / screenshot 用 */
class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`无法连接 CDP：${url}`)), { once: true });
    });
    return new CdpSession(socket);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 30_000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`页面脚本异常：${detail}`);
    }
    return result.result.value;
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }

  close() {
    this.socket.close();
  }
}

/**
 * 轮询页面状态。页面重载会短时让 evaluate 失败，这里刻意忽略，靠超时兜底。
 */
async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      // 上下文切换中，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待超时：${label}`);
}

async function findPageTarget(debugPort, expectedPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  const targets = await response.json();
  const page = targets.find(
    (target) =>
      target.type === 'page' &&
      target.webSocketDebuggerUrl &&
      target.url.includes(`127.0.0.1:${expectedPort}`)
  );
  return page?.webSocketDebuggerUrl ?? null;
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // 进程已经退出
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('缺少 dist/index.html，请先执行 npm run build');
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-ui-'));
  const projectDir = path.join(workDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  const appDb = new DatabaseSync(path.join(projectDir, 'app.db'));
  appDb.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);');
  appDb.close();
  const analyticsDb = new DatabaseSync(path.join(projectDir, 'analytics.db'));
  analyticsDb.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, event_id INTEGER REFERENCES events(id));
  `);
  analyticsDb.close();

  process.env.MCP_BUILDER_DATA_DIR = path.join(workDir, 'data');
  process.env.MCP_BUILDER_DB = path.join(workDir, 'mcp-builder.db');

  const { createBackend } = require(path.join(ROOT, 'sidecar-backend', 'src', 'index.js'));
  const backend = await createBackend({ dbPath: process.env.MCP_BUILDER_DB });
  const rpc = async (method, params = {}) => {
    const response = await backend.router.dispatch({ jsonrpc: '2.0', id: 1, method, params });
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };

  const { server, port: staticPort } = await serveDist();
  const profileDir = path.join(workDir, 'edge-profile');
  const debugPort = 9333;
  const edge = spawn(
    resolveEdge(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1440,1000',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      `http://127.0.0.1:${staticPort}/index.html`,
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  let cdp = null;
  try {
    const status = await rpc('graphjin.start', {
      projectDir,
      appName: 'UI Verify',
      databases: {
        app: { type: 'sqlite', path: 'app.db', default: true },
        analytics: { type: 'sqlite', path: 'analytics.db' },
      },
    });
    record('GraphJin 启动', status.running === true, status.baseUrl ?? '');

    let wsUrl = null;
    await waitFor('Edge 打开页面', async () => {
      wsUrl = await findPageTarget(debugPort, staticPort);
      return wsUrl !== null;
    });
    cdp = await CdpSession.open(wsUrl);

    // 端口由 Electron 注入，浏览器里只能走 localStorage；写入后 reload 让 app 读新端口
    try {
      await cdp.evaluate(
        `localStorage.setItem('mcpb.backendPort', '${backend.port}');
         location.hash = '#/connections';
         location.reload();
         'ok'`
      );
    } catch {
      // reload 会销毁执行上下文，evaluate 在这里报错是预期行为
    }

    await waitFor('连接列表出现', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.conns tbody tr').length`)) >= 2
    );
    const savedText = await cdp.evaluate(`document.querySelector('.conns').textContent`);
    record('连接页列出已保存连接', savedText.includes('app') && savedText.includes('analytics'));
    record('连接状态显示已连接', savedText.includes('已连接'));

    const connectionsShot = path.join(workDir, 'connections.png');
    await cdp.screenshot(connectionsShot);

    const beforeStart = await rpc('graphjin.status');
    const clicked = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.conns tbody tr')]
        .find((item) => item.querySelector('.conns__name')?.textContent.trim() === 'analytics');
      if (!row) return false;
      const button = [...row.querySelectorAll('button')]
        .find((item) => item.textContent.includes('启动'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    record('点击「启动」按钮', clicked === true);

    // 必须等 pid 变化：点按钮后旧的运行状态还在，直接判 running 会假通过
    await waitFor('服务按保存的连接重新启动', async () => {
      const current = await rpc('graphjin.status');
      if (!current.running || current.pid === beforeStart.pid) return false;
      const databases = await rpc('graphjin.databases', { baseUrl: current.baseUrl });
      return databases.databases.includes('analytics');
    });
    const databases = await rpc('graphjin.databases', { baseUrl: (await rpc('graphjin.status')).baseUrl });
    record(
      '启动后运行库包含 analytics 与 app',
      databases.databases.includes('analytics') && databases.databases.includes('app'),
      databases.databases.join(', ')
    );

    await cdp.evaluate(`location.hash = '#/schema'; 'ok'`);
    await waitFor('Schema 页库选择器出现', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.database').length`)) >= 2
    );
    const chips = await cdp.evaluate(
      `[...document.querySelectorAll('.database')].map((item) => item.textContent.trim())`
    );
    record('Schema 上方列出已连接数据库', chips.length === 2, chips.join(', '));

    await waitFor('analytics 结构加载', async () => {
      const text = await cdp.evaluate(`document.querySelector('.el-tree')?.textContent ?? ''`);
      return text.includes('events') && text.includes('runs');
    });
    const relations = await cdp.evaluate(`document.querySelectorAll('.rel').length`);
    record('analytics 关系隔离正确', relations === 1, `${relations} 条`);

    const analyticsShot = path.join(workDir, 'schema-analytics.png');
    await cdp.screenshot(analyticsShot);

    await cdp.evaluate(`(() => {
      const chip = [...document.querySelectorAll('.database')]
        .find((item) => item.textContent.includes('app'));
      chip?.click();
      return 'ok';
    })()`);
    await waitFor('app 结构加载', async () => {
      const text = await cdp.evaluate(`document.querySelector('.el-tree')?.textContent ?? ''`);
      return text.includes('users') && !text.includes('events');
    });
    record('切换库后只显示该库的表', true);

    const appShot = path.join(workDir, 'schema-app.png');
    await cdp.screenshot(appShot);

    console.log(`\n截图：${connectionsShot}`);
    console.log(`      ${analyticsShot}`);
    console.log(`      ${appShot}`);
  } finally {
    cdp?.close();
    killTree(edge);
    await new Promise((resolve) => server.close(resolve));
    await backend.stop();
    if (process.env.KEEP_UI_ARTIFACTS) {
      console.log(`产物目录保留：${workDir}`);
    } else {
      // Edge 退出后文件可能短暂被占用，失败就留给系统临时目录
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        console.error(`临时目录未清理：${workDir}`);
      }
    }
  }

  const failed = checks.filter((check) => !check.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`验证异常：${error.stack ?? error.message}`);
  process.exit(1);
});
