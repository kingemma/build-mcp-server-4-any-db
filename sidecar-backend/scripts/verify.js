'use strict';

/**
 * 真机验证：对正在运行的 GraphJin 跑一遍方案 B 的读写链路。
 *
 * 用法：先起一个 legacy 模式（databases + 无 sources）的 GraphJin，再执行
 *   GRAPHJIN_BASE=http://127.0.0.1:8085 npm run verify
 */

const { GraphJinService } = require('../src/graphjin');
const { buildRoleTableConfig, summarizePatch } = require('../src/permissions');

const BASE_URL = process.env.GRAPHJIN_BASE || 'http://127.0.0.1:8085';
const DATABASE = process.env.GRAPHJIN_DATABASE || 'app';
const TABLE = process.env.GRAPHJIN_TABLE || 'accounts';

async function main() {
  const service = new GraphJinService({ baseUrl: BASE_URL, role: 'admin' });

  await service.connect();
  console.log(`[1/5] 已连接 ${BASE_URL}`);

  const tools = await service.listTools();
  console.log(`[2/5] 可用工具: ${tools.map((tool) => tool.name).join(', ')}`);

  const config = await service.assertLegacyMode();
  console.log(`[3/5] 配置形态校验通过（app_name=${config.metadata?.app_name ?? 'n/a'}）`);

  const matrix = {
    reviewer: {
      [TABLE]: {
        query: { enabled: true, limit: 5, filters: ['{ id: { _gt: 0 } }'] },
        insert: { enabled: false },
        update: { enabled: false },
        delete: { enabled: false },
      },
    },
  };
  const patch = buildRoleTableConfig(DATABASE, matrix);
  console.log(`[4/5] 待写入补丁: ${JSON.stringify(summarizePatch(patch))}`);

  const applied = await service.applyConfig(patch);
  console.log(`[5/5] 写入结果: success=${applied.success} changes=${JSON.stringify(applied.changes)}`);

  const roles = await service.readConfig('roles');
  console.log(`落盘后的 roles: ${JSON.stringify(roles.roles ?? roles, null, 2)}`);
}

main().catch((error) => {
  console.error(`验证失败: ${error.name}: ${error.message}`);
  if (error.payload) console.error(JSON.stringify(error.payload, null, 2));
  process.exit(1);
});
