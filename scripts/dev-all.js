#!/usr/bin/env node
'use strict';

/**
 * 一条命令拉起整个开发栈。
 *
 * 顺序：Vite 开发服务器 → 等 1420 就绪 → 等入口模块编译完 → Electron（Electron 主进程会再起 Node 后端）。
 * GraphJin 仍然由界面里的「启动」按钮按所选连接拉起，不在这个脚本里预启动。
 *
 * 用法：
 *   npm start
 *
 * 如果 1420 上已经有 Vite 在跑，会复用它；退出时只关闭本脚本启动的进程。
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const VITE_URL = 'http://127.0.0.1:1420/';
/** 入口模块：能编译它，说明依赖预构建也跑完了 */
const VITE_ENTRY_URL = `${VITE_URL}src/main.js`;
const IS_WIN = process.platform === 'win32';
/** 等端口 */
const VITE_TIMEOUT_MS = 60_000;
/** 等首次编译（冷缓存要先预构建 element-plus 这一大坨，给足预算） */
const ENTRY_TIMEOUT_MS = 240_000;

let vite = null;
let electron = null;
let stopping = false;

/** 用当前 npm 的 cli.js 启动子命令，避免 Windows 直接 spawn npm.cmd 的兼容问题 */
function npmSpawn(script, env = process.env) {
  const npmCli = process.env.npm_execpath;
  const base =
    npmCli && fs.existsSync(npmCli)
      ? { command: process.execPath, args: [npmCli] }
      : { command: IS_WIN ? 'npm.cmd' : 'npm', args: [], shell: IS_WIN };

  return spawn(base.command, [...base.args, 'run', script], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: base.shell === true,
    windowsHide: false,
  });
}

/** 结束整棵进程树：Windows 上 npm 会再拉 electron，只 kill 父进程会留孤儿 */
function killTree(child) {
  if (!child || !child.pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // 进程已经退出
  }
}

function isViteUp() {
  return new Promise((resolve) => {
    const request = http.get(VITE_URL, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode < 500);
    });
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

function waitForVite(timeoutMs = VITE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await isViteUp()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Vite 在 ${timeoutMs}ms 内未就绪`));
      setTimeout(poll, 300);
    };
    poll();
  });
}

/**
 * 单次 GET，返回状态码与响应体字节数；连不上返回 null。
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{status: number, bytes: number}|null>}
 */
function fetchOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, bytes }));
      response.on('error', () => resolve(null));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

/**
 * 等 Vite 真正能编译入口模块，返回耗时；超时返回 null。
 *
 * 只等 `/` 返回 200 是不够的：冷缓存首次启动时依赖还没预构建，Electron 一进来
 * 就要停在白屏里等 element-plus 那一坨编译完。请求入口模块会一直挂到预构建结束，
 * 所以这里拿到 200，就等于 Electron 加载时不必再等编译。
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<number|null>}
 */
async function waitForEntry(timeoutMs = ENTRY_TIMEOUT_MS) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let definitiveFailures = 0;

  while (Date.now() < deadline) {
    const result = await fetchOnce(VITE_ENTRY_URL, Math.max(deadline - Date.now(), 1000));
    if (result && result.status === 200 && result.bytes > 0) return Date.now() - started;
    // 超时（预构建还没跑完）继续等；连续拿到 4xx / 5xx 说明端口上不是我们的 Vite，别再耗
    if (result && result.status >= 400) {
      definitiveFailures += 1;
      if (definitiveFailures >= 3) return null;
    } else {
      definitiveFailures = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return null;
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (electron) killTree(electron);
  if (vite) killTree(vite);
  process.exit(code);
}

async function main() {
  // 先装信号处理：Vite 启动/等待期间按 Ctrl+C 也要把子进程带走
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  if (await isViteUp()) {
    console.log(`[dev-all] 复用已运行的 Vite：${VITE_URL}`);
  } else {
    console.log('[dev-all] 启动 Vite ...');
    vite = npmSpawn('dev');
    vite.on('exit', (code) => {
      if (stopping) return;
      console.error(`[dev-all] Vite 退出（code=${code}）`);
      shutdown(code ?? 1);
    });
  }

  await waitForVite();
  console.log(`[dev-all] Vite 端口已就绪：${VITE_URL}`);

  // 首帧要等 JS：先让 Vite 把入口模块和依赖编译完，窗口一出来就不至于白着等
  console.log('[dev-all] 等待入口模块编译（首次启动要预构建依赖，会慢一些）...');
  const warmupMs = await waitForEntry();
  if (warmupMs === null) {
    console.warn('[dev-all] 入口模块未在预算内就绪，仍然启动 Electron（界面连不上会给出提示页）');
  } else {
    console.log(`[dev-all] 入口模块已就绪（${Math.round(warmupMs / 100) / 10}s）`);
  }

  // DSH / 某些终端会带 ELECTRON_RUN_AS_NODE=1，这会让 Electron 以纯 Node 运行
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  console.log('[dev-all] 启动 Electron（内含 Node 后端）...');
  electron = npmSpawn('electron:dev', electronEnv);
  electron.on('exit', (code) => {
    if (stopping) return;
    console.log(`[dev-all] Electron 已退出（code=${code ?? 0}），关闭 Vite`);
    shutdown(code ?? 0);
  });
}

main().catch((error) => {
  console.error(`[dev-all] 启动失败：${error.message}`);
  shutdown(1);
});
