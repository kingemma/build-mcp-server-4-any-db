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

/** --shots=<dir> 时逐页截图，供 README 引用 */
const SHOT_DIR = (process.argv.find((arg) => arg.startsWith('--shots=')) ?? '').slice('--shots='.length) || null;

/** 页面 key 与两种语言下的顶栏标题，用来判断页面渲染完成 */
const PAGE_SHOTS = [
  { route: 'status', title: { 'zh-CN': '运行状态', 'en-US': 'Runtime' } },
  { route: 'connections', title: { 'zh-CN': '数据库连接', 'en-US': 'Connections' } },
  { route: 'schema', title: { 'zh-CN': 'Schema 浏览器', 'en-US': 'Schema Browser' } },
  { route: 'permissions', title: { 'zh-CN': '权限矩阵', 'en-US': 'Permission Matrix' } },
  { route: 'users', title: { 'zh-CN': '用户与组织', 'en-US': 'Users & Orgs' } },
  { route: 'policy', title: { 'zh-CN': '策略预览', 'en-US': 'Policy Preview' } },
  { route: 'settings', title: { 'zh-CN': '设置', 'en-US': 'Settings' } },
];

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

/**
 * 切换语言并等页面重新渲染。
 *
 * @param {CdpSession} cdp
 * @param {string} locale
 */
async function switchLocale(cdp, locale) {
  try {
    await cdp.evaluate(
      `localStorage.setItem('mcpb.locale', '${locale}');
       location.assign(location.pathname + '?locale=' + Date.now() + location.hash);
       'ok'`
    );
  } catch {
    // 导航会销毁执行上下文
  }
  await waitFor(`界面切换为 ${locale}`, async () =>
    (await cdp.evaluate(
      `document.querySelector('.topbar__title')?.textContent.trim().length ?? 0`
    )) > 0
  );
}

/**
 * 给权限矩阵造数据：加一个角色并翻一个开关，策略页才有 diff 可截。
 *
 * 角色只存在内存里，reload 后就没了，所以每个语言都要重新造一次。
 *
 * @param {CdpSession} cdp
 */
