'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * GraphJin 的 secret keystore。
 *
 * 实测：只要配置里出现 password 或 connection_string，写入就被拒
 * `secrets.keystore.key must be set ... GJ_SECRETS_KEYSTORE_KEY`（基线 §12.4），
 * 所以后端必须在拉起 GraphJin 时注入这个环境变量，否则带密码的库根本配不进去。
 *
 * key 必须持久化：换 key 会让已写入的加密 secret 解不开。
 *
 * 编码必须是 base64：实测传 hex（64 字符）时 GraphJin 报
 * `secrets.keystore.key must decode to 32 bytes for AES-256-GCM, got 48 bytes`
 * —— 说明它按 base64 解码后再校验长度。
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, 'keystore.key');

const KEY_BYTES = 32;

/** @param {string} value @returns {boolean} 解出来正好 32 字节才算可用 */
function isUsableKey(value) {
  return Buffer.from(value, 'base64').length === KEY_BYTES;
}

/**
 * 取（必要时生成）keystore key。
 *
 * @returns {string} base64 编码的 32 字节密钥
 */
function ensureKeystoreKey() {
  if (fs.existsSync(KEY_FILE)) {
    const existing = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (isUsableKey(existing)) return existing;
  }
  const key = crypto.randomBytes(KEY_BYTES).toString('base64');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, `${key}\n`, 'utf8');
  return key;
}

/**
 * 传给 GraphJin 子进程的环境变量。
 *
 * @returns {{GJ_SECRETS_KEYSTORE_KEY: string}}
 */
function keystoreEnv() {
  return { GJ_SECRETS_KEYSTORE_KEY: ensureKeystoreKey() };
}

module.exports = { ensureKeystoreKey, keystoreEnv, KEY_FILE };
