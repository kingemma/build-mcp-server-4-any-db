'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { GraphJinProcess, pickFreePort } = require('./graphjin-process');
const { createProject, ensureGatewayConfig, mergeProjectSources } = require('./project');
const { isLegacyConfig, migrateLegacyProject } = require('./migrate');
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
 * 优先级：显式传入 > 环境变量 GRAPHJIN_BIN > 构建期产出的 binaries/<三元组>。
 *
 * @param {string|null} [explicit]
 * @returns {string} 二进制路径（不保证存在）
 */
function resolveGraphJinBinary(explicit = null) {
  if (explicit) return explicit;
  if (process.env.GRAPHJIN_BIN) return process.env.GRAPHJIN_BIN;

  // eslint-disable-next-line global-require
  const { currentPlatformKey, sidecarFileName } = require('../../scripts/platforms');
  return path.join(__dirname, '..', '..', 'binaries', sidecarFileName(currentPlatformKey()));
}

/**
 * 把连接 map 转成 sources 数组。
 *
 * @param {Object} databases { name: conn }
 * @returns {Array<Object>}
 */
function toSources(databases) {
  return Object.entries(databases ?? {}).map(([name, conn]) => ({ name, ...conn }));
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
    migrate = null,
    maxRestarts = 3,
    restartWindowMs = 60_000,
  } = {}) {
    this.binPath = binPath;
    this.createProcess = createProcess;
    this.migrate = migrate ?? migrateLegacyProject;
    this.env = env;
    this.maxRestarts = maxRestarts;
    this.restartWindowMs = restartWindowMs;
    this.process = null;
    this.projectDir = null;
    this.startedAt = null;
    this.restartCount = 0;
    this.restartTimestamps = [];
    this.lastError = null;
    /** 最近一次 legacy → source 迁移的结果（成功或失败摘要） */
    this.migration = null;
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
   * dev.yml 不存在时按传入的连接初始化一个 source 模式项目；已存在时只合并
   * `sources:` 块里的连接字段（保留 access 等其余内容）。legacy 项目会先启动一个
   * 临时实例、通过配置 API 迁移成 source 模式，再按新配置重启。
   *
   * @param {Object} options
   * @param {string} options.projectDir
   * @param {Object} [options.databases] 库连接 { name: conn }，会渲染成 sources
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
    this.projectDir = dir;

    if (!fs.existsSync(devYaml)) {
      if (!databases || Object.keys(databases).length === 0) {
        throw new SupervisorError('项目目录缺少 dev.yml，且未提供 databases，无法初始化项目');
      }
      createProject({
        dir,
        appName,
        port: await pickFreePort(),
        sources: toSources(databases),
        webUi,
      });
    } else if (isLegacyConfig(fs.readFileSync(devYaml, 'utf8'))) {
      await this.#migrateLegacy(devYaml);
    } else if (databases && Object.keys(databases).length > 0) {
      mergeProjectSources(devYaml, databases);
    }
    // 老项目也要补上身份变量与回环绑定，否则网关和行过滤都不生效
    ensureGatewayConfig(devYaml);

    this.restartTimestamps = [];
    this.lastError = null;

    this.process = this.#makeProcess();
    await this.process.start();
    this.startedAt = new Date().toISOString();
    return this.status();
  }

  /**
   * 用临时 legacy 实例完成迁移；失败时恢复备份，避免项目卡在中间态。
   *
   * @param {string} devYaml
   * @returns {Promise<void>}
   */
  async #migrateLegacy(devYaml) {
    this.process = this.#makeProcess();
    await this.process.start();
    const baseUrl = this.process.baseUrl;

    try {
      const report = await this.migrate({ projectDir: this.projectDir, baseUrl });
      this.migration = { ok: true, ...report };
    } catch (error) {
      if (error.backup && fs.existsSync(error.backup)) {
        fs.copyFileSync(error.backup, devYaml);
      }
      this.migration = { ok: false, reason: error.message, backup: error.backup ?? null };
      throw new SupervisorError(`legacy 配置迁移失败：${error.message}`);
    } finally {
      await this.process.stop();
      this.process = null;
    }
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
   * 读当前项目的应用名，供桌面外壳显示窗口标题。
   *
   * 以 dev.yml 的 `app_name` 为准：用户可能手改过项目名，start 参数只是首次
   * 创建时的初值。进程停了也照读 —— 项目身份不随运行态消失。
   *
   * @returns {string|null}
   */
  #readAppName() {
    if (!this.projectDir) return null;
    try {
      const text = fs.readFileSync(path.join(this.projectDir, 'dev.yml'), 'utf8');
      const match = /^app_name:\s*(.+)$/m.exec(text);
      if (!match) return null;
      return match[1].trim().replace(/^["']|["']$/g, '');
    } catch {
      // 文件被删或读不了只影响标题，不该让 status 整个失败
      return null;
    }
  }

  /**
   * @returns {Object} 当前状态
   */
  status() {
    const running = Boolean(this.process?.isRunning);
    return {
      running,
      projectDir: this.projectDir,
      appName: this.#readAppName(),
      baseUrl: running ? this.process.baseUrl : null,
      port: running ? this.process.port : null,
      pid: running ? this.process.pid : null,
      startedAt: this.startedAt,
      restarts: this.restartCount,
      lastError: this.lastError,
      migration: this.migration,
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