async function seedPermissions(cdp) {
  await cdp.evaluate(`location.hash = '#/permissions'; 'ok'`);
  await waitFor('权限矩阵就绪', async () =>
    (await cdp.evaluate(`Boolean(document.querySelector('.add input'))`)) === true
  );
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.add input');
    input.value = 'readonly';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = [...document.querySelectorAll('.add button')]
      .find((item) => ['添加', 'Add'].includes(item.textContent.trim()));
    button?.click();
    return 'ok';
  })()`);
  await waitFor('矩阵出现', async () =>
    (await cdp.evaluate(`document.querySelectorAll('.matrix tbody tr').length`)) > 0
  );
  await cdp.evaluate(`(() => { document.querySelector('.toggle')?.click(); return 'ok'; })()`);
}

/**
 * 用户/组织页：用表单建组织与成员，再确认列表与后端存储一致。
 *
 * 角色保留表单默认值：角色下拉是 allow-create 的 el-select，
 * 脚本里往它内部 input 塞值不会稳定触发 v-model。
 *
 * @param {CdpSession} cdp
 * @param {(method: string, params?: Object) => Promise<any>} rpc
 */
async function verifyUsers(cdp, rpc) {
  await cdp.evaluate(`location.hash = '#/users'; 'ok'`);
  await waitFor('用户页渲染', async () =>
    (await cdp.evaluate(`document.querySelector('.topbar__title')?.textContent.trim()`)) ===
    '用户与组织'
  );

  await cdp.evaluate(`(() => {
    const input = document.querySelector('.head-actions input');
    input.value = 'acme';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.head-actions button')]
      .find((button) => button.textContent.trim() === '创建')?.click();
    return 'ok';
  })()`);
  await waitFor('组织写入列表', async () =>
    (await cdp.evaluate(
      `[...document.querySelectorAll('.org')].some((item) => item.textContent.includes('acme'))`
    )) === true
  );
  const organizations = await rpc('users.listOrganizations');
  record('创建组织', organizations.some((org) => org.name === 'acme'), organizations.map((o) => o.name).join(', '));

  await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('.form .el-form-item')];
    const fill = (index, value) => {
      const input = items[index]?.querySelector('input');
      if (!input) return;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fill(1, 'Ada');
    fill(2, 'ada@example.com');
    [...document.querySelectorAll('.form button')]
      .find((button) => button.textContent.trim() === '添加成员')?.click();
    return 'ok';
  })()`);
  await waitFor('成员写入列表', async () =>
    (await cdp.evaluate(
      `document.querySelector('.users')?.textContent.includes('ada@example.com')`
    )) === true
  );
  const users = await rpc('users.list');
  const created = users.find((user) => user.email === 'ada@example.com');
  record('创建成员并落库', Boolean(created) && created.role === 'viewer', created ? `role=${created.role}` : 'missing');

  // 编辑成员资料
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.users tbody tr')]
      .find((item) => item.textContent.includes('ada@example.com'));
    [...row.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '编辑')?.click();
    return 'ok';
  })()`);
  await waitFor('编辑成员弹窗', async () =>
    (await cdp.evaluate(
      `[...document.querySelectorAll('.el-dialog')].some((dialog) => dialog.textContent.includes('编辑成员'))`
    )) === true
  );
  await cdp.evaluate(`(() => {
    const dialog = [...document.querySelectorAll('.el-dialog')]
      .find((item) => item.textContent.includes('编辑成员'));
    const input = dialog.querySelectorAll('input')[0];
    input.value = 'Ada L.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '保存')?.click();
    return 'ok';
  })()`);
  await waitFor('成员资料落库', async () => {
    const rows = await rpc('users.list');
    return rows.some((user) => user.email === 'ada@example.com' && user.name === 'Ada L.');
  });
  record('编辑成员资料', true);

  // 空组织删除（acme 下面有成员，留给后端单测覆盖拒绝路径）
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.head-actions input');
    input.value = 'temp';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.head-actions button')]
      .find((button) => button.textContent.trim() === '创建')?.click();
    return 'ok';
  })()`);
  await waitFor('临时组织出现', async () =>
    (await cdp.evaluate(
      `[...document.querySelectorAll('.org')].some((item) => item.textContent.includes('temp'))`
    )) === true
  );
  await cdp.evaluate(`(() => {
    const org = [...document.querySelectorAll('.org')]
      .find((item) => item.textContent.includes('temp'));
    org.querySelector('.org__remove')?.click();
    return 'ok';
  })()`);
  await waitFor('删除组织确认框', async () =>
    (await cdp.evaluate(`document.querySelectorAll('.el-message-box').length`)) > 0
  );
  await cdp.evaluate(`(() => {
    const box = [...document.querySelectorAll('.el-message-box')].pop();
    box.querySelector('.el-button--primary')?.click();
    return 'ok';
  })()`);
  await waitFor('组织已删除', async () => {
    const organizations = await rpc('users.listOrganizations');
    return !organizations.some((org) => org.name === 'temp');
  });
  record('删除组织', true);
}

/** 生效配置里的角色名（Go 结构体直出，键大小写不统一） */
function findRole(config, name) {
  return (config?.roles ?? []).find((role) => (role.name ?? role.Name) === name) ?? null;
}

/**
 * 找某角色在某表上的读规则。
 *
 * source 模式下角色的表规则在 `sources[].access.grants[]` 里，`roles[].tables`
 * 已经被 GraphJin 废弃（存在即启动 FATAL），不能再拿它断言。
 *
 * @param {Object} config config.current 的返回值
 * @param {string} roleName
 * @param {string} tableName
 * @returns {{source: Object, table: Object}|null}
 */
function findGrant(config, roleName, tableName) {
  for (const source of config?.sources ?? []) {
    const grants = source?.access?.grants ?? source?.Access?.Grants ?? [];
    for (const grant of grants) {
      if ((grant.role ?? grant.Role) !== roleName) continue;
      const tables = grant.tables ?? grant.Tables ?? [];
      const table = tables.find((item) => (item.name ?? item.Name) === tableName);
      if (table) return { source, table };
    }
  }
  return null;
}

