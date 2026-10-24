/**
 * MCP Server Build 主进程：起后端、注入端口、退出前停 GraphJin。
 *
 * @author Zhen (Evan) Wang <18901599114@163.com> — Tel / WeChat: +86 18901599114
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');

const ROOT = path.join(__dirname, '..');
const IS_DEV = !app.isPackaged;

/** 自绘标题栏高度：与 App.vue 里留出的顶部拖拽区保持一致 */
const TITLEBAR_HEIGHT = 40;

/** 产品名：还没打开项目时窗口标题只用它 */
const APP_TITLE = 'MCP Server Build';

/** 开发态渲染地址 */
const DEV_URL = process.env.MCP_BUILDER_DEV_URL || 'http://127.0.0.1:1420/';

/**
 * 导航前的探测节奏。
 *
 * Vite 刚监听端口时偶尔会先拒一次连接，而 Chromium 自带的错误页是一整片空白，
 * 用户分辨不出「还在编译」还是「已经挂了」，只能重开窗口。所以先探测再导航，
 * 探测不过就换成能读的说明页。
 */
const LOAD_RETRY_DELAYS_MS = [400, 800, 1600];

/** 窗口最晚可见时间：首帧迟迟不来也要把窗口露出来，别让它一直藏成「没启动」 */
const SHOW_FALLBACK_MS = 15_000;

let backend = null;
let mainWindow = null;
let isQuitting = false;

/**
 * 定位 GraphJin 二进制。
 *
 * 打包后随 extraResources 落到 `resources/binaries/`，开发态留在仓库根 `binaries/`。
 * 文件名统一按 Rust 三元组规则，直接复用 scripts/platforms.js，避免两处映射漂移。
 *
 * @returns {string} 可执行文件路径
 */
function resolveGraphJinBinary() {
  const { currentPlatformKey, sidecarFileName } = require('../scripts/platforms');
  const name = sidecarFileName(currentPlatformKey());
  const candidates = [
    path.join(process.resourcesPath ?? '', 'binaries', name),
    path.join(ROOT, 'binaries', name),
  ];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`找不到 GraphJin 二进制，已尝试：${candidates.join(', ')}`);
  return found;
}

/**
 * 在同一进程里起后端。
 *
 * 打包后安装目录只读，数据（用户库 / keystore / 自定义模板）一律落到 userData。
 *
 * @returns {Promise<{port: number, stop: () => Promise<void>}>}
 */
async function startBackend() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  process.env.MCP_BUILDER_DATA_DIR = dataDir;
  process.env.MCP_BUILDER_DB = path.join(dataDir, 'mcp-builder.db');
  process.env.GRAPHJIN_BIN = resolveGraphJinBinary();

  const { createBackend } = require(path.join(ROOT, 'sidecar-backend', 'src', 'index.js'));
  return createBackend({ dbPath: process.env.MCP_BUILDER_DB });
}

