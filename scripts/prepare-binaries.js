#!/usr/bin/env node
'use strict';

/**
 * 构建期准备 sidecar 二进制。
 *
 * 从 graphjin-binaries/<version>/ 取出当前平台的 *.tar.gz，解压后重命名为
 * graphjin-<target-triple>[.exe] 放进仓库根 binaries/。
 *
 * 文件名带目标三元组后缀沿用自 Tauri sidecar 约定：多平台产物同名会互相覆盖，
 * 三元组后缀让三平台可以共存于同一目录。electron/main.js 与 supervisor 都按
 * scripts/platforms.js 的 sidecarFileName() 拼路径，改名时三处必须同步。
 *
 * 用法：
 *   node scripts/prepare-binaries.js                      # 当前平台
 *   node scripts/prepare-binaries.js --platform linux-arm64
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { assetName, sidecarFileName, currentPlatformKey, PLATFORMS } = require('./platforms');

const ROOT = path.join(__dirname, '..');
const BINARIES_DIR = path.join(ROOT, 'graphjin-binaries');
const TARGET_DIR = path.join(ROOT, 'binaries');

function parseArgs(argv) {
  const args = { platform: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform') args.platform = argv[++i];
  }
  return args;
}

/** 在解压目录里找到 graphjin 可执行文件 */
function findBinary(dir) {
  const candidates = ['graphjin.exe', 'graphjin'];
  for (const name of candidates) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  // 少数发布包会把二进制放在子目录里
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = findBinary(path.join(dir, entry.name));
    if (nested) return nested;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const platformKey = args.platform ?? currentPlatformKey();
  if (!PLATFORMS[platformKey]) throw new Error(`未知平台 ${platformKey}`);

  const versionFile = path.join(BINARIES_DIR, 'version.json');
  if (!fs.existsSync(versionFile)) {
    throw new Error('缺少 graphjin-binaries/version.json，请先运行 scripts/fetch-binaries.js');
  }
  const manifest = JSON.parse(fs.readFileSync(versionFile, 'utf8'));

  const archive = path.join(BINARIES_DIR, manifest.version, assetName(manifest.version, platformKey));
  if (!fs.existsSync(archive)) {
    throw new Error(
      `缺少 ${archive}，请先运行：node scripts/fetch-binaries.js --only ${platformKey}`
    );
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphjin-extract-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', extractDir], { stdio: 'pipe' });
    const binary = findBinary(extractDir);
    if (!binary) throw new Error(`${archive} 解压后未找到 graphjin 可执行文件`);

    fs.mkdirSync(TARGET_DIR, { recursive: true });
    const destination = path.join(TARGET_DIR, sidecarFileName(platformKey));
    fs.copyFileSync(binary, destination);
    if (os.platform() !== 'win32') fs.chmodSync(destination, 0o755);

    const { size } = fs.statSync(destination);
    console.log(`${platformKey}: ${archive} → ${destination} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

main();
