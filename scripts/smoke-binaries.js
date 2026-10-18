#!/usr/bin/env node
'use strict';

/**
 * GraphJin 二进制冒烟。
 *
 * 下载 + sha256 只能证明文件完整，不能证明它能在目标平台跑起来。
 * 这个脚本真的执行一次 `graphjin version`，并核对版本号与 version.json 一致。
 * CI 在三平台各跑一次，用来补「非 Windows 二进制未实机验证」的缺口。
 *
 * 用法：
 *   node scripts/smoke-binaries.js                  # 当前平台
 *   node scripts/smoke-binaries.js --platform linux-amd64
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { PLATFORMS, sidecarFileName, currentPlatformKey } = require('./platforms');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'graphjin-binaries', 'version.json');
const BINARIES_DIR = path.join(ROOT, 'src-tauri', 'binaries');

function parseArgs(argv) {
  const args = { platform: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform') args.platform = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const platformKey = args.platform ?? currentPlatformKey();
  if (!PLATFORMS[platformKey]) throw new Error(`未知平台 ${platformKey}`);

  if (!fs.existsSync(MANIFEST)) {
    throw new Error(`缺少 ${MANIFEST}，请先准备 graphjin-binaries/`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const expected = String(manifest.version).replace(/^v/, '');

  const binary = path.join(BINARIES_DIR, sidecarFileName(platformKey));
  if (!fs.existsSync(binary)) {
    throw new Error(
      `找不到 ${binary}；请先运行 node scripts/prepare-binaries.js --platform ${platformKey}`
    );
  }
  const { size } = fs.statSync(binary);
  if (size < 10 * 1024 * 1024) {
    throw new Error(`${binary} 只有 ${(size / 1024 / 1024).toFixed(1)} MB，不像是完整的 GraphJin`);
  }

  let output;
  try {
    output = execFileSync(binary, ['version'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = [error.stderr, error.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`${platformKey} 无法执行 ${path.basename(binary)}：${detail || error.message}`);
  }

  const match = /GraphJin\s+v?([0-9][^\s]*)/i.exec(output);
  if (!match) {
    throw new Error(`${platformKey} 的 version 输出无法解析：${output.slice(0, 300)}`);
  }
  if (match[1] !== expected) {
    throw new Error(`${platformKey} 版本不匹配：期望 ${expected}，实际 ${match[1]}`);
  }

  console.log(
    `PASS  ${platformKey}  ${path.basename(binary)}  GraphJin ${match[1]}  ` +
      `${(size / 1024 / 1024).toFixed(1)} MB`
  );
}

try {
  main();
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  process.exit(1);
}
