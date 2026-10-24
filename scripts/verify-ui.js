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

const { parseSseMessages } = require(path.join(__dirname, '..', 'sidecar-backend', 'src', 'mcp-client'));

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** --shots=<dir> 时逐页截图，供 README 引用 */
const SHOT_DIR = (process.argv.find((arg) => arg.startsWith('--shots=')) ?? '').slice('--shots='.length) || null;

/** 页面 key 与两种语言下的顶栏标题，用来判断页面渲染完成 */
const PAGE_SHOTS = [
  // 欢迎页的路由是 '/'，不是 '/welcome'：hash 必须显式给，否则匹配不到路由
  { route: 'welcome', hash: '#/', title: { 'zh-CN': '欢迎', 'en-US': 'Welcome' } },
  { route: 'status', title: { 'zh-CN': '运行状态', 'en-US': 'Runtime' } },
  { route: 'connections', title: { 'zh-CN': '数据库连接', 'en-US': 'Connections' } },
  { route: 'schema', title: { 'zh-CN': 'Schema 浏览器', 'en-US': 'Schema Browser' } },
  { route: 'mcp', title: { 'zh-CN': 'MCP Client', 'en-US': 'MCP Client' } },
  { route: 'connect', title: { 'zh-CN': '接入 AI', 'en-US': 'Connect AI' } },
  { route: 'permissions', title: { 'zh-CN': '权限矩阵', 'en-US': 'Permission Matrix' } },
  { route: 'ontology', title: { 'zh-CN': '业务本体论', 'en-US': 'Business Ontology' } },
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
  // 整页刷新后 schema 是异步拉的：必须等库标签出来（applyDatabase 就位）再加角色，
  // 否则 addRole 看到 applyDatabase 为空会直接返回 false，角色加不上、矩阵永远是空的
  await waitFor('权限页库标签就绪', async () =>
    (await cdp.evaluate(`document.querySelectorAll('.db-tab').length`)) > 0
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
      await cdp.evaluate(`location.hash = '${page.hash ?? `#/${page.route}`}'; 'ok'`);
      await waitFor(`${locale}/${page.route} 渲染`, async () =>
        (await cdp.evaluate(`document.querySelector('.topbar__title')?.textContent.trim()`)) ===
        page.title[locale]
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      fs.mkdirSync(path.join(dir, locale), { recursive: true });
      await cdp.screenshot(path.join(dir, locale, `${page.route}.png`));
      console.log(`截图 ${locale}/${page.route}.png`);

      // 本体论页很长，首屏只到条目列表；质检与规则面板在下面。
      // 文档要能证明这些面板存在，所以再补一张滚到「一致性体检」附近的图。
      if (page.route === 'ontology') {
        await cdp.evaluate(`(() => {
          const panel = [...document.querySelectorAll('.panel')]
            .find((item) => item.textContent.includes('一致性体检'));
          panel?.scrollIntoView({ block: 'start' });
          return panel ? 'ok' : 'missing';
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await cdp.screenshot(path.join(dir, locale, 'ontology-detail.png'));
        console.log(`截图 ${locale}/ontology-detail.png`);
        // 滚回顶部：下一张截图不该继承这里的滚动位置
        await cdp.evaluate(`(() => {
          window.scrollTo(0, 0);
          for (const el of document.querySelectorAll('*')) {
            if (el.scrollTop > 0) el.scrollTop = 0;
          }
          return 'ok';
        })()`);
      }
    }

    // 使用向导是常驻入口，单独截一张打开态的抽屉图
    // 顶栏入口在 App.vue 里被注释掉了，用右下角悬浮按钮打开
    await cdp.evaluate(`location.hash = '#/'; 'ok'`);
    await waitFor(`${locale}/guide 欢迎页渲染`, async () =>
      (await cdp.evaluate(`document.querySelector('.topbar__title')?.textContent.trim()`)) ===
      PAGE_SHOTS[0].title[locale]
    );
    await waitFor(`${locale}/guide 抽屉打开`, async () => {
      await cdp.evaluate(`document.querySelector('.guide-fab')?.click(); 'ok'`);
      return (await cdp.evaluate(`document.querySelector('.guide__intro')`)) !== null;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await cdp.screenshot(path.join(dir, locale, 'guide.png'));
    console.log(`截图 ${locale}/guide.png`);
    await cdp.evaluate(`document.querySelector('.guide__foot button')?.click(); 'ok'`);
    await waitFor(`${locale}/guide 抽屉收起`, async () =>
      (await cdp.evaluate(`document.querySelector('.guide__intro')`)) === null
    );
  }
}

/**
 * 平台网关的最小 MCP 客户端：只发 JSON-RPC、读 SSE 帧。
 *
 * 用来验证「本体论真的送到了客户端」——这一段绕开前端，直接以 AI 客户端的
 * 身份走网关，和 Claude Desktop 拿到的配置是同一条路。
 *
 * @param {string} baseUrl 网关地址，形如 http://127.0.0.1:1234
 * @param {string} token Bearer 令牌
 */
function makeGatewayClient(baseUrl, token) {
  let sessionId = null;
  let nextId = 1;
  return async (method, params = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const response = await fetch(`${baseUrl}/api/v1/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    const incoming = response.headers.get('mcp-session-id');
    if (incoming) sessionId = incoming;
    const frames = parseSseMessages(await response.text());
    return frames[0] ?? null;
  };
}

/**
 * 关掉可能还开着的下拉。
 *
 * Element Plus 的下拉 teleport 到 body，旧下拉只是隐藏、仍在 DOM 里，
 * 直接按文本找 option 会点到上一个下拉的残留项，界面毫无反应。
 */
async function closeDropdowns(cdp) {
  await cdp.evaluate(
    `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
     'ok'`
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** 只取可见的下拉项 */
const VISIBLE_OPTIONS = `[...document.querySelectorAll('.el-select-dropdown__item')].filter((item) => item.offsetParent !== null)`;

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
  // 两张表：本体论的「关联表」是多选，只有一张表时根本验不了多选
  appDb.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), amount REAL);
  `);
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

  // 造一条「已保存但连不上」的记录：公开 API 只在验证通过时才落盘，坏记录只能
  // 直接用后端的存储层写。keystore key 与连接库都在同一个数据目录，加密payload
  // 用同一把 key，UI 拿到的 readable 才是 true、启动按钮才可用。
  const { ConnectionStore } = require(path.join(ROOT, 'sidecar-backend', 'src', 'connections.js'));
  const { loadSecret, signToken } = require(path.join(ROOT, 'sidecar-backend', 'src', 'jwt'));
  const { dataFile } = require(path.join(ROOT, 'sidecar-backend', 'src', 'paths'));
  const seedStore = new ConnectionStore(process.env.MCP_BUILDER_DB);
  seedStore.save({
    name: 'broken',
    projectDir,
    appName: 'UI Verify',
    // postgres 打一个没人听的端口：validate_config 一定连不上
    config: { type: 'postgres', host: '127.0.0.1', port: 1, dbname: 'nope', user: 'nope', password: 'nope' },
    status: 'verified',
    origin: 'test',
  });
  seedStore.close();

  // 造几条本体论条目：两个库各一套，供「本体论页渲染」与「网关送达」两处断言使用
  const { OntologyStore } = require(path.join(ROOT, 'sidecar-backend', 'src', 'ontology.js'));
  const ontologySeed = new OntologyStore(process.env.MCP_BUILDER_DB);
  ontologySeed.save({
    database: 'app',
    kind: 'term',
    name: '买家',
    aliases: ['客户', 'customer'],
    definition: '平台的付费主体，一个买家可有多个订单',
    tables: ['app.main.customers'],
  });
  ontologySeed.save({
    database: 'analytics',
    kind: 'term',
    name: '事件',
    aliases: ['行为'],
    definition: '用户在系统里留下的一条记录',
    tables: ['analytics.main.events'],
  });
  ontologySeed.save({
    database: 'analytics',
    kind: 'metric',
    name: 'GMV',
    aliases: ['成交总额'],
    definition: '已支付订单的金额合计',
    expression: 'sum(amount) where status = "paid"',
    tables: ['analytics.main.orders'],
  });
  // 样例：评测的对象。查询必须对 verify 工程真实的表成立（app.db 的 orders 只有 id/user_id/amount）
  ontologySeed.save({
    database: 'app',
    kind: 'example',
    name: '看订单金额',
    expression: '{ orders(limit: 5) { amount } }',
    tables: ['app.main.orders'],
    payload: { expect: { tables: ['orders'], columns: ['amount'] } },
  });
  // 强制规则：编译面板的输入。verify 工程没配 grants，所以编译应当报「无处可挂」——
  // 这条验的是「做不到就说做不到」，不是只验 happy path
  ontologySeed.save({
    database: 'app',
    kind: 'rule',
    name: '只看未作废',
    definition: '作废的单据不该进统计',
    severity: 'enforce',
    payload: {
      mode: 'filter',
      on: { table: 'app.main.orders' },
      predicate: '{ status: { _eq: "voided" } }',
    },
  });
  ontologySeed.close();
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

    // 启动前先验证：连不上的已保存记录必须被拦住、给出原因，且不能动到正在跑的实例
    const pidBeforeStart = (await rpc('graphjin.status')).pid;
    const brokenClicked = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.conns tbody tr')]
        .find((item) => item.querySelector('.conns__name')?.textContent.trim() === 'broken');
      const button = [...(row?.querySelectorAll('.conns__actions button') ?? [])]
        .find((item) => item.textContent.trim() === '启动');
      if (!button) return 'no-button';
      button.click();
      return 'ok';
    })()`);
    record('连不上的记录也有启动按钮', brokenClicked === 'ok', brokenClicked);
    await waitFor('启动被拦住并弹出提示', async () =>
      (await cdp.evaluate(
        `[...document.querySelectorAll('.el-message')].map((item) => item.textContent).join(' ')`
      )).includes('验证连接失败')
    );
    const blockedText = await cdp.evaluate(
      `[...document.querySelectorAll('.el-message')].map((item) => item.textContent).join(' ')`
    );
    record(
      '启动前验证失败给出提示',
      blockedText.includes('验证连接失败'),
      blockedText.replace(/\s+/g, ' ').slice(0, 140)
    );
    const pidAfterBlocked = (await rpc('graphjin.status')).pid;
    record(
      '验证失败不影响运行中的实例',
      pidAfterBlocked === pidBeforeStart,
      `${pidBeforeStart} -> ${pidAfterBlocked}`
    );

    // 标题三条链路：后端 status.appName（dev.yml）→ store → document.title / Electron IPC
    await waitFor('标题带上项目名', async () =>
      (await cdp.evaluate(`document.title`)).includes('UI Verify')
    );
    const windowTitle = await cdp.evaluate(`document.title`);
    record('窗口标题显示项目名', windowTitle === 'UI Verify — MCP Server Build', windowTitle);

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

    // 菜单顺序必须与使用向导的五步一致：动线在导航上看得见，用户才不用猜下一步
    const navOrder = await cdp.evaluate(
      `[...document.querySelectorAll('.nav__item .nav__title')].map((item) => item.textContent.trim())`
    );
    record(
      '菜单顺序与使用向导一致',
      JSON.stringify(navOrder) ===
        JSON.stringify([
          '欢迎',
          '数据库连接',
          '权限矩阵',
          'MCP Client',
          '业务本体论',
          '接入 AI',
          'Schema 浏览器',
          '运行状态',
          '用户与组织',
          '策略预览',
          '设置',
        ]),
      navOrder.join(' → ')
    );

    // 使用向导：首访自动弹出，关闭持久化，悬浮按钮可再次开启，步骤直达对应页
    const guideIntro =
      await cdp.evaluate(`document.querySelector('.guide__intro')?.textContent ?? ''`);
    record('首访使用向导自动弹出', guideIntro.includes('连接'), guideIntro.slice(0, 60));

    const guideClosed = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.trim() === '关闭向导');
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor('使用向导关闭后从 DOM 卸载', async () =>
      (await cdp.evaluate(`document.querySelector('.guide__intro')`)) === null
    );
    record('使用向导可关闭', guideClosed === 'ok', guideClosed);

    // 布局：窗口本身不滚，滚动只发生在 .content —— 否则内容一长侧栏就跟着被卷走。
    // 首访（localStorage 里没有折叠标记）侧栏是折叠态：64px，只有图标。
    const layout = await cdp.evaluate(`(() => {
      const rail = document.querySelector('.rail');
      const content = document.querySelector('.content');
      const title = document.querySelector('.nav__item .nav__title');
      const icon = document.querySelector('.nav__item .nav-icon');
      return {
        windowScroll:
          document.documentElement.scrollHeight > document.documentElement.clientHeight + 1 ||
          document.body.scrollHeight > document.body.clientHeight + 1,
        contentScrolls: content.scrollHeight > content.clientHeight,
        railWidth: Math.round(rail.getBoundingClientRect().width),
        collapsed: rail.classList.contains('rail--collapsed'),
        titleWidth: Math.round(title.getBoundingClientRect().width),
        iconWidth: Math.round(icon.getBoundingClientRect().width),
      };
    })()`);
    record(
      '窗口不出整体滚动条',
      layout.windowScroll === false,
      `窗口滚动 ${layout.windowScroll} · 内容区可滚 ${layout.contentScrolls}`
    );
    record(
      '侧栏默认折叠成图标',
      layout.collapsed && layout.railWidth <= 72 && layout.titleWidth === 0 && layout.iconWidth > 0,
      `宽 ${layout.railWidth}px · 折叠 ${layout.collapsed} · 标题 ${layout.titleWidth}px · 图标 ${layout.iconWidth}px`
    );

    // 折叠态没有文字，靠 tooltip 补上下文：鼠标移到图标上要弹出「标题 · 副标题」
    const iconCenter = await cdp.evaluate(`(() => {
      const box = document.querySelector('.nav__item').getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: iconCenter.x,
      y: iconCenter.y,
      button: 'none',
    });
    let tooltipText = '';
    await waitFor('折叠态 tooltip 弹出', async () => {
      tooltipText = await cdp.evaluate(
        `[...document.querySelectorAll('.el-popper')]
          .map((item) => item.textContent.replace(/\\s+/g, ' ').trim())
          .join(' | ')`
      );
      return tooltipText.includes('欢迎');
    }, 6_000).catch(() => false);
    record('折叠态图标带 tooltip', tooltipText.includes('欢迎'), tooltipText.slice(0, 60));
    // 移开鼠标，别让 popper 挡住后面的操作
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 420, button: 'none' });

    // 底部按钮展开：文案回来、侧栏变宽；选择写进 localStorage，下次启动沿用。
    // 宽度是 grid-template-columns 的过渡动画（0.16s）：等它稳定再断言，只看 class 会读到中间帧
    await cdp.evaluate(`document.querySelector('.rail__toggle')?.click(); 'ok'`);
    await waitFor(
      '侧栏展开',
      async () =>
        (await cdp.evaluate(`document.querySelector('.rail').getBoundingClientRect().width`)) > 200
    );
    const expandedRail = await cdp.evaluate(`(() => {
      const title = document.querySelector('.nav__item .nav__title');
      return {
        width: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
        titleWidth: Math.round(title.getBoundingClientRect().width),
        remembered: localStorage.getItem('mcpb.railCollapsed'),
      };
    })()`);
    record(
      '侧栏可展开且记住选择',
      expandedRail.width > 200 && expandedRail.titleWidth > 0 && expandedRail.remembered === '0',
      `宽 ${expandedRail.width}px · 标题 ${expandedRail.titleWidth}px · localStorage ${expandedRail.remembered}`
    );
    // 收回折叠态：后面的断言与截图按用户首访看到的布局跑
    await cdp.evaluate(`document.querySelector('.rail__toggle')?.click(); 'ok'`);
    await waitFor(
      '侧栏收回折叠态',
      async () =>
        (await cdp.evaluate(`document.querySelector('.rail').getBoundingClientRect().width`)) <= 72
    );

    // 关闭写进 localStorage：整页刷新后不再自动弹出
    await cdp.evaluate(
      `localStorage.setItem('mcpb.backendPort', '${backend.port}');
       location.assign(location.pathname + '?guide=' + Date.now() + location.hash);
       'ok'`
    );
    await waitFor('刷新后连接列表仍在', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.conns tbody tr').length`)) >= 2
    );
    record(
      '关闭后刷新不再自动弹出',
      (await cdp.evaluate(`document.querySelector('.guide__intro')`)) === null
    );

    // 刷新后（向导已被关过、不再自动弹出）仍能重新打开。
    // 顶栏那个入口在 App.vue 里被注释掉了，现在唯一入口是右下角悬浮按钮；
    // 轮询里重复点击是安全的：openGuide 幂等，早于 Vue 绑定完成的点击不会被吞掉
    await waitFor('刷新后可再次打开使用向导', async () => {
      await cdp.evaluate(`document.querySelector('.guide-fab')?.click(); 'ok'`);
      return (await cdp.evaluate(`document.querySelector('.guide__intro')`)) !== null;
    });
    record('刷新后可再次打开使用向导', true);

    const guideJumped = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.guide-step button')]
        .find((item) => item.textContent.includes('去配置权限'));
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor('向导步骤跳转到权限页并收起', async () =>
      (await cdp.evaluate(`location.hash`)) === '#/permissions' &&
      (await cdp.evaluate(`document.querySelector('.guide__intro')`)) === null
    );
    record('向导步骤直达对应页面', guideJumped === 'ok', await cdp.evaluate(`location.hash`));

    // 本体论是接入 AI 前的那一步：序号、按钮、跳转目标都要对
    // 顶栏入口在 App.vue 里被注释掉了，改用右下角悬浮按钮
    await waitFor('向导再次打开', async () => {
      await cdp.evaluate(`document.querySelector('.guide-fab')?.click(); 'ok'`);
      return (await cdp.evaluate(`document.querySelector('.guide__intro')`)) !== null;
    });
    const guideSteps = await cdp.evaluate(
      `[...document.querySelectorAll('.guide-step')].map((item) => item.textContent.replace(/\\s+/g, ' ').trim())`
    );
    record(
      '本体论是接入 AI 前的一步',
      guideSteps.length === 5 &&
        guideSteps[3].includes('讲清业务') &&
        guideSteps[3].includes('4') &&
        guideSteps[4].includes('接入 AI'),
      `${guideSteps.length} 步：${guideSteps.map((item) => item.slice(0, 12)).join(' / ')}`
    );
    const ontologyJumped = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.guide-step button')]
        .find((item) => item.textContent.includes('去维护本体论'));
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor('本体论步骤跳转到本体论页', async () =>
      (await cdp.evaluate(`location.hash`)) === '#/ontology' &&
      (await cdp.evaluate(`document.querySelector('.guide__intro')`)) === null
    );
    record('本体论步骤直达本体论页', ontologyJumped === 'ok', await cdp.evaluate(`location.hash`));

    // 回到连接页再继续：后面的启动用例操作的是连接列表
    await cdp.evaluate(`location.hash = '#/connections'; 'ok'`);
    await waitFor('回到连接页', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.conns tbody tr').length`)) >= 2
    );

    // 右下角悬浮「使用向导」按钮是另一个入口
    const fabExists = await cdp.evaluate(`!!document.querySelector('.guide-fab')`);
    record('右下角悬浮使用向导按钮存在', fabExists === true);
    await cdp.evaluate(`document.querySelector('.guide-fab')?.click(); 'ok'`);
    await waitFor('悬浮按钮打开使用向导', async () =>
      (await cdp.evaluate(`document.querySelector('.guide__intro')`)) !== null
    );
    record('悬浮按钮可打开使用向导', true);
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.trim() === '关闭向导');
      button?.click();
      return 'ok';
    })()`);
    await waitFor('悬浮按钮测试后收起向导', async () =>
      (await cdp.evaluate(`document.querySelector('.guide__intro')`)) === null
    );

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

    // MCP Client：按 MCP 协议逐个库探活，再跑一条真实查询
    await cdp.evaluate(`location.hash = '#/mcp'; 'ok'`);
    await waitFor('MCP Client 页面渲染', async () =>
      (await cdp.evaluate(`document.querySelector('.topbar__title')?.textContent.trim()`)) ===
      'MCP Client'
    );
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.includes('测试全部库'));
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor('库探活出结果', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.probes tbody tr').length`)) >= 2
    );
    const probeText = await cdp.evaluate(`document.querySelector('.probes').textContent`);
    record(
      'MCP Client 逐个库探活通过',
      probeText.includes('可用') && !probeText.includes('失败'),
      probeText.replace(/\s+/g, ' ').slice(0, 120)
    );

    await cdp.evaluate(`(() => {
      const box = document.querySelector('.query textarea');
      if (!box) return 'missing';
      box.value = '{ events(limit: 1) { id kind } }';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.includes('通过 MCP 执行'));
      if (!button) return 'no-button';
      button.click();
      return 'ok';
    })()`);
    await waitFor('MCP 查询返回结果', async () =>
      (await cdp.evaluate(`document.querySelector('.result')?.textContent ?? ''`)).includes('"data"')
    );
    const queryText = await cdp.evaluate(`document.querySelector('.result').textContent`);
    record(
      'MCP 查询返回数据',
      queryText.includes('"events"'),
      queryText.replace(/\s+/g, ' ').slice(0, 120)
    );

    // 调用示例：示例查询点一下就填进编辑器，工具示例给出可复制的参数 JSON
    const sampleInfo = await cdp.evaluate(`(() => {
      const chips = [...document.querySelectorAll('.samples .chip--action')];
      return {
        count: chips.length,
        queries: chips.map((chip) => chip.title),
        text: document.querySelector('.samples')?.textContent ?? '',
      };
    })()`);
    record(
      'MCP 示例查询可点击',
      sampleInfo.count >= 2 && sampleInfo.queries.every((item) => item.includes('(limit:')),
      `${sampleInfo.count} 个 · ${sampleInfo.text.replace(/\s+/g, ' ').slice(0, 80)}`
    );
    // 点击后 Vue 在 nextTick 才把值写回 textarea，必须等值真的变成示例语句
    await cdp.evaluate(`document.querySelector('.samples .chip--action')?.click(); 'ok'`);
    await waitFor('点示例填入查询语句', async () =>
      (await cdp.evaluate(`document.querySelector('.query textarea')?.value ?? ''`)) ===
      sampleInfo.queries[0]
    );
    const applied = await cdp.evaluate(`document.querySelector('.query textarea')?.value`);
    record('点示例填入查询语句', applied === sampleInfo.queries[0], applied.slice(0, 80));
    const toolSampleText =
      await cdp.evaluate(`document.querySelector('.tool-samples')?.textContent ?? ''`);
    record(
      'MCP 工具调用示例渲染',
      toolSampleText.includes('execute_graphql') && toolSampleText.includes('"query"'),
      toolSampleText.replace(/\s+/g, ' ').slice(0, 100)
    );

    // Run 输入框粘「调用示例」的 JSON 参数：平台替用户取出 query，而不是把 JSON 扔给 GraphJin
    await cdp.evaluate(`(() => {
      const box = document.querySelector('.query textarea');
      if (!box) return 'missing';
      box.value = '{ "query": "{ events(limit: 1) { id } }" }';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.includes('通过 MCP 执行'));
      if (!button) return 'no-button';
      button.click();
      return 'ok';
    })()`);
    await waitFor('粘 JSON 参数也能跑出结果', async () => {
      const text = await cdp.evaluate(`document.querySelector('.result')?.textContent ?? ''`);
      return text.includes('"data"') && !text.includes('unexpected token');
    });
    const jsonArgText = await cdp.evaluate(`document.querySelector('.result')?.textContent ?? ''`);
    record(
      'Run 输入框粘 JSON 参数自动解包',
      jsonArgText.includes('"data"') && !jsonArgText.includes('unexpected token'),
      jsonArgText.replace(/\s+/g, ' ').slice(0, 120)
    );

    // 后端同样要防：粘成别的 JSON（没有 query 字段）时给明确错误，别透传 GraphJin 的语法错误
    const mcpStatus = await rpc('graphjin.status');
    let wrongJsonMessage = '';
    try {
      await rpc('mcp.query', {
        baseUrl: mcpStatus.baseUrl,
        role: 'admin',
        query: '{ "database": "app" }',
      });
    } catch (error) {
      wrongJsonMessage = error.message;
    }
    record(
      'mcp.query 对粘错的 JSON 给出明确错误',
      /JSON 参数/.test(wrongJsonMessage),
      wrongJsonMessage.slice(0, 120)
    );

    const appShot = path.join(workDir, 'schema-app.png');
    await cdp.screenshot(appShot);

    await verifyUsers(cdp, rpc);
    await verifyPermissions(cdp, rpc, await rpc('graphjin.status'));

    if (SHOT_DIR) await capturePages(cdp, SHOT_DIR);

    // 状态列表达的是「当前实例」，不是历史值：停止后必须立刻回落
    await switchLocale(cdp, 'zh-CN');
    await cdp.evaluate(`location.hash = '#/status'; 'ok'`);
    await waitFor('运行状态页出现停止按钮', async () =>
      (await cdp.evaluate(
        `[...document.querySelectorAll('button')].some((item) => item.textContent.includes('停止'))`
      )) === true
    );
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.includes('停止'));
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor('GraphJin 已停止', async () => (await rpc('graphjin.status')).running === false);

    await cdp.evaluate(`location.hash = '#/connections'; 'ok'`);
    // 等到「已测试且不再有任何已连接」再收手：只等「已测试」出现会撞上个别行还没翻完的中间态
    let stoppedText = '';
    await waitFor('停止后连接列表回落', async () => {
      stoppedText = await cdp.evaluate(`document.querySelector('.conns')?.textContent ?? ''`);
      return stoppedText.includes('已测试') && !stoppedText.includes('已连接');
    });
    // 断言前重新读一次，等待条件与断言逐字一致，中间态不可能溜进结果
    stoppedText = await cdp.evaluate(`document.querySelector('.conns')?.textContent ?? ''`);
    record(
      '停止后连接状态回落为已测试',
      stoppedText.includes('已测试') && !stoppedText.includes('已连接'),
      stoppedText.includes('已连接')
        ? '仍显示已连接'
        : stoppedText.includes('已测试')
          ? ''
          : '未显示已测试'
    );

    // 停止态读不到生效配置（config.current 需要 baseUrl）：步骤 2 只能靠历史快照判断，
    // 连快照都没有时必须显示「未确认」，不能武断写成「待完成」
    await cdp.evaluate(`location.hash = '#/'; 'ok'`);
    await waitFor('停止后欢迎页渲染', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.step').length`)) === 3
    );
    const stepPill = async (index) =>
      (
        await cdp.evaluate(
          `document.querySelectorAll('.step')[${index}]?.querySelector('.pill')?.textContent ?? ''`
        )
      ).trim();
    // 上面的回滚把 grants 清空了，所以步骤 2 的真实状态是「待完成」。
    // 旧实现靠历史快照兜底会说「已完成」，这条断言顺带证明读的是 dev.yml 而不是快照。
    await waitFor('停止后步骤 2 按 dev.yml 判定', async () => (await stepPill(1)) === '待完成');
    const stoppedStatus = await rpc('graphjin.status');
    // 接入配置跟着实例失效：停了就不该还标着已完成
    await waitFor('停止后步骤 3 回落', async () => (await stepPill(2)) === '待完成', 8_000);
    const stoppedStep3 = await stepPill(2);
    const railText = await cdp.evaluate(
      `document.querySelector('.rail__foot')?.textContent?.trim() ?? ''`
    );
    record(
      '停止后步骤 3 回落为待完成',
      stoppedStep3 === '待完成',
      `${stoppedStep3} · 运行态 ${stoppedStatus.running} · 侧栏 ${railText} · 步骤2 ${await stepPill(1)}`
    );
    record('停止后步骤 2 以 dev.yml 为准', (await stepPill(1)) === '待完成', await stepPill(1));

    // 停止态判定的真相来源是 GraphJin 回写进 dev.yml 的 access。这里直接打接口，
    // 排除「其实靠快照兜底」的可能
    const fileConfig = await rpc('config.file', { projectDir: stoppedStatus.projectDir });
    record(
      '停止后仍能从 dev.yml 读出数据源与角色',
      fileConfig.sources.length > 0 && fileConfig.roles.length > 0,
      `${fileConfig.sources.map((item) => item.name).join(',')} · 角色 ${fileConfig.roles
        .map((item) => item.name)
        .join(',')}`
    );

    // 下面的步骤还在连接页上点「启动」，断言完必须回到原页面
    await cdp.evaluate(`location.hash = '#/connections'; 'ok'`);
    await waitFor('回到连接页', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.conns tbody tr').length`)) > 0
    );

    // 删掉运行中实例正在用的库：实例要重启，Schema 页随之少一个库
    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.conns tbody tr')]
        .find((item) => item.querySelector('.conns__name')?.textContent.trim() === 'app');
      const button = [...(row?.querySelectorAll('button') ?? [])]
        .find((item) => item.textContent.includes('启动'));
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor('实例重新启动并标为已连接', async () => {
      const text = await cdp.evaluate(`document.querySelector('.conns')?.textContent ?? ''`);
      return (await rpc('graphjin.status')).running === true && text.includes('已连接');
    });

    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.conns tbody tr')]
        .find((item) => item.querySelector('.conns__name')?.textContent.trim() === 'analytics');
      const button = [...(row?.querySelectorAll('button') ?? [])]
        .find((item) => item.textContent.includes('删除'));
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor('删除确认框弹出', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.el-message-box').length`)) > 0
    );
    await cdp.evaluate(`(() => {
      const box = [...document.querySelectorAll('.el-message-box')].pop();
      box.querySelector('.el-button--primary')?.click();
      return 'ok';
    })()`);

    // 重启后库清单来自 dev.yml：被删的库不该还留在运行实例里
    await waitFor('实例重启后不再加载被删的库', async () => {
      const current = await rpc('graphjin.status');
      if (!current.running) return false;
      const live = await rpc('graphjin.databases', { baseUrl: current.baseUrl });
      return !live.databases.includes('analytics');
    });

    await cdp.evaluate(`location.hash = '#/schema'; 'ok'`);
    await waitFor('Schema 页只剩一个库', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.database').length`)) === 1
    );
    const remainingDatabases = await cdp.evaluate(
      `[...document.querySelectorAll('.database')].map((item) => item.textContent.trim())`
    );
    record(
      '删除连接后 Schema 随之重置',
      remainingDatabases.length === 1 && remainingDatabases[0].includes('app'),
      remainingDatabases.join(', ')
    );

    // 欢迎页 → 接入向导 → 一键演示 → 一键体检（新用户冷启动路径）
    await cdp.evaluate(`location.hash = '#/'; 'ok'`);
    await waitFor('欢迎页渲染', async () =>
      (await cdp.evaluate(`document.querySelector('.hero__title')?.textContent ?? ''`)).includes('MCP')
    );
    const stepsText = await cdp.evaluate(`document.querySelector('.steps')?.textContent ?? ''`);
    record(
      '欢迎页三步状态渲染',
      stepsText.includes('已完成') && stepsText.includes('待完成'),
      stepsText.replace(/\s+/g, ' ').slice(0, 100)
    );

    await cdp.evaluate(`location.hash = '#/connect'; 'ok'`);
    await waitFor('接入向导渲染', async () =>
      (await cdp.evaluate(`document.querySelector('.code')?.textContent.length ?? 0`)) > 20
    );
    const connectText = await cdp.evaluate(`document.querySelector('.stack')?.textContent ?? ''`);
    record(
      '接入向导给出可复制配置',
      connectText.includes('Claude') && connectText.includes('mcpServers'),
      connectText.replace(/\s+/g, ' ').slice(0, 100)
    );

    // 业务本体论：按库维护 + 经网关送达 AI 客户端，两头都要验
    await cdp.evaluate(`location.hash = '#/ontology'; 'ok'`);
    await waitFor('本体论页渲染', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.entries tbody tr').length`)) > 0
    );
    // 显式选 app 库，避免依赖默认值
    await closeDropdowns(cdp);
    await cdp.evaluate(`document.querySelector('.picker .el-select input, .picker .el-select')?.click(); 'ok'`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cdp.evaluate(`(() => {
      const option = ${VISIBLE_OPTIONS}.find((item) => item.textContent.trim() === 'app');
      option?.click();
      return option ? 'ok' : 'missing';
    })()`);
    await waitFor('app 库条目渲染', async () =>
      (await cdp.evaluate(`document.querySelector('.entries')?.textContent ?? ''`)).includes('买家')
    );
    const appText = await cdp.evaluate(`document.querySelector('.entries').textContent`);
    record(
      '本体论页展示所选库的条目',
      appText.includes('买家') && appText.includes('客户') && !appText.includes('事件'),
      appText.replace(/\s+/g, ' ').slice(0, 100)
    );

    // 切到另一个库：条目必须整套换掉，不能串
    await closeDropdowns(cdp);
    await cdp.evaluate(`document.querySelector('.picker .el-select input, .picker .el-select')?.click(); 'ok'`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cdp.evaluate(`(() => {
      const option = ${VISIBLE_OPTIONS}.find((item) => item.textContent.trim() === 'analytics');
      option?.click();
      return option ? 'ok' : 'missing';
    })()`);
    await waitFor('切到 analytics 库后条目整套更换', async () => {
      const text = await cdp.evaluate(`document.querySelector('.entries')?.textContent ?? ''`);
      return text.includes('事件') && !text.includes('买家');
    });
    record('每个库有自己的一套本体论', true);

    // 指标在另一个标签页：切过去才能看到，顺带验标签切换
    await cdp.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.kind')].find((item) => item.textContent.includes('指标'));
      tab?.click();
      return 'ok';
    })()`);
    await waitFor('指标标签展示 GMV', async () =>
      (await cdp.evaluate(`document.querySelector('.entries')?.textContent ?? ''`)).includes('GMV')
    );
    const metricText = await cdp.evaluate(`document.querySelector('.entries').textContent`);
    record(
      '指标口径带计算式展示',
      metricText.includes('GMV') && metricText.includes('sum(amount)'),
      metricText.replace(/\s+/g, ' ').slice(0, 100)
    );

    // 关联表：下拉多选的候选来自当前库的 Schema。回到 app —— analytics 在前面被删掉后
    // 实例里已经没有它的表了，拿它验下拉会永远空
    // 先切回「术语」标签，再切库：切库会重置表单，顺序反了表单的类别会停在「指标」
    await cdp.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.kind')].find((item) => item.textContent.includes('术语'));
      tab?.click();
      return 'ok';
    })()`);
    await closeDropdowns(cdp);
    await cdp.evaluate(`document.querySelector('.picker .el-select input, .picker .el-select')?.click(); 'ok'`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cdp.evaluate(`(() => {
      const option = ${VISIBLE_OPTIONS}.find((item) => item.textContent.trim() === 'app');
      option?.click();
      return option ? 'ok' : 'missing';
    })()`);
    await waitFor('切回 app 库', async () =>
      (await cdp.evaluate(`document.querySelector('.entries')?.textContent ?? ''`)).includes('买家')
    );

    // 从 schema 起草：此刻 app 库的 users / orders 还没被任何概念覆盖，
    // orders.user_id → users.id 也没有关系条目，所以候选里必须有它们。
    // 这一步同时验证「按库过滤」与「已覆盖的表不再出现」在真实链路上成立。
    await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((item) => item.textContent.includes('从 schema 起草'));
      const button = panel?.querySelector('.panel__head button');
      button?.click();
      return button ? 'ok' : 'missing';
    })()`);
    await waitFor('起草候选出结果', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.proposal').length`)) > 0
    );
    const proposePanel = await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((item) => item.textContent.includes('从 schema 起草'));
      return panel ? panel.textContent : 'missing';
    })()`);
    record(
      '从 schema 起草列出未覆盖的表与外键',
      proposePanel.includes('app.main.users') &&
        proposePanel.includes('app.main.orders') &&
        proposePanel.includes('user_id'),
      proposePanel.replace(/\s+/g, ' ').slice(0, 140)
    );

    // 本体论页的库选择器必须真的决定「算哪个库」：起草 / 评测 / 编译 / 应用四个动作
    // 都要带上页面当前选中的库，而不是 Schema 页那一份（曾经取错过，选 A 算 B）。
    // 这里拦在 fetch 上看真实入参：面板文案可能因为候选为空而看不出差别。
    await cdp.evaluate(`(() => {
      const original = window.fetch;
      window.__ontologyCalls = [];
      window.fetch = (url, options) => {
        try {
          const body = JSON.parse(options?.body ?? '{}');
          if (String(body.method ?? '').startsWith('ontology.')) {
            window.__ontologyCalls.push({ method: body.method, params: body.params ?? null });
          }
        } catch {}
        return original(url, options);
      };
      window.__restoreFetch = () => {
        window.fetch = original;
      };
      return 'ok';
    })()`);
    await closeDropdowns(cdp);
    await cdp.evaluate(`document.querySelector('.picker .el-select input, .picker .el-select')?.click(); 'ok'`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cdp.evaluate(`(() => {
      const option = ${VISIBLE_OPTIONS}.find((item) => item.textContent.trim() === 'analytics');
      option?.click();
      return option ? 'ok' : 'missing';
    })()`);
    await waitFor('切到 analytics 库', async () =>
      (await cdp.evaluate(`document.querySelector('.entries')?.textContent ?? ''`)).includes('事件')
    );
    await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((item) => item.textContent.includes('从 schema 起草'));
      panel?.querySelector('.panel__head button')?.click();
      return 'ok';
    })()`);
    await waitFor('analytics 库起草请求发出', async () =>
      (await cdp.evaluate(
        `window.__ontologyCalls.filter((item) => item.method === 'ontology.propose').length`
      )) > 0
    );
    const proposeCall = await cdp.evaluate(
      `window.__ontologyCalls.filter((item) => item.method === 'ontology.propose').pop()`
    );
    record(
      '起草带上页面选中的库（不是 Schema 页那份）',
      proposeCall?.params?.database === 'analytics',
      `ontology.propose database=${proposeCall?.params?.database}`
    );
    await cdp.evaluate(`window.__restoreFetch(); 'ok'`);

    // 切回 app：后面的关联表候选、保存、体检用例都在 app 库上
    await closeDropdowns(cdp);
    await cdp.evaluate(`document.querySelector('.picker .el-select input, .picker .el-select')?.click(); 'ok'`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cdp.evaluate(`(() => {
      const option = ${VISIBLE_OPTIONS}.find((item) => item.textContent.trim() === 'app');
      option?.click();
      return option ? 'ok' : 'missing';
    })()`);
    await waitFor('切回 app 库继续后面的用例', async () =>
      (await cdp.evaluate(`document.querySelector('.entries')?.textContent ?? ''`)).includes('买家')
    );

    const tablesField = await cdp.evaluate(`(() => {
      const field = [...document.querySelectorAll('.form .field')]
        .find((item) => item.textContent.includes('关联表'));
      return field ? field.textContent : 'missing';
    })()`);
    // 提示语只报数量，具体表名在下拉里（下面两项分别验）
    record(
      '关联表候选来自当前库的 Schema',
      tablesField.includes('候选来自当前库的 Schema') && tablesField.includes('共 2 张表'),
      tablesField.replace(/\s+/g, ' ').slice(0, 120)
    );

    // 从下拉里连续勾两张表：多选必须是「累加」，不能后勾的顶掉先勾的
    await closeDropdowns(cdp);
    await cdp.evaluate(`(() => {
      const field = [...document.querySelectorAll('.form .field')]
        .find((item) => item.querySelector('.field__label')?.textContent.trim() === '关联表');
      field?.querySelector('input')?.click();
      return 'ok';
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const optionText = await cdp.evaluate(`(() => ${VISIBLE_OPTIONS}.map((item) => item.textContent.trim()).join(' | '))()`);
    record(
      '关联表下拉列出当前库的表',
      optionText.includes('users') && optionText.includes('orders'),
      optionText.slice(0, 120)
    );
    for (const table of ['users', 'orders']) {
      await cdp.evaluate(`(() => {
        const option = ${VISIBLE_OPTIONS}.find((item) => {
          const text = item.textContent.trim();
          // 候选值是规范形式，带 schema 前缀（sqlite 是 main.users）；两种写法都要认
          return text === '${table}' || text.endsWith('.${table}');
        });
        option?.click();
        return option ? 'ok' : 'missing';
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await closeDropdowns(cdp);
    const tagText = await cdp.evaluate(`(() => {
      const field = [...document.querySelectorAll('.form .field')]
        .find((item) => item.querySelector('.field__label')?.textContent.trim() === '关联表');
      return field?.textContent ?? '';
    })()`);
    record(
      '关联表多选累加写入表单',
      tagText.includes('users') && tagText.includes('orders'),
      tagText.replace(/\s+/g, ' ').slice(0, 120)
    );

    // 新增一条术语：按标签精确定位字段（表单里现在有多个下拉，靠文本包含会认错）
    await cdp.evaluate(`(() => {
      const field = [...document.querySelectorAll('.form .field')]
        .find((item) => item.querySelector('.field__label')?.textContent.trim() === '名称');
      const input = field?.querySelector('input');
      if (!input) return 'no-name-input';
      input.value = '会话';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await cdp.evaluate(`(() => {
      const field = [...document.querySelectorAll('.form .field')]
        .find((item) => item.querySelector('.field__label')?.textContent.trim() === '含义');
      const box = field?.querySelector('textarea');
      if (!box) return 'no-definition-input';
      box.value = '一次连续的访问，跨多个事件';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    // 值域是 P1 的结构化字段：它走的是 save → SQLite → render 这条完整链路，
    // 所以「预览里出现值域」能证明 payload 真的落库并参与渲染，而不只是填进了表单
    await cdp.evaluate(`(() => {
      const field = [...document.querySelectorAll('.form .field')]
        .find((item) => item.querySelector('.field__label')?.textContent.trim() === '值域');
      const box = field?.querySelector('textarea');
      if (!box) return 'no-values-input';
      box.value = 'paid=已支付';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.actions button')]
        .find((item) => item.textContent.trim() === '保存');
      button?.click();
      return 'ok';
    })()`);
    await waitFor('新术语进入列表与预览', async () => {
      const list = await cdp.evaluate(`document.querySelector('.entries')?.textContent ?? ''`);
      const preview = await cdp.evaluate(`document.querySelector('.rendered')?.textContent ?? ''`);
      return (
        list.includes('会话') &&
        preview.includes('会话') &&
        preview.includes('值域：paid(已支付)')
      );
    });
    record('新增术语同步到列表与预览（含结构化值域）', true);

    // 两张表都要跟着条目落库：只存一张说明多选在保存环节被截断了。
    // 同时锁住「规范形式」：落库的引用必须带库名与 schema，否则同一库的两个 schema
    // 各有一张同名表时，本体论就指不准是哪一张了（docs/ontology-next.md D1）
    const savedRow = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.entries tbody tr')]
        .find((item) => item.textContent.includes('会话'));
      return row ? row.textContent : 'missing';
    })()`);
    record(
      '多选的关联表全部落库且是规范形式',
      savedRow.includes('app.main.users') && savedRow.includes('app.main.orders'),
      savedRow.replace(/\s+/g, ' ').slice(0, 140)
    );

    // 一致性体检：条目和真实 schema 对账。
    // 这里刚好有个天然的腐烂样本——种子条目引用的是 customers / analytics 的表，
    // 而当前实例只有 app 库的 users / orders，所以「找不到」必须被查出来。
    // 体检面板不依赖实例在线也能跑，但在线时才查得出腐烂引用，这里验的就是在线那条路。
    await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((item) => item.textContent.includes('一致性体检'));
      const button = panel?.querySelector('.panel__head button');
      button?.click();
      return button ? 'ok' : 'missing';
    })()`);
    await waitFor('本体论体检出结果', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.issue').length`)) > 0
    );
    const lintPanel = await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((item) => item.textContent.includes('一致性体检'));
      return panel ? panel.textContent : 'missing';
    })()`);
    record(
      '本体论体检报出引用了不存在的表',
      lintPanel.includes('必须修') && lintPanel.includes('找不到'),
      lintPanel.replace(/\s+/g, ' ').slice(0, 140)
    );

    // 样例评测：结构与覆盖是确定性的，实例在跑所以查询也会真的执行一次。
    // 「会话」这条术语已经把 orders 讲过了，所以覆盖检查应当通过——这是正常路径，
    // 不是只验「面板能打开」。
    await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((item) => item.textContent.includes('样例评测'));
      const button = panel?.querySelector('.panel__head button');
      button?.click();
      return button ? 'ok' : 'missing';
    })()`);
    await waitFor('样例评测出结果', async () =>
      (await cdp.evaluate(`(() => {
        const panel = [...document.querySelectorAll('.panel')]
          .find((item) => item.textContent.includes('样例评测'));
        return panel ? panel.querySelectorAll('.issue').length : 0;
      })()`)) > 0
    );
    const evalPanel = await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((item) => item.textContent.includes('样例评测'));
      return panel ? panel.textContent : 'missing';
    })()`);
    record(
      '样例评测跑通结构与覆盖',
      evalPanel.includes('通过') && evalPanel.includes('看订单金额'),
      evalPanel.replace(/\s+/g, ' ').slice(0, 140)
    );

    // 强制规则编译：verify 工程没有配 grants，这条读筛选无处可挂，必须报成冲突而不是假装成功
    await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((item) => item.textContent.includes('强制规则'));
      const button = panel?.querySelector('.panel__head button');
      button?.click();
      return button ? 'ok' : 'missing';
    })()`);
    await waitFor('强制规则编译出结果', async () =>
      (await cdp.evaluate(`(() => {
        const panel = [...document.querySelectorAll('.panel')]
          .find((item) => item.textContent.includes('强制规则'));
        return panel ? panel.querySelectorAll('.issue').length : 0;
      })()`)) > 0
    );
    const rulesPanel = await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((item) => item.textContent.includes('强制规则'));
      return panel ? panel.textContent : 'missing';
    })()`);
    record(
      '强制规则编译报出无处可挂的冲突',
      rulesPanel.includes('冲突') && rulesPanel.includes('没有任何角色'),
      rulesPanel.replace(/\s+/g, ' ').slice(0, 140)
    );

    // 关键一段：以 AI 客户端的身份走网关，证明本体论真的送到了模型手里
    const secret = loadSecret(dataFile('jwt.secret'));
    const gatewayToken = signToken({ sub: '1', role: 'admin' }, secret, 300);
    const gatewayClient = makeGatewayClient(`http://127.0.0.1:${backend.port}`, gatewayToken);

    const handshake = await gatewayClient('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify-ui', version: '0.1.0' },
    });
    const instructions = handshake?.result?.instructions ?? '';
    record(
      '网关握手只下发目录（含硬约束）',
      instructions.includes('业务本体论（目录）') &&
        instructions.includes('库 app') &&
        // 强制规则必须出现在目录里：它决定答案会不会错
        instructions.includes('只看未作废') &&
        // 而条目正文不进握手——那是每次会话都要付的固定成本
        !instructions.includes('平台的付费主体'),
      instructions.replace(/\s+/g, ' ').slice(0, 160)
    );

    const listed = await gatewayClient('tools/list');
    const toolNames = (listed?.result?.tools ?? []).map((tool) => tool.name);
    record(
      '网关追加本体论工具且不丢上游工具',
      toolNames.includes('business_ontology') && toolNames.includes('query_catalog'),
      toolNames.join(', ')
    );

    const ontologyCall = await gatewayClient('tools/call', {
      name: 'business_ontology',
      arguments: {},
    });
    const ontologyText = ontologyCall?.result?.content?.[0]?.text ?? '';
    record(
      '本体论工具返回全部库的内容',
      ontologyText.includes('买家') && ontologyText.includes('事件'),
      ontologyText.replace(/\s+/g, ' ').slice(0, 120)
    );

    // 按库只取一节：别的库的内容不该出现
    const analyticsOnly = await gatewayClient('tools/call', {
      name: 'business_ontology',
      arguments: { database: 'analytics' },
    });
    const analyticsText = analyticsOnly?.result?.content?.[0]?.text ?? '';
    record(
      '本体论工具可按库取一节',
      analyticsText.includes('事件') && !analyticsText.includes('买家'),
      analyticsText.replace(/\s+/g, ' ').slice(0, 120)
    );

    // 检索与对象画像：模型不必拉全文也能拿到相关条目
    const searchCall = await gatewayClient('tools/call', {
      name: 'business_ontology',
      arguments: { query: '客户' },
    });
    const searchText = searchCall?.result?.content?.[0]?.text ?? '';
    const describeCall = await gatewayClient('tools/call', {
      name: 'describe_business_object',
      arguments: { name: '买家' },
    });
    const describeText = describeCall?.result?.content?.[0]?.text ?? '';
    record(
      '本体论可按说法检索并给出对象画像',
      searchText.includes('检索：客户') &&
        searchText.includes('命中理由') &&
        describeText.includes('业务对象：买家') &&
        describeText.includes('相关条目'),
      `${searchText.replace(/\s+/g, ' ').slice(0, 60)} ｜ ${describeText.replace(/\s+/g, ' ').slice(0, 60)}`
    );

    await cdp.evaluate(`location.hash = '#/'; 'ok'`);
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.hero__actions button')]
        .find((item) => item.textContent.includes('一键体验演示'));
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor(
      '演示项目启动',
      async () =>
        (await cdp.evaluate(`document.querySelector('.facts')?.textContent ?? ''`)).includes(
          'finance'
        )
    );
    const demoText = await cdp.evaluate(`document.querySelector('.facts').textContent`);
    record(
      '一键演示建好两个示例库与各库角色',
      demoText.includes('finance') &&
        demoText.includes('inventory') &&
        demoText.includes('finance_analyst') &&
        demoText.includes('inventory_viewer'),
      demoText.replace(/\s+/g, ' ').slice(0, 120)
    );

    // 离线读配置的完整验收：演示项目 dev.yml 里每个库各有一份真实 grants（角色 × 库）
    const demoStatus = await rpc('graphjin.status');
    const demoFile = await rpc('config.file', { projectDir: demoStatus.projectDir });
    const demoGrants = demoFile.sources.flatMap((item) => item.access?.grants ?? []);
    // 每个库两份 grant：本库角色给行过滤，另一个演示角色给「查不到任何行」的 filter
    const grantOf = (role, table) =>
      demoGrants.find(
        (grant) => grant.role === role && grant.tables.some((item) => item.name === table)
      );
    const financeHome = grantOf('finance_analyst', 'vouchers');
    const inventoryHome = grantOf('inventory_viewer', 'products');
    const financeDenied = grantOf('inventory_viewer', 'vouchers');
    const inventoryDenied = grantOf('finance_analyst', 'products');
    record(
      '离线读出的 grants 与演示配置一致（每库一个角色）',
      demoGrants.length === 4 &&
        financeHome?.tables.length === 5 &&
        inventoryHome?.tables.length === 7 &&
        financeHome.tables.every((table) => String(table.filter ?? '').includes('owner_code')) &&
        financeDenied?.tables.every((table) =>
          String(table.filter ?? '').includes('__not_granted__')
        ) &&
        inventoryDenied?.tables.every((table) =>
          String(table.filter ?? '').includes('__not_granted__')
        ),
      demoGrants
        .map((grant) => `${grant.role}:${grant.tables.length}表:${grant.tables[0]?.filter ?? ''}`)
        .join(' | ')
        .slice(0, 140)
    );

    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.includes('开始体检'));
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor('体检出结果', async () =>
      (await cdp.evaluate(`document.querySelectorAll('.checks .check').length`)) >= 5
    );
    const checkText = await cdp.evaluate(`document.querySelector('.checks').textContent`);
    record(
      '一键体检逐项出结果',
      checkText.includes('正常') && !checkText.includes('异常'),
      checkText.replace(/\s+/g, ' ').slice(0, 120)
    );

    // 在演示项目上走一遍使用向导的五个节点：连接 → 配权限 → 验证 → 讲清业务 → 接入 AI。
    // 向导本身的步骤、跳转、直达已有断言（上面），这里验的是「演示数据撑得住每一步」。
    await cdp.evaluate(`location.hash = '#/connections'; 'ok'`);
    await waitFor('演示连接落盘', async () =>
      (await cdp.evaluate(`document.querySelector('.conns')?.textContent ?? ''`)).includes(
        'finance'
      )
    );
    const demoConns = await cdp.evaluate(`document.querySelector('.conns').textContent`);
    record(
      '节点1 连接：两个演示库都进了已保存连接',
      demoConns.includes('finance') && demoConns.includes('inventory'),
      demoConns.replace(/\s+/g, ' ').slice(0, 100)
    );

    await cdp.evaluate(`location.hash = '#/permissions'; 'ok'`);
    await waitFor(
      '权限页按库分标签',
      async () => (await cdp.evaluate(`document.querySelectorAll('.db-tab').length`)) >= 2,
      15_000
    );
    const demoTabs = await cdp.evaluate(
      `[...document.querySelectorAll('.db-tab__name')].map((item) => item.textContent.trim()).join(',')`
    );
    record(
      '节点2 配权限：每个库一个标签',
      demoTabs.includes('finance') && demoTabs.includes('inventory'),
      demoTabs.slice(0, 80)
    );

    // 节点3 验证：真跑一次。finance_analyst 只能看到自己名下的行，admin 看到全部
    const demoBaseUrl = (await rpc('graphjin.status')).baseUrl;
    const analystVouchers = await rpc('graphql.execute', {
      baseUrl: demoBaseUrl,
      role: 'finance_analyst',
      userCode: 'hq',
      query: '{ vouchers(limit: 100) { id owner_code } }',
    });
    const adminVouchers = await rpc('graphql.execute', {
      baseUrl: demoBaseUrl,
      role: 'admin',
      query: '{ vouchers(limit: 100) { id owner_code } }',
    });
    const analystRows = analystVouchers?.data?.vouchers ?? [];
    const adminRows = adminVouchers?.data?.vouchers ?? [];
    record(
      '节点3 验证：行过滤真的少给了行',
      analystRows.length > 0 &&
        analystRows.every((row) => row.owner_code === 'hq') &&
        adminRows.length > analystRows.length,
      `finance_analyst(hq) ${analystRows.length} 行 · admin ${adminRows.length} 行`
    );
    // 角色 × 库：inventory_viewer 在财务库一行都看不到
    const wrongRole = await rpc('graphql.execute', {
      baseUrl: demoBaseUrl,
      role: 'inventory_viewer',
      userCode: 'hq',
      query: '{ vouchers(limit: 5) { id } }',
    });
    const wrongRows = wrongRole?.data?.vouchers ?? [];
    record(
      '节点3 验证：角色只在本库有 grant',
      Array.isArray(wrongRows) && wrongRows.length === 0,
      `inventory_viewer 查财务库 vouchers → ${wrongRows.length} 行`
    );
    // 反向：finance_analyst 在库存库也应当一行都看不到
    const wrongInventory = await rpc('graphql.execute', {
      baseUrl: demoBaseUrl,
      role: 'finance_analyst',
      userCode: 'hq',
      query: '{ products(limit: 5) { id } }',
    });
    const wrongInventoryRows = wrongInventory?.data?.products ?? [];
    record(
      '节点3 验证：换库即换身份（反向同样成立）',
      Array.isArray(wrongInventoryRows) && wrongInventoryRows.length === 0,
      `finance_analyst 查库存库 products → ${wrongInventoryRows.length} 行`
    );

    // 节点4 讲清业务：财务库能起草出还没被讲过的表
    const financePropose = await rpc('ontology.propose', { database: 'finance' });
    const financeProposeText = JSON.stringify(financePropose ?? '');
    record(
      '节点4 本体论：财务库能起草出未覆盖的表',
      financeProposeText.includes('finance') && financeProposeText.includes('vouchers'),
      financeProposeText.slice(0, 120)
    );

    // 节点5 接入 AI：演示项目同样能生成一份可直接粘贴的客户端配置
    const demoClientConfig = await rpc('mcp.clientConfig', { baseUrl: demoBaseUrl });
    record(
      '节点5 接入 AI：演示项目也能生成客户端配置',
      Boolean(demoClientConfig?.endpoint) && Boolean(demoClientConfig?.mcpServers),
      String(demoClientConfig?.endpoint ?? '').slice(0, 100)
    );

    // 「角色 → 库」配置项：没勾选的角色在本库必须一行都看不到。
    // 关键在「落到配置里」——直连 GraphJin 的客户端绕不过网关，但绕不过配置。
    const beforeBoundary = await rpc('permissions.databases');
    record(
      '角色库白名单默认未配置（不限制）',
      Array.isArray(beforeBoundary?.configured) && beforeBoundary.configured.length === 0,
      `configured=${JSON.stringify(beforeBoundary?.configured ?? [])}`
    );
    await rpc('permissions.setDatabaseRoles', { database: 'finance', roles: ['finance_analyst'] });
    const financeAccess = (demoFile.sources ?? []).find((source) => source.name === 'finance')?.access ?? {};
    const boundaryApplied = await rpc('permissions.apply', {
      baseUrl: demoBaseUrl,
      projectDir: demoStatus.projectDir,
      database: 'finance',
      access: financeAccess,
    });
    record(
      '应用权限时把未勾选的角色写成拒绝',
      boundaryApplied?.boundaryConfigured === true &&
        (boundaryApplied?.deniedRoles ?? []).includes('inventory_viewer'),
      `denied=${JSON.stringify(boundaryApplied?.deniedRoles ?? [])}`
    );
    const deniedQuery = await rpc('graphql.execute', {
      baseUrl: demoBaseUrl,
      role: 'inventory_viewer',
      userCode: 'hq',
      query: '{ vouchers(limit: 5) { id } }',
    });
    const deniedRows = deniedQuery?.data?.vouchers ?? [];
    record(
      '被拒角色在真实查询里拿不到行',
      Array.isArray(deniedRows) && deniedRows.length === 0,
      `${deniedRows.length} 行`
    );
    const allowedQuery = await rpc('graphql.execute', {
      baseUrl: demoBaseUrl,
      role: 'finance_analyst',
      userCode: 'hq',
      query: '{ vouchers(limit: 100) { id owner_code } }',
    });
    const allowedRows = allowedQuery?.data?.vouchers ?? [];
    record(
      '允许的角色不受影响',
      allowedRows.length > 0,
      `${allowedRows.length} 行`
    );
    await cdp.evaluate(`location.hash = '#/permissions'; 'ok'`);
    await waitFor('权限页出现可访问角色', async () =>
      (await cdp.evaluate(`document.body.textContent ?? ''`)).includes('可访问')
    );
    const accessRow = await cdp.evaluate(`(() => {
      const group = document.querySelector('.access-roles');
      return group ? group.textContent.replace(/\\s+/g, ' ').trim() : '';
    })()`);
    record(
      '权限页能勾选本库的可访问角色',
      accessRow.includes('finance_analyst') && accessRow.includes('inventory_viewer'),
      accessRow.slice(0, 80)
    );

    // 冷启动：刷新后没有任何页面帮忙加载 state，三张卡必须自己把判定依据补齐。
    // 只靠 onMounted 判断 isRunning 会输给 App.vue 的异步 refreshBackend，卡片会全变「待完成」。
    await cdp.evaluate(`location.hash = '#/'; 'ok'`);
    await cdp.evaluate(`location.reload(); 'ok'`);
    await waitFor('刷新后欢迎页重新渲染', async () =>
      (await cdp.evaluate(`document.querySelector('.hero__title')?.textContent ?? ''`)).includes('MCP')
    );
    const doneSteps = async () => {
      const text = await cdp.evaluate(`document.querySelector('.steps')?.textContent ?? ''`);
      return (text.match(/已完成/g) ?? []).length;
    };
    await waitFor('刷新后按真实数据回填三步状态', async () => (await doneSteps()) === 3);
    record('刷新后三步状态仍为已完成', (await doneSteps()) === 3, `${await doneSteps()} / 3`);

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
