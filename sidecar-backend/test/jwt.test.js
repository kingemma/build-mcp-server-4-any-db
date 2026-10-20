'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { JwtError, bearerToken, loadSecret, signToken, verifyToken } = require('../src/jwt');

const SECRET = 'test-secret-0123456789abcdef';

test('signToken / verifyToken: 往返一致', () => {
  const token = signToken({ sub: '7', role: 'customer', user_code: 'a@demo.local' }, SECRET, 60);
  const claims = verifyToken(token, SECRET);
  assert.equal(claims.sub, '7');
  assert.equal(claims.role, 'customer');
  assert.equal(claims.user_code, 'a@demo.local');
});

test('verifyToken: 密钥不对时拒绝', () => {
  const token = signToken({ sub: '7', role: 'customer' }, SECRET, 60);
  assert.throws(() => verifyToken(token, 'another-secret'), JwtError);
});

test('verifyToken: 载荷被改过时拒绝', () => {
  const token = signToken({ sub: '7', role: 'customer' }, SECRET, 60);
  const [header, , signature] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ sub: '7', role: 'admin', exp: 9_999_999_999 })).toString(
    'base64url'
  );
  assert.throws(() => verifyToken(`${header}.${forgedPayload}.${signature}`, SECRET), /签名校验失败/);
});

test('verifyToken: 过期后拒绝', () => {
  const token = signToken({ sub: '7', role: 'customer' }, SECRET, 60);
  const later = Date.now() + 61_000;
  assert.throws(() => verifyToken(token, SECRET, { now: later }), /已过期/);
});

test('verifyToken: 缺少 role 声明时拒绝', () => {
  const token = signToken({ sub: '7' }, SECRET, 60);
  assert.throws(() => verifyToken(token, SECRET), /缺少 role/);
});

test('verifyToken: 格式错误时拒绝', () => {
  assert.throws(() => verifyToken('not-a-token', SECRET), /格式不正确/);
  assert.throws(() => verifyToken('', SECRET), /缺少令牌/);
});

test('bearerToken: 只接受 Bearer 前缀', () => {
  assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerToken('bearer abc'), 'abc');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken(undefined), null);
});

test('loadSecret: 首次生成，之后复用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-secret-'));
  const file = path.join(dir, 'jwt.secret');
  try {
    const first = loadSecret(file);
    const second = loadSecret(file);
    assert.equal(first, second);
    assert.ok(first.length >= 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
