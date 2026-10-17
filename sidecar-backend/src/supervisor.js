'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { GraphJinProcess, pickFreePort } = require('./graphjin-process');
const { createProject, mergeProjectDatabases } = require('./project');
const { keystoreEnv } = require('./keystore');

/** 进程编排层的用法错误 */
class SupervisorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupervisorError';
  }
}

/**
 * 定位 GraphJin 可执行文件。
 *
 * 优先级：显式传入 > 环境变量 GRAPHJIN_BIN > 构建期产出的 src-tauri/binaries/<三元组>。
 *
 * @param {string|null} [explicit]
 * @returns {string} 二进制路径（不保证存在）
 */
function resolveGraphJinBinary(explicit = null) {
  if (explicit) return explicit;
  if (process.env.GRAPHJIN_BIN) return process.env.GRAPHJIN_BIN;

  // eslint-disable-next-line global-require
  const { currentPlatformKey, sidecarFileName } = require('../../scripts/platforms');
  return path.join(
    __dirname, '..', '..', 'src-tauri', 'binaries', sidecarFileName(currentPlatformKey())
  );
}

/**
 * GraphJin 服务编排：启动、停止、健康检查、崩溃自动重启。
 *
 * 只托管一个实例 —— 桌面端同一时刻只需要一个本地 GraphJin。
 */
class GraphJinSupervisor {
  /**
   * @param {Object} [options]
   * @param {string} [options.binPath] 缺省时按 resolveGraphJinBinary 解析
   * @param {Function} [options.createProcess] 注入进程工厂，便于测试
   * @param {Object} [options.env] 追加给 GraphJin 子进程的环境变量
   * @param {number} [options.maxRestarts] 重启窗口内允许的最大重启次数
   * @param {number} [options.restartWindowMs] 重启计数窗口
   */
  constructor({
    binPath = null,
    env = {},
    createProcess = null,
    maxRestarts = 3,
    restartWindowMs = 60_000,
  } = {}) {
    this.binPath = binPath;
    this.createProcess = createProcess;
    this.env = env;
    this.maxRestarts = maxRestarts;
    this.restartWindowMs = restartWindowMs;
    this.process = null;
    this.projectDir = null;
    this.startedAt = null;
    this.restartCount = 0;
    this.restartTimestamps = [];
    this.lastError = null;
  }

  #makeProcess() {
    const onUnexpectedExit = (code, signal) => this.#handleCrash(code, signal);
    const options = {
      binPath: resolveGraphJinBinary(this.binPath),
      projectDir: this.projectDir,
      // 不注入 keystore，带 password / connection_string 的库一律写入被拒（基线 §12.4）
      env: { ...keystoreEnv(), ...this.env },
      onUnexpectedExit,
    };
    return this.createProcess ? this.createProcess(options) : new GraphJinProcess(options);
  }

  /**
   * 启动服务。
   *
   * dev.yml 不存在时按传入的 databases 初始化一个；已存在时把 databases 合并进
   * 它的 `databases:` 段（保留 roles 等其余内容），所以第二次启动新加的库能生效。
   *
   * @param {Object} options
   * @param {string} options.projectDir
   * @param {Object} [options.databases] 库连接，形态同 project.js
   * @param {string} [options.appName]
   * @param {boolean} [options.webUi]
   * @returns {Promise<Object>} status()
   */
  async start({ projectDir, databases = null, appName = 'MCP Builder', webUi = false }) {
    if (!projectDir) throw new SupervisorError('projectDir 不能为空');
    if (this.process?.isRunning) return this.status();

    // 必须转绝对路径：--path 是相对 GraphJin 自己的 cwd 解析的，传相对路径会拼出
    // <dir>/<dir> 这个不存在的目录，GraphJin 静默回退到默认配置（端口 8080 + 内部库）
    const dir = path.resolve(projectDir);
    fs.mkdirSync(dir, { recursive: true });
    const devYaml = path.join(dir, 'dev.yml');
    if (!fs.existsSync(devYaml)) {
      if (!databases || Object.keys(databases).length === 0) {
        throw new SupervisorError('项目目录缺少 dev.yml，且未提供 databases，无法初始化项目');
      }
      createProject({ dir, appName, port: await pickFreePort(), databases, webUi });
    } else if (databases && Object.keys(databases).length > 0) {
      mergeProjectDatabases(devYaml, databases);
    }

    this.projectDir = dir;
    this.restartTimestamps = [];
    this.lastError = null;

    this.process = this.#makeProcess();
    await this.process.start();
    this.startedAt = new Date().toISOString();
    return this.status();
  }

  /** @returns {Promise<Object>} status() */
  async stop() {
    if (!this.process) return this.status();
    await this.process.stop();
    this.process = null;
    this.startedAt = null;
    return this.status();
  }

  /**
   * @returns {Object} 当前状态
   */
  status() {
    const running = Boolean(this.process?.isRunning);
    return {
      running,
      projectDir: this.projectDir,
      baseUrl: running ? this.process.baseUrl : null,
      port: running ? this.process.port : null,
      pid: running ? this.process.pid : null,
      startedAt: this.startedAt,
      restarts: this.restartCount,
      lastError: this.lastError,
    };
  }

  /**
   * 探活：向 MCP 端点发一条 tools/list，能响应即视为健康。
   *
   * @returns {Promise<Object>} status() 附加 healthy
   */
  async health() {
    const status = this.status();
    if (!status.running) {
      return { ...status, healthy: false, reason: '服务未运行' };
    }
    try {
      const response = await fetch(`${status.baseUrl}/api/v1/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      });
      return { ...status, healthy: response.ok, httpStatus: response.status };
    } catch (error) {
      return { ...status, healthy: false, reason: error.message };
    }
  }

  /** 崩溃回调：在窗口内累计次数，超限则放弃并记下原因 */
  #handleCrash(code, signal) {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((at) => now - at < this.restartWindowMs);

    if (this.restartTimestamps.length >= this.maxRestarts) {
      this.lastError = `崩溃过于频繁，已停止重启（exit=${code} signal=${signal ?? 'none'}）`;
      return;
    }

    this.restartTimestamps.push(now);
    this.restartCount += 1;
    this.#restart().catch((error) => {
      this.lastError = `重启失败：${error.message}`;
    });
  }

  async #restart() {
    this.process = this.#makeProcess();
    await this.process.start();
    this.startedAt = new Date().toISOString();
    this.lastError = null;
  }
}

module.exports = { GraphJinSupervisor, SupervisorError, resolveGraphJinBinary };
