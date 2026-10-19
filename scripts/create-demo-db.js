#!/usr/bin/env node
'use strict';

/**
 * 创建一个可直接用于本地启动的演示 SQLite 库。
 *
 * 只用于「手头没有任何数据库」的场景；已有数据库请跳过。
 * 重复执行是幂等的：表用 IF NOT EXISTS，示例行用 INSERT OR IGNORE。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PROJECT_DIR = path.join(ROOT, 'projects', 'quickstart');
const DB_PATH = path.join(PROJECT_DIR, 'demo.db');

function main() {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        mrr_cents INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        amount_cents INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO accounts (id, name, plan, mrr_cents) VALUES
        (1, 'alpha', 'pro', 100),
        (2, 'beta', 'free', 0),
        (3, 'gamma', 'pro', 300);
      INSERT OR IGNORE INTO invoices (id, account_id, amount_cents) VALUES
        (1, 1, 100),
        (2, 3, 300);
    `);
  } finally {
    db.close();
  }

  console.log(`演示数据库：${DB_PATH}`);
  console.log('连接页填写：');
  console.log('  类型：SQLite');
  console.log(`  录入方式：文件路径 → ${path.relative(ROOT, DB_PATH)}`);
  console.log(`  项目目录：${path.relative(ROOT, PROJECT_DIR)}`);
}

main();
