'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');

const ROOT = path.join(__dirname, '..');
const IS_DEV = !app.isPackaged;

let backend = null;
let isQuitting = false;

/**
 * 定位 GraphJin 二进制。
 *
 * 打包后随 extraResources 落到 `resources/binaries/`，开发态留在 `src-tauri/binaries/`。
 * 文件名统一按 Rust 三元组规则，直接复用 scripts/platforms.js，避免两处映射漂移。
 *
 * @returns {string} 可执行文件路径
 */
function resolveGraphJinBinary() {
  const { currentPlatformKey, sidecarFileName } = require('../scripts/platforms');
  const name = sidecarFileName(currentPlatformKey());
  const candidates = [
    path.join(process.resourcesPath ?? '', 'binaries', name),
    path.join(ROOT, 'src-tauri', 'binaries', name),
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
    title: 'MCP Builder',
    backgroundColor: '#0a0d10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 端口走启动参数，preload 可以同步读到，前端不必等 IPC
      additionalArguments: [`--backend-port=${port}`],
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (IS_DEV) window.loadURL(process.env.MCP_BUILDER_DEV_URL || 'http://127.0.0.1:1420');
  else window.loadFile(path.join(ROOT, 'dist', 'index.html'));

  return window;
}

app
  .whenReady()
  .then(async () => {
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
