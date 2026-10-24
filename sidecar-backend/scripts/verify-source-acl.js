'use strict';

/**
 * 真机验证：跨库访问，以及能不能在 source 级限制「哪个角色能用这个库」。
 *
 * 结论进入 `docs/graphjin-3.21.14-baseline.md`；设计「库间访问控制」前先跑这个脚本，
 * 不要凭猜测写配置。
 *
 * 用法：
 *   GRAPHJIN_BIN=D:/.../graphjin.exe node scripts/verify-source-acl.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProject, replaceRolesBlock } = require('../src/project');
const { GraphJinProcess, pickFreePort } = require('../src/graphjin-process');
const { executeGraphql } = require('../src/graphql-http');
const { seedFinanceDatabase, seedInventoryDatabase, ROLE_BY_DATABASE } = require('../src/demo');

const BIN = process.env.GRAPHJIN_BIN;
if (!BIN) {
  console.error('请设置 GRAPHJIN_BIN 指向 graphjin 可执行文件');
  process.exit(2);
}

const checks = [];

/**
 * @param {string} name
 * @param {boolean} pass
 * @param {string} [detail]
 */
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** @param {Object} body GraphQL 响应 */
function rowsOf(body, root) {
  const rows = body?.data?.[root];
  return Array.isArray(rows) ? rows : [];
}

/**
 * 只给本库角色写列白名单，另一个演示角色不写 grant —— 这正是要测的「没写 grant」。
 *
 * @param {Object} [options]
 * @param {string} [options.denyFilter] 给外来角色在 finance.vouchers 上加一份 deny grant
 * @param {string[]} [options.denyColumns] deny grant 的列白名单
 */
function sources({ denyFilter, denyColumns = ['id', 'owner_code'] } = {}) {
  const foreignGrant = denyFilter
    ? {
        role: ROLE_BY_DATABASE.inventory,
        tables: [{ name: 'vouchers', columns: denyColumns, filter: denyFilter }],
      }
    : null;
  return [
    {
      name: 'finance',
      type: 'sqlite',
      path: 'finance.db',
      default: true,
      access: {
        read: 'authenticated',
        write: 'blocked',
        delete: 'blocked',
        grants: [
          {
            role: ROLE_BY_DATABASE.finance,
            tables: [{ name: 'vouchers', columns: ['id', 'owner_code'] }],
          },
          ...(foreignGrant ? [foreignGrant] : []),
        ],
      },
    },
    {
      name: 'inventory',
      type: 'sqlite',
      path: 'inventory.db',
      access: {
        read: 'authenticated',
        write: 'blocked',
        delete: 'blocked',
        grants: [
          {
            role: ROLE_BY_DATABASE.inventory,
            tables: [{ name: 'products', columns: ['id', 'owner_code'] }],
          },
        ],
      },
    },
  ];
}

