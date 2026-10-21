#!/usr/bin/env node
'use strict';

/**
 * 一键演示项目：示例表 + 数据 + 预配只读角色（带行过滤）。
 *
 * 演示的价值在于「不碰自己的库就能看到权限生效」：orders / customers 都带
 * owner_code，analyst 只能看到自己名下的行，写删一律 blocked —— 打开权限矩阵
 * 就能看到这套规则，不用用户自己配。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createProject, replaceRolesBlock } = require('./project');

const DEMO_DATABASE = 'orders.db';

/** 演示角色：只读 + 行过滤；写 / 删在 source 级就被挡住 */
const DEMO_ROLE = 'analyst';
const DEMO_FILTER = '{ owner_code: { _eq: $user_code } }';

/**
 * 写出演示库：两张表 + 若干行数据，owner_code 决定谁能看见哪几行。
 *
 * @param {string} dir 项目目录
 * @returns {string} 数据库文件绝对路径
 */
function seedDemoDatabase(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, DEMO_DATABASE);
  if (fs.existsSync(dbFile)) fs.rmSync(dbFile);

  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        owner_code TEXT NOT NULL,
        tier TEXT NOT NULL
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        owner_code TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const customers = [
      [1, 'Acme Foods', 'acme', 'gold'],
      [2, 'Beacon Health', 'beacon', 'silver'],
      [3, 'Cobalt Studio', 'cobalt', 'bronze'],
    ];
    const insertCustomer = db.prepare(
      'INSERT INTO customers (id, name, owner_code, tier) VALUES (?, ?, ?, ?)'
    );
    for (const row of customers) insertCustomer.run(...row);

    const orders = [
      [1, 1, 'acme', 1280.5, 'paid', '2026-09-02'],
      [2, 1, 'acme', 320.0, 'paid', '2026-09-18'],
      [3, 2, 'beacon', 890.25, 'pending', '2026-10-01'],
      [4, 2, 'beacon', 1450.0, 'paid', '2026-10-05'],
      [5, 3, 'cobalt', 75.9, 'paid', '2026-10-11'],
      [6, 3, 'cobalt', 260.4, 'pending', '2026-10-19'],
    ];
    const insertOrder = db.prepare(
      'INSERT INTO orders (id, customer_id, owner_code, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const row of orders) insertOrder.run(...row);
  } finally {
    db.close();
  }
  return dbFile;
}

/**
 * 创建（或重建）演示项目：写 dev.yml、种数据、预配 analyst 只读角色。
 *
 * @param {Object} options
 * @param {string} options.dir 项目目录
 * @param {string} [options.appName]
 * @param {number} options.port 监听端口
 * @returns {Object} { devYaml, databases, roles, tables }
 */
function createDemoProject({ dir, appName = 'Demo Orders', port }) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('port 必须是正整数');
  }
  seedDemoDatabase(dir);

  const devYaml = createProject({
    dir,
    appName,
    port,
    sources: [
      {
        name: 'demo',
        type: 'sqlite',
        path: DEMO_DATABASE,
        default: true,
        access: {
          read: 'authenticated',
          // 演示是只读的：写 / 删在 source 级就被挡住，任何人都写不动
          write: 'blocked',
          delete: 'blocked',
          grants: [
            {
              role: DEMO_ROLE,
              tables: [
                {
                  name: 'orders',
                  columns: ['id', 'customer_id', 'owner_code', 'amount', 'status', 'created_at'],
                  filter: DEMO_FILTER,
                },
                {
                  name: 'customers',
                  columns: ['id', 'name', 'owner_code', 'tier'],
                  filter: DEMO_FILTER,
                },
              ],
            },
          ],
        },
      },
    ],
  });

  // roles 段单独写：admin 保证启动不被拒，analyst 进入矩阵可编辑
  const text = replaceRolesBlock(fs.readFileSync(devYaml, 'utf8'), ['admin', DEMO_ROLE]);
  fs.writeFileSync(devYaml, text, 'utf8');

  return {
    devYaml,
    databases: ['demo'],
    roles: ['admin', DEMO_ROLE],
    tables: ['orders', 'customers'],
  };
}

module.exports = { DEMO_ROLE, DEMO_FILTER, seedDemoDatabase, createDemoProject };

