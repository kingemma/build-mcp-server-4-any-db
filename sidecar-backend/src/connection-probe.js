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
 * 单条连接的自检。
 *
 * validate_config 必须由一个活着的 GraphJin 执行，所以服务没起来时这里临时建一个
 * 单库项目、拉起进程、验证完立刻停掉并删目录。已有启动实例时不要走这条路
 * （index.js 会复用现成服务），省一次进程启动。
 *
 * @param {Object} options
 * @param {string} options.name 连接名
 * @param {Object} options.connection dev.yml 形态的连接配置
 * @param {Function} [options.createProcess] 注入进程工厂，便于测试
 * @param {Function} [options.createService] 注入服务工厂，便于测试
 * @returns {Promise<Object>} validate_config 的结果；进程起不来时返回同样形态的失败结果
 */
async function probeConnection({ name, connection, createProcess = null, createService = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-probe-'));
  const projectDir = path.join(root, 'project');
  let probe = null;

  try {
    createProject({
      dir: projectDir,
      appName: 'Connection Probe',
      port: await pickFreePort(),
      sources: [{ name, ...connection }],
    });

    const binPath = resolveGraphJinBinary();
    probe = createProcess
      ? createProcess({ binPath, projectDir })
      : new GraphJinProcess({ binPath, projectDir, env: keystoreEnv() });

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
      sources: [{ name, kind: 'database', ...connection }],
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
