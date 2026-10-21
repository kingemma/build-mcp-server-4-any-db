'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProject } = require('./project');
const { GraphJinProcess, pickFreePort } = require('./graphjin-process');
const { GraphJinService } = require('./graphjin');
const { resolveGraphJinBinary } = require('./supervisor');
const { keystoreEnv } = require('./keystore');

/**
 * 相对路径的库文件按连接所属的项目目录解析成绝对路径。
 *
 * 临时实例的工作目录是自己的临时目录，直接拿相对路径过去，GraphJin 会在那里
 * 新建一个空库：连得上但一张表都没有，validate_config 以
 * "schema discovery found no tables" 收尾，把好连接误判成坏连接。
 *
 * @param {Object} connection dev.yml 形态的连接配置
 * @param {string|null} projectDir 连接所属的项目目录
 * @returns {Object} 需要时替换 path 后的新配置
 */
function resolveDatabasePath(connection, projectDir) {
  const file = connection?.path;
  if (!projectDir || typeof file !== 'string' || file === '' || path.isAbsolute(file)) {
    return connection;
  }
  return { ...connection, path: path.resolve(projectDir, file) };
}

/**
 * 单条连接的自检。
 *
 * validate_config 必须由一个活着的 GraphJin 执行，所以服务没起来时这里临时建一个
 * 单库项目、拉起进程、验证完立刻停掉并删目录。已有启动实例时不要走这条路
 * （index.js 会复用现成服务），省一次进程启动。
 *
 * @param {Object} options
 * @param {string} options.name 连接名
 * @param {Object} options.connection dev.yml 形态的连接配置
 * @param {string} [options.projectDir] 连接所属项目目录，用于解析相对路径的库文件
 * @param {Function} [options.createProcess] 注入进程工厂，便于测试
 * @param {Function} [options.createService] 注入服务工厂，便于测试
 * @returns {Promise<Object>} validate_config 的结果；进程起不来时返回同样形态的失败结果
 */
async function probeConnection({
  name,
  connection,
  projectDir = null,
  createProcess = null,
  createService = null,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-probe-'));
  const probeDir = path.join(root, 'project');
  const resolved = resolveDatabasePath(connection, projectDir);
  let probe = null;

  try {
    createProject({
      dir: probeDir,
      appName: 'Connection Probe',
      port: await pickFreePort(),
      sources: [{ name, ...resolved }],
    });

    const binPath = resolveGraphJinBinary();
    probe = createProcess
      ? createProcess({ binPath, projectDir: probeDir })
      : new GraphJinProcess({ binPath, projectDir: probeDir, env: keystoreEnv() });

    try {
      await probe.start();
    } catch (error) {
      // 起不来说明配置本身有问题，转成 validate_config 同形态的结果，别让上层当成服务故障
      return { success: false, errors: [error.message] };
    }

    const service = createService
      ? createService({ baseUrl: probe.baseUrl, role: 'admin' })
      : new GraphJinService({ baseUrl: probe.baseUrl, role: 'admin' });
    await service.connect();
    return await service.mcp.callTool('validate_config', {
      sources: [{ name, kind: 'database', ...resolved }],
    });
  } finally {
    if (probe) {
      try {
        await probe.stop();
      } catch (error) {
        console.error(`[probe] 临时 GraphJin 停止失败: ${error.message}`);
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      // Windows 上进程刚退出时文件可能还被占用，删不掉就留给系统临时目录
      console.error(`[probe] 清理临时目录失败 ${root}: ${error.message}`);
    }
  }
}

module.exports = { probeConnection };
