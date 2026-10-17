'use strict';

const net = require('node:net');
const { spawn } = require('node:child_process');

/** GraphJin 启动失败或超时 */
class GraphJinProcessError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GraphJinProcessError';
    this.cause = cause;
  }
}

/** 去掉日志里的 ANSI 颜色码，启动横幅带颜色 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * 拉起并托管一个 `graphjin serve` 进程。
 *
 * 端口不能硬编码：GraphJin 会按 host_port 监听，demo 模式还会自选端口，
 * 所以这里从启动横幅 `host-port=0.0.0.0:8083` 里解析真实端口。
 */
class GraphJinProcess {
  /**
   * @param {Object} options
   * @param {string} options.binPath graphjin 可执行文件路径
   * @param {string} options.projectDir 项目目录（内含 dev.yml），作为 cwd 传给 --path
   * @param {Object} [options.env] 额外环境变量
   * @param {(code: number|null, signal: string|null) => void} [options.onUnexpectedExit]
   *        非主动停止导致的退出回调，供上层做崩溃重启
   */
  constructor({ binPath, projectDir, env = {}, onUnexpectedExit = null }) {
    if (!binPath) throw new Error('binPath 不能为空');
    if (!projectDir) throw new Error('projectDir 不能为空');
    this.binPath = binPath;
    this.projectDir = projectDir;
    this.env = env;
    this.onUnexpectedExit = onUnexpectedExit;
    this.child = null;
    this.port = null;
    this.logs = [];
    this.stopRequested = false;
  }

  get baseUrl() {
    return this.port === null ? null : `http://127.0.0.1:${this.port}`;
  }

  get isRunning() {
    return this.child !== null && this.child.exitCode === null;
  }

  /** 子进程 pid，崩溃复现与诊断用；未运行时为 null */
  get pid() {
    return this.child?.pid ?? null;
  }

  /**
   * 启动并等待服务就绪。
   *
   * @param {Object} [options]
   * @param {number} [options.timeoutMs] 就绪超时，默认 90s
   * @returns {Promise<string>} 形如 http://127.0.0.1:8083
   */
  async start({ timeoutMs = 90_000 } = {}) {
    if (this.isRunning) return this.baseUrl;

    this.stopRequested = false;
    this.logs = [];
    this.child = spawn(this.binPath, ['serve', '--path', this.projectDir], {
      cwd: this.projectDir,
      env: { ...process.env, ...this.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const collect = (chunk) => {
      const text = stripAnsi(chunk.toString());
      this.logs.push(text);
      const matched = /host-port=[\d.]+:(\d+)/.exec(text);
      if (matched) this.port = Number(matched[1]);
    };
    this.child.stdout.on('data', collect);
    this.child.stderr.on('data', collect);
    this.child.on('error', (error) => {
      this.logs.push(`spawn error: ${error.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.port = null;
      // 主动停止不算崩溃，不触发重启
      if (!this.stopRequested && this.onUnexpectedExit) this.onUnexpectedExit(code, signal);
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.port !== null && (await this.#probe())) return this.baseUrl;
      if (!this.isRunning) {
        throw new GraphJinProcessError(`GraphJin 提前退出，日志：\n${this.logs.join('')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new GraphJinProcessError(`GraphJin 在 ${timeoutMs}ms 内未就绪，日志：\n${this.logs.join('')}`);
  }

  /** MCP 端点能否响应，用作就绪探针 */
  async #probe() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 停止进程。先 TERM，宽限期后强杀 —— 未清理会导致下次启动时二进制文件被占用。
   *
   * @param {number} [graceMs] 宽限期，默认 3s
   */
  async stop({ graceMs = 3_000 } = {}) {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.port = null;
    this.stopRequested = true;

    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

/** 取一个空闲端口，供 dev.yml 的 host_port 使用 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

module.exports = { GraphJinProcess, GraphJinProcessError, pickFreePort, stripAnsi };
