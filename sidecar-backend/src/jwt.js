'use strict';

/**
 * 本地 JWT 签发与校验（HS256）。
 *
 * 为什么需要它：GraphJin 的 legacy `roles[].tables` 模式实测不解析 JWT 里的角色
 * （见 sidecar-backend/scripts/verify-identity.js 的已知限制），所以角色不能交给
 * GraphJin 从 token 里读。这里的 token 只服务于「外部 MCP 客户端 → 平台网关」这一段：
 * 网关验签后把身份降级成回环上的 `X-User-Role` / `X-User-Code` 再转给 GraphJin。
 *
 * 密钥落在数据目录，首次使用时生成；桌面端没有中心密钥服务，容器内自签自验即可。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class JwtError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JwtError';
    /** 网关据此回 401，而不是 500 */
    this.status = 401;
  }
}

/**
 * 读取或创建签名密钥。
 *
 * @param {string} file 密钥文件路径
 * @returns {string} 十六进制密钥
 */
function loadSecret(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // 首次运行，落到下面生成
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * 签发令牌。
 *
 * @param {Object} claims 业务声明，约定含 sub / role / user_code
 * @param {string} secret 签名密钥
 * @param {number} [ttlSeconds] 有效期，默认 12 小时
 * @returns {string} JWT
 */
function signToken(claims, secret, ttlSeconds = 12 * 3600) {
  if (!secret) throw new JwtError('缺少签名密钥');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new JwtError('ttlSeconds 必须是正整数');

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + ttlSeconds, ...claims }));
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * 校验令牌：格式、签名、过期时间。
 *
 * @param {string} token JWT
 * @param {string} secret 签名密钥
 * @param {Object} [options]
 * @param {number} [options.now] 当前时间（毫秒），便于测试
 * @returns {Object} claims
 * @throws {JwtError} 任何一项不通过
 */
function verifyToken(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token === '') throw new JwtError('缺少令牌');
  if (!secret) throw new JwtError('缺少签名密钥');

  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('令牌格式不正确');

  const [header, payload, signature] = parts;
  let parsedHeader;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('令牌头无法解析');
  }
  if (parsedHeader?.alg !== 'HS256') throw new JwtError(`不支持的签名算法：${parsedHeader?.alg}`);

  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  // 长度不等时 timingSafeEqual 会抛错，先挡掉
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new JwtError('签名校验失败');
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('令牌载荷无法解析');
  }

  const nowSeconds = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number') throw new JwtError('令牌缺少过期时间');
  if (claims.exp <= nowSeconds) throw new JwtError('令牌已过期');
  if (!claims.role) throw new JwtError('令牌缺少 role 声明');

  return claims;
}

/** 从 Authorization 头里取 Bearer 令牌，取不到返回 null */
function bearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1].trim() : null;
}

module.exports = { JwtError, loadSecret, signToken, verifyToken, bearerToken };
