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
    let stoppedText = '';
    await waitFor('停止后连接列表回落', async () => {
      stoppedText = await cdp.evaluate(`document.querySelector('.conns')?.textContent ?? ''`);
      return stoppedText.includes('已测试');
    });
    record(
      '停止后连接状态回落为已测试',
      stoppedText.includes('已测试') && !stoppedText.includes('已连接'),
      stoppedText.includes('已连接') ? '仍显示已连接' : ''
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
        const option = ${VISIBLE_OPTIONS}.find((item) => item.textContent.trim() === '${table}');
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
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.actions button')]
        .find((item) => item.textContent.trim() === '保存');
      button?.click();
      return 'ok';
    })()`);
    await waitFor('新术语进入列表与预览', async () => {
      const list = await cdp.evaluate(`document.querySelector('.entries')?.textContent ?? ''`);
      const preview = await cdp.evaluate(`document.querySelector('.rendered')?.textContent ?? ''`);
      return list.includes('会话') && preview.includes('会话');
    });
    record('新增术语同步到列表与预览', true);

    // 两张表都要跟着条目落库：只存一张说明多选在保存环节被截断了
    const savedRow = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.entries tbody tr')]
        .find((item) => item.textContent.includes('会话'));
      return row ? row.textContent : 'missing';
    })()`);
    record(
      '多选的关联表全部落库',
      savedRow.includes('users') && savedRow.includes('orders'),
      savedRow.replace(/\s+/g, ' ').slice(0, 140)
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
      '网关握手即下发业务语境',
      instructions.includes('业务本体论') && instructions.includes('买家') && instructions.includes('事件'),
      instructions.replace(/\s+/g, ' ').slice(0, 120)
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

    await cdp.evaluate(`location.hash = '#/'; 'ok'`);
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.hero__actions button')]
        .find((item) => item.textContent.includes('一键体验演示'));
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    await waitFor('演示项目启动', async () =>
      (await cdp.evaluate(`document.querySelector('.facts')?.textContent ?? ''`)).includes('orders')
    );
    const demoText = await cdp.evaluate(`document.querySelector('.facts').textContent`);
    record(
      '一键演示建好示例项目',
      demoText.includes('analyst') && demoText.includes('orders'),
      demoText.replace(/\s+/g, ' ').slice(0, 100)
    );

    // 离线读配置的完整验收：演示项目 dev.yml 里有一份真实的 analyst grants
    const demoStatus = await rpc('graphjin.status');
    const demoFile = await rpc('config.file', { projectDir: demoStatus.projectDir });
    const demoGrants = demoFile.sources.flatMap((item) => item.access?.grants ?? []);
    record(
      '离线读出的 grants 与演示配置一致',
      demoGrants.length === 1 &&
        demoGrants[0].role === 'analyst' &&
        demoGrants[0].tables.length === 2,
      demoGrants.map((grant) => `${grant.role}:${grant.tables.map((table) => table.name).join('+')}`).join(',')
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