/** 加载过兜底页后不再捕获二次失败，否则会自己套娃 */
let isShowingFailurePage = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 探测渲染地址是否已经能响应。
 *
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function isReachable(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve((response.statusCode ?? 0) < 500);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

/**
 * 渲染层加载不出来时的兜底页面。
 *
 * 把地址、错误原因和该跑的命令直接画出来：默认白屏说不出任何信息，
 * 用户只能反复重开，也分不清是没编译完还是装坏了。
 *
 * @param {{url: string, reason: string}} failure
 * @returns {string} 完整 HTML
 */
function failurePageHtml({ url, reason }) {
  const hint = IS_DEV
    ? '开发态：先确认 Vite 已在运行（<code>npm run dev</code>），或用 <code>npm start</code> 一次拉起 Vite 与 Electron。'
    : '打包态：请重新执行 <code>npm run build</code> 后重新打包安装，并确认安装目录里的 <code>dist</code> 完整。';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>界面加载失败</title>
<style>
  html, body { height: 100%; margin: 0; background: #ffffff; }
  body {
    display: flex; flex-direction: column; gap: 12px;
    align-items: center; justify-content: center; padding: 32px;
    font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
    color: #10233d; text-align: center;
  }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  p { max-width: 640px; margin: 0; font-size: 13px; line-height: 1.8; color: #3a5573; }
  code { padding: 1px 5px; font-family: Consolas, monospace; font-size: 12px; background: #eef4fb; border-radius: 4px; }
  .detail { font-size: 12px; color: #5c7492; }
</style></head>
<body>
  <h1>界面没能加载</h1>
  <p>${hint}</p>
  <p class="detail">${url}<br />${reason}</p>
</body></html>`;
}

/**
 * 把窗口切到兜底页面。
 * @param {BrowserWindow} window
 * @param {{url: string, reason: string}} failure
 */
function showFailurePage(window, failure) {
  if (window.isDestroyed() || isShowingFailurePage) return;
  isShowingFailurePage = true;
  const html = failurePageHtml(failure);
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/**
 * 开发态先探测再导航。
 *
 * 直接 loadURL 到还没起来（或刚重启）的 Vite 会先画出空白错误页；探测通过再导航，
 * 拿到的第一个文档就是带首屏占位的 index.html。
 *
 * @param {BrowserWindow} window
 */
async function loadDevRenderer(window) {
  for (let attempt = 0; ; attempt += 1) {
    if (await isReachable(DEV_URL)) {
      if (!window.isDestroyed()) window.loadURL(DEV_URL);
      return;
    }
    if (attempt >= LOAD_RETRY_DELAYS_MS.length) {
      showFailurePage(window, { url: DEV_URL, reason: '连接被拒绝：开发服务器没有在监听' });
      return;
    }
    await delay(LOAD_RETRY_DELAYS_MS[attempt]);
  }
}

/**
 * @param {number} port 后端端口，注入给渲染进程
 * @returns {BrowserWindow}
 */
function createWindow(port) {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: APP_TITLE,
    // 任务栏 / 窗口标题栏图标；打包后的安装包图标由 build/icon.png 生成
    icon: path.join(__dirname, 'icon.png'),
    // 先不显示：等首帧就绪再 show，否则会先看到一块纯白
    show: false,
    // 与浅色主题一致，避免加载期先闪一块深色
    backgroundColor: '#ffffff',
    // 不要 File / Edit / View 这类系统菜单栏；同时挡掉 Alt 唤出隐藏菜单
    autoHideMenuBar: true,
    // Windows 去掉原生标题栏，改用系统自绘按钮（最小化 / 最大化 / 关闭），
    // 颜色跟主题走，且保留 Win11 的贴靠布局悬停
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#ffffff',
            symbolColor: '#3a5573',
            height: TITLEBAR_HEIGHT,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 端口走启动参数，preload 可以同步读到，前端不必等 IPC
      additionalArguments: [`--backend-port=${port}`],
    },
  });

  mainWindow = window;
  isShowingFailurePage = false;

  // 首帧就绪再显示：窗口一出现就有内容（index.html 里的首屏占位），不会先白一段
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });

  // 兜底：万一既没有首帧也没有加载失败，也不能让窗口一直藏着
  const showFallback = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  }, SHOW_FALLBACK_MS);

  window.on('closed', () => {
    clearTimeout(showFallback);
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 兜底之二：文档已经在加载了才失败（服务器中途挂掉），也要给出能读的说明
  window.webContents.on('did-fail-load', (...args) => {
    const [event, errorCode, errorDescription, validatedURL, isMainFrame] = args;
    const code = errorCode ?? event?.errorCode;
    // -3 = ERR_ABORTED：被新的导航打断（HMR 重载常见），不是真失败
    if (code === -3) return;
    if ((isMainFrame ?? event?.isMainFrame ?? true) === false) return;
    showFailurePage(window, {
      url: validatedURL ?? event?.validatedURL ?? DEV_URL,
      reason: `${errorDescription ?? event?.errorDescription ?? '加载失败'} (${code})`,
    });
  });

  if (IS_DEV) void loadDevRenderer(window);
  else window.loadFile(path.join(ROOT, 'dist', 'index.html'));

  // 菜单没了，Ctrl+Shift+I / F12 也跟着失效，开发态补一个
  if (IS_DEV) {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        window.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  return window;
}

/**
 * 渲染进程把当前项目名同步过来。
 *
 * Windows 用自绘标题栏，标题文字只能画在那条 40px 带上；macOS / Linux 走原生
 * 标题栏，setTitle 直接可见。没打开项目时回落到产品名。
 */
ipcMain.on('app:project-name', (_event, name) => {
  const project = typeof name === 'string' ? name.trim() : '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(project ? `${project} — ${APP_TITLE}` : APP_TITLE);
  }
});

app
  .whenReady()
  .then(async () => {
    // macOS 的系统菜单还提供复制 / 粘贴快捷键，只在 Windows / Linux 上整体移除
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

    backend = await startBackend();
    console.log(`后端已就绪: http://127.0.0.1:${backend.port}`);
    console.log(`数据目录: ${process.env.MCP_BUILDER_DATA_DIR}`);
    createWindow(backend.port);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(backend.port);
    });
  })
  .catch((error) => {
    console.error(`启动失败: ${error.stack ?? error.message}`);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 先停 GraphJin 再退出：子进程残留会锁住二进制，升级时替换失败
app.on('before-quit', (event) => {
  if (isQuitting || !backend) return;
  event.preventDefault();
  isQuitting = true;
  backend
    .stop()
    .catch((error) => console.error(`关闭后端失败: ${error.message}`))
    .finally(() => app.quit());
});
