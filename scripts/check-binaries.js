#!/usr/bin/env node
'use strict';

/**
 * 打包前校验：当前平台的 GraphJin sidecar 必须已经在 binaries/ 里。
 *
 * electron-builder 的 extraResources 只按 `graphjin-*` 通配打包，文件缺失不会报错，
 * 结果是一个能装、一启动就找不到二进制的空壳包。所以 dist:* 先跑这里。
 *
 * 用法：
 *   node scripts/check-binaries.js                  # 当前平台
 *   node scripts/check-binaries.js --platform linux-x64
 */

const fs = require('node:fs');
const path = require('node:path');

const { sidecarFileName, currentPlatformKey, PLATFORMS } = require('./platforms');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { platform: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform') args.platform = argv[++i];
  }
  return args;
}

function main() {
  const { platform } = parseArgs(process.argv.slice(2));
  const key = platform ?? currentPlatformKey();
  if (!PLATFORMS[key]) {
    console.error(`未知平台 ${key}，可选：${Object.keys(PLATFORMS).join(', ')}`);
    process.exit(1);
  }

  const file = path.join(ROOT, 'binaries', sidecarFileName(key));
  if (!fs.existsSync(file)) {
    console.error(
      `缺少 ${path.relative(ROOT, file).replace(/\\/g, '/')}：打包前先跑 ` +
        `npm run fetch:binaries 与 npm run prepare:binaries`
    );
    process.exit(1);
  }

  const { size } = fs.statSync(file);
  console.log(`binary ok: ${key} → ${path.relative(ROOT, file)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main();