/** 在 dev.yml 的 finance 源下插入一个字段，用来测 GraphJin 是否认识它 */
function injectFinanceField(dir, line) {
  const file = path.join(dir, 'dev.yml');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  // renderScalar 会给字符串加引号，别假设裸值
  const index = lines.findIndex(
    (item) => item.trim().startsWith('- name:') && /finance/.test(item)
  );
  if (index === -1) throw new Error('dev.yml 里找不到 finance 源');
  lines.splice(index + 1, 0, line);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

/**
 * @param {Object} options
 * @param {string} [options.extraField] 插到 finance 源下的额外配置行
 * @param {string} [options.denyFilter] 给外来角色在 finance.vouchers 上加的 deny filter
 * @param {string[]} [options.denyColumns]
 * @param {Function} fn
 */
async function withService({ extraField, denyFilter, denyColumns } = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphjin-acl-'));
  const port = await pickFreePort();
  const devYaml = createProject({
    dir,
    appName: 'ACL Probe',
    port,
    sources: sources({ denyFilter, denyColumns }),
  });
  // grants 里点名的角色必须先在 roles 里定义，否则 GraphJin 启动即 FATAL
  const withRoles = replaceRolesBlock(fs.readFileSync(devYaml, 'utf8'), [
    'admin',
    ROLE_BY_DATABASE.finance,
    ROLE_BY_DATABASE.inventory,
  ]);
  fs.writeFileSync(devYaml, withRoles, 'utf8');
  seedFinanceDatabase(dir);
  seedInventoryDatabase(dir);
  if (extraField) injectFinanceField(dir, extraField);

  const proc = new GraphJinProcess({ binPath: BIN, projectDir: dir });
  try {
    const baseUrl = await proc.start();
    return await fn({ baseUrl, dir });
  } finally {
    await proc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  // 1. 一个请求能不能同时查两个库？
  await withService({}, async ({ baseUrl }) => {
    const body = await executeGraphql(baseUrl, {
      role: 'admin',
      query: '{ vouchers(limit: 2) { id } products(limit: 2) { id } }',
    });
    const vouchers = rowsOf(body, 'vouchers');
    const products = rowsOf(body, 'products');
    record(
      '单请求可同时查两个库（跨库根字段共存）',
      vouchers.length > 0 && products.length > 0,
      `vouchers ${vouchers.length} 行 · products ${products.length} 行 · errors ${(body.errors ?? []).length}`
    );
  });

  // 2. 没写 grant 的角色在别的库是什么待遇？
  await withService({}, async ({ baseUrl }) => {
    const body = await executeGraphql(baseUrl, {
      role: ROLE_BY_DATABASE.inventory,
      userCode: 'hq',
      query: '{ vouchers(limit: 100) { id owner_code } }',
    });
    const rows = rowsOf(body, 'vouchers');
    record(
      '没写 grant 的角色仍能读别的库（权限反而更宽）',
      rows.length > 0,
      `inventory_viewer 查 finance.vouchers → ${rows.length} 行`
    );
  });

  // 3. source 级 allow_role 认不认？
  await withService(
    { extraField: `    allow_role: [${ROLE_BY_DATABASE.finance}]` },
    async ({ baseUrl }) => {
      const asForeign = await executeGraphql(baseUrl, {
        role: ROLE_BY_DATABASE.inventory,
        userCode: 'hq',
        query: '{ vouchers(limit: 100) { id owner_code } }',
      });
      const asHome = await executeGraphql(baseUrl, {
        role: ROLE_BY_DATABASE.finance,
        userCode: 'hq',
        query: '{ vouchers(limit: 100) { id owner_code } }',
      });
      const foreignRows = rowsOf(asForeign, 'vouchers');
      const homeRows = rowsOf(asHome, 'vouchers');
      record(
        'source 级 allow_role 生效（外来角色被挡）',
        foreignRows.length === 0,
        `allow_role=[finance_analyst]：inventory_viewer ${foreignRows.length} 行 · finance_analyst ${homeRows.length} 行`
      );
    }
  );

  // 4. deny filter 的通用写法：决定「任意表都能自动拒绝」还是只能挑文本列。
  //    结果直接影响编译期能不能自动为「角色 × 库」生成拒绝规则。
  const denyVariants = [
    { label: '文本列 _eq 哨兵值', filter: '{ owner_code: { _eq: "__not_granted__" } }' },
    { label: '数值列 _eq 字符串', filter: '{ id: { _eq: "__not_granted__" } }' },
    { label: '数值列 _in 空数组', filter: '{ id: { _in: [] } }' },
    { label: '文本列 _in 空数组', filter: '{ owner_code: { _in: [] } }' },
    { label: '引用不存在的列', filter: '{ nope: { _eq: 1 } }' },
  ];
  for (const variant of denyVariants) {
    try {
      await withService({ denyFilter: variant.filter }, async ({ baseUrl }) => {
        const body = await executeGraphql(baseUrl, {
          role: ROLE_BY_DATABASE.inventory,
          userCode: 'hq',
          query: '{ vouchers(limit: 100) { id owner_code } }',
        });
        const rows = rowsOf(body, 'vouchers');
        const errorText = (body.errors ?? [])
          .map((item) => String(item?.message ?? ''))
          .join(' / ')
          .slice(0, 90);
        record(
          `deny filter：${variant.label}`,
          rows.length === 0,
          `${rows.length} 行${errorText ? ` · 报错: ${errorText}` : ''}`
        );
      });
    } catch (error) {
      record(
        `deny filter：${variant.label}`,
        false,
        `配置/启动失败: ${String(error.message).slice(0, 80)}`
      );
    }
  }

  const failed = checks.filter((check) => !check.pass);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`验证异常: ${error.stack ?? error.message}`);
  process.exit(1);
});