/**
 * 权限写入 → 策略归零 → 回滚，全链路在真实界面里点一遍。
 *
 * 之前 UI 冒烟只到 Schema；这条链路是产品核心，也是「legacy 模式立即生效」
 * 最容易出事的地方，必须真机点一次。
 *
 * @param {CdpSession} cdp
 * @param {(method: string, params?: Object) => Promise<any>} rpc
 * @param {{baseUrl: string, projectDir: string}} status 运行中实例的状态
 */
async function verifyPermissions(cdp, rpc, status) {
  const { baseUrl } = status;
  await cdp.evaluate(`location.hash = '#/permissions'; 'ok'`);
  await waitFor('权限矩阵就绪', async () =>
    (await cdp.evaluate(`Boolean(document.querySelector('.add input'))`)) === true
  );

  // 每个数据源一个标签页，数量必须和 schema 里的库数一致
  const schemaTables = await rpc('schema.tables', { baseUrl });
  const databases = [...new Set(schemaTables.map((table) => table.database))];
  await waitFor('权限页按库分标签', async () =>
    (await cdp.evaluate(`document.querySelectorAll('.db-tab').length`)) === databases.length
  );
  record('每个库一个独立标签页', databases.length > 1);

  await cdp.evaluate(`(() => {
    const input = document.querySelector('.add input');
    input.value = 'readonly';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.add button')]
      .find((button) => button.textContent.trim() === '添加')?.click();
    return 'ok';
  })()`);
  await waitFor('矩阵出现 events 行', async () =>
    (await cdp.evaluate(`document.querySelectorAll('.matrix tbody tr').length`)) > 0
  );

  const toggled = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.matrix tbody tr')]
      .find((item) => item.querySelector('.col-table')?.textContent.trim() === 'events');
    const button = row?.querySelector('.toggle');
    if (!button) return false;
    if (!button.classList.contains('toggle--allowed')) button.click();
    return true;
  })()`);
  record('矩阵里放行 events.query', toggled === true);
  await waitFor('开关变为允许', async () =>
    (await cdp.evaluate(`document.querySelector('.matrix .toggle--allowed')?.textContent.trim()`)) ===
    '允许'
  );

  // 切到另一个库再切回来：这套未提交改动必须还在（每库一套矩阵）
  const currentTab = await cdp.evaluate(
    `document.querySelector('.db-tab--active')?.textContent.trim() ?? ''`
  );
  const switched = await cdp.evaluate(`(() => {
    const other = [...document.querySelectorAll('.db-tab')]
      .find((tab) => !tab.classList.contains('db-tab--active'));
    if (!other) return false;
    other.click();
    return true;
  })()`);
  if (switched) {
    await waitFor('切到另一个库', async () =>
      (await cdp.evaluate(
        `document.querySelector('.db-tab--active')?.textContent.trim() ?? ''`
      )) !== currentTab
    );
    await cdp.evaluate(`(() => {
      const target = [...document.querySelectorAll('.db-tab')]
        .find((tab) => tab.textContent.trim() === ${JSON.stringify(currentTab)});
      target?.click();
      return 'ok';
    })()`);
    await waitFor('切回原库后规则仍在', async () =>
      (await cdp.evaluate(
        `document.querySelector('.matrix .toggle--allowed')?.textContent.trim()`
      )) === '允许'
    );
    record('切换标签后各库未提交改动互不影响', true);
  }

  await cdp.evaluate(`(() => {
    [...document.querySelectorAll('.panel__head button')]
      .find((button) => button.textContent.trim() === '应用到 GraphJin')?.click();
    return 'ok';
  })()`);
  await waitFor('写入确认框弹出', async () =>
    (await cdp.evaluate(
      `[...document.querySelectorAll('.el-dialog')].some((dialog) => dialog.textContent.includes('确认写入'))`
    )) === true
  );
  await cdp.evaluate(`(() => {
    const dialog = [...document.querySelectorAll('.el-dialog')].pop();
    [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '确认写入')?.click();
    return 'ok';
  })()`);

  await waitFor('策略真的写进 GraphJin', async () => {
    const config = await rpc('config.current', { baseUrl });
    return findGrant(config, 'readonly', 'events') !== null;
  });
  record('界面写入的权限已生效', true);

  // 验证面板：用刚放行的 readonly 真跑一条 query
  await cdp.evaluate(`(() => {
    [...document.querySelectorAll('.panel__head button')]
      .find((button) => button.textContent.trim() === '验证权限')?.click();
    return 'ok';
  })()`);
  await waitFor('验证弹窗打开', async () =>
    (await cdp.evaluate(
      `[...document.querySelectorAll('.el-dialog')].some((dialog) => dialog.textContent.includes('以角色执行查询'))`
    )) === true
  );
  await cdp.evaluate(`(() => {
    const dialog = [...document.querySelectorAll('.el-dialog')]
      .find((item) => item.textContent.includes('以角色执行查询'));
    [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '执行')?.click();
    return 'ok';
  })()`);
  await waitFor('验证结果返回', async () =>
    (await cdp.evaluate(`Boolean(document.querySelector('.verify__result'))`)) === true
  );
  const verifyText = await cdp.evaluate(
    `document.querySelector('.verify__result')?.textContent ?? ''`
  );
  record(
    '验证面板执行查询未被拦',
    verifyText.includes('"data"') && !verifyText.includes('"errors"'),
    verifyText.slice(0, 90)
  );
  await cdp.evaluate(`(() => {
    const dialog = [...document.querySelectorAll('.el-dialog')]
      .find((item) => item.textContent.includes('以角色执行查询'));
    [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '关闭')?.click();
    return 'ok';
  })()`);

  await cdp.evaluate(`location.hash = '#/policy'; 'ok'`);
  await waitFor('策略页显示无差异', async () =>
    (await cdp.evaluate(`document.querySelector('.content')?.textContent.includes('与生效策略一致')`)) ===
    true
  );
  record('写入后策略页与生效策略一致', true);

  const snapshotsBefore = await rpc('permissions.snapshots', {
    baseUrl,
    projectDir: status.projectDir,
  });
  record('写入前自动留快照', snapshotsBefore.length > 0, `${snapshotsBefore.length} 份`);

  await cdp.evaluate(`location.hash = '#/permissions'; 'ok'`);
  await waitFor('回到权限矩阵', async () =>
    (await cdp.evaluate(`Boolean(document.querySelector('.matrix'))`)) === true
  );
  await cdp.evaluate(`(() => {
    [...document.querySelectorAll('.panel__head button')]
      .find((button) => button.textContent.trim() === '写入历史')?.click();
    return 'ok';
  })()`);
  await waitFor('历史里列出快照', async () =>
    (await cdp.evaluate(`document.querySelectorAll('.snapshots li').length`)) > 0
  );

  await cdp.evaluate(`(() => {
    document.querySelector('.snapshots li button')?.click();
    return 'ok';
  })()`);
  await waitFor('回滚确认框弹出', async () =>
    (await cdp.evaluate(`document.querySelectorAll('.el-message-box').length`)) > 0
  );
  await cdp.evaluate(`(() => {
    const box = [...document.querySelectorAll('.el-message-box')].pop();
    box.querySelector('.el-button--primary')?.click();
    return 'ok';
  })()`);

  await waitFor('回滚后 readonly 不再生效', async () => {
    const config = await rpc('config.current', { baseUrl });
    return findRole(config, 'readonly') === null;
  });
  record('从写入历史回滚成功', true);

  // 回滚后 readonly 已不在生效策略里，正常不该弹确认；但界面重载策略可能慢半拍，
  // 弹了就把确认点掉，两种时序都接受
  await cdp.evaluate(`(() => {
    const chip = [...document.querySelectorAll('.role')]
      .find((item) => item.textContent.includes('readonly'));
    chip?.querySelector('.role__remove')?.click();
    return 'ok';
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  if ((await cdp.evaluate(`document.querySelectorAll('.el-message-box').length`)) > 0) {
    await cdp.evaluate(`(() => {
      const box = [...document.querySelectorAll('.el-message-box')].pop();
      box.querySelector('.el-button--primary')?.click();
      return 'ok';
    })()`);
  }
  await waitFor('本地角色已移除', async () =>
    (await cdp.evaluate(`document.querySelectorAll('.role').length`)) === 0
  );
  record('删除本地角色', true);
}

/**
 * 逐页截图，中英文各一套。
 *
 * @param {CdpSession} cdp
 * @param {string} dir 输出目录
 */
async function capturePages(cdp, dir) {
  for (const locale of ['zh-CN', 'en-US']) {
    await switchLocale(cdp, locale);
    await seedPermissions(cdp);
    for (const page of PAGE_SHOTS) {
      await cdp.evaluate(`location.hash = '#/${page.route}'; 'ok'`);
      await waitFor(`${locale}/${page.route} 渲染`, async () =>
        (await cdp.evaluate(`document.querySelector('.topbar__title')?.textContent.trim()`)) ===
        page.title[locale]
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      fs.mkdirSync(path.join(dir, locale), { recursive: true });
      await cdp.screenshot(path.join(dir, locale, `${page.route}.png`));
      console.log(`截图 ${locale}/${page.route}.png`);
    }
  }
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
  // 固定放在被 gitignore 的 projects/ 下：截图里的项目目录比系统临时路径可读。
  // 编辑器 / 杀软偶尔会拦住删除（安全删除走回收站），这时换一个全新目录，
  // 而不是复用半旧状态 —— 否则 dev.yml 里的 roles 会污染断言。
  let projectDir = path.join(ROOT, 'projects', 'ui-verify-demo');
  try {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.mkdirSync(projectDir, { recursive: true });
  } catch {
    projectDir = fs.mkdtempSync(path.join(ROOT, 'projects', 'ui-verify-'));
  }

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
      // 带 query 才会真正重载：只改 hash 是 same-document 导航，app 不会重新读端口
      await cdp.evaluate(
        `localStorage.setItem('mcpb.backendPort', '${backend.port}');
         location.assign(location.pathname + '?boot=' + Date.now() + '#/connections');
         'ok'`
      );
    } catch {
      // 导航会销毁执行上下文，evaluate 在这里报错是预期行为
    }

    try {
      await waitFor('连接列表出现', async () =>
        (await cdp.evaluate(`document.querySelectorAll('.conns tbody tr').length`)) >= 2
      );
    } catch (error) {
      // 失败时把页面文本打出来，比只报超时好定位
      const text = await cdp.evaluate(`document.body.innerText.slice(0, 800)`);
      console.error(`页面内容：${text}`);
      throw error;
    }
    const savedText = await cdp.evaluate(`document.querySelector('.conns').textContent`);
    record('连接页列出已保存连接', savedText.includes('app') && savedText.includes('analytics'));
    record('连接状态显示已连接', savedText.includes('已连接'));

    // 切语言要整棵树重渲染：顶部标题 + 表格表头都跟着变，防漏翻
    await switchLocale(cdp, 'en-US');
    await waitFor('英文界面下连接列表仍在', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.conns tbody tr').length`)) >= 2
    );
    const enTitle = await cdp.evaluate(
      `document.querySelector('.topbar__title').textContent.trim()`
    );
    const enHeader = await cdp.evaluate(`document.querySelector('.conns thead').textContent`);
    record(
      '切换英文后导航与表头变英文',
      enTitle === 'Connections' && enHeader.includes('Name'),
      enTitle
    );

    await switchLocale(cdp, 'zh-CN');
    await waitFor('中文界面下连接列表仍在', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.conns tbody tr').length`)) >= 2
    );
    const zhTitle = await cdp.evaluate(
      `document.querySelector('.topbar__title').textContent.trim()`
    );
    record('切回中文复原', zhTitle === '数据库连接', zhTitle);

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

    await verifyUsers(cdp, rpc);
    await verifyPermissions(cdp, rpc, await rpc('graphjin.status'));

    if (SHOT_DIR) await capturePages(cdp, SHOT_DIR);

    console.log(`\n截图：${connectionsShot}`);
    console.log(`      ${analyticsShot}`);
    console.log(`      ${appShot}`);
  } finally {
    // 先让浏览器自己退出，再杀进程树；只 taskkill 父进程会留下 helper，
    // 它们继续占用 9333 端口，下一次运行会连到旧页面
    try {
      await cdp?.send('Browser.close');
    } catch {
      // 页面已经断开时忽略
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    cdp?.close();
    killTree(edge);
    await new Promise((resolve) => server.close(resolve));
    await backend.stop();
    // 清理失败不算验证失败：GraphJin/杀软可能还占着 .db 一瞬
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
    } catch {
      console.error(`项目目录未清理：${projectDir}`);
    }
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
