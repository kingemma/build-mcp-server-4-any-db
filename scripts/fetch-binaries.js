#!/usr/bin/env node
'use strict';

/**
 * 拉取 GraphJin 官方二进制并校验。
 *
 * 只保存压缩态 *.tar.gz（各 42–48 MB）；解压后的单个二进制约 158.6 MiB，
 * 全平台近 800 MB，不适合入库。构建期再由 prepare-binaries.js 解压重命名。
 *
 * 用法：
 *   node scripts/fetch-binaries.js                    # 拉取全部平台
 *   node scripts/fetch-binaries.js --only windows-amd64
 *   node scripts/fetch-binaries.js --force            # 忽略已存在的文件
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const execFileAsync = promisify(execFile);
// Windows 上 execFile 不会自动补 PATHEXT，必须写全 curl.exe
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';

const { PLATFORMS, assetName } = require('./platforms');

const REPO = 'dosco/graphjin';
const BINARIES_DIR = path.join(__dirname, '..', 'graphjin-binaries');
const VERSION_FILE = path.join(BINARIES_DIR, 'version.json');
const CONCURRENCY = 3;

function parseArgs(argv) {
  const args = { only: null, force: false, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') args.only = argv[++i];
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--version') args.version = argv[++i];
  }
  return args;
}

function readVersionFile() {
  if (!fs.existsSync(VERSION_FILE)) return null;
  return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
}

/** release 资产的约定下载地址；API 不可用时的兜底 */
function releaseDownloadUrl(version, asset) {
  return `https://github.com/${REPO}/releases/download/${version}/${asset}`;
}

/**
 * 从 GitHub Releases API 拉资产清单，用于确认产物真实存在。
 *
 * API 失败时返回 null —— 未鉴权调用有 60 次/小时的限制，且本机到 GitHub 的
 * 连接偶发被重置，不能让一次 API 抖动就中断整个下载。
 *
 * @param {string} version 形如 v3.21.14
 * @returns {Promise<Map<string, {name: string, url: string, size: number}>|null>}
 */
async function fetchReleaseAssets(version) {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${version}`, {
      headers: { 'User-Agent': 'mcp-builder-fetch', Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      console.warn(`  查询 release 失败：HTTP ${response.status}，改用约定地址`);
      return null;
    }
    const release = await response.json();
    const assets = new Map();
    for (const asset of release.assets ?? []) {
      assets.set(asset.name, { name: asset.name, url: asset.browser_download_url, size: asset.size });
    }
    return assets;
  } catch (error) {
    console.warn(`  查询 release 异常（${error.message}），改用约定地址`);
    return null;
  }
}

/** 用 curl 取回文本内容 @param {string} url @returns {Promise<string>} */
async function downloadText(url) {
  const { stdout } = await execFileAsync(
    CURL_BIN,
    ['-sS', '-L', '--connect-timeout', '30', '--max-time', '120', url],
    { maxBuffer: 8 << 20 }
  );
  return stdout;
}

/**
 * 下载 checksums.txt 并解析成 文件名 → sha256。
 *
 * @param {Map<string, object>} releaseAssets
 * @param {string} version
 * @returns {Promise<Map<string, string>>}
 */
async function fetchChecksums(releaseAssets, version) {
  const url = releaseAssets?.get('checksums.txt')?.url ?? releaseDownloadUrl(version, 'checksums.txt');
  const text = await downloadText(url);

  const checksums = new Map();
  for (const line of text.split('\n')) {
    const matched = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (matched) checksums.set(matched[2], matched[1]);
  }
  return checksums;
}

/** @param {string} file @returns {Promise<string>} 文件 SHA256 */
async function sha256OfFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** 单次 curl 尝试的时间上限；配合续传循环，避免一次超时就前功尽弃 */
const CURL_MAX_TIME_SECONDS = 300;
const MAX_RESUME_ATTEMPTS = 60;

/**
 * 查询远端文件大小，用于判断续传是否已完成。
 *
 * @param {string} url
 * @returns {Promise<number>} 字节数，取不到时返回 0
 */
async function contentLengthOf(url) {
  const { stdout } = await execFileAsync(
    CURL_BIN,
    ['-sSI', '-L', '--connect-timeout', '30', '--max-time', '60', url],
    { maxBuffer: 1 << 20 }
  );
  // -L 会打印多段响应头（302 的 Content-Length 是 0），必须取最后一段
  const matched = [...stdout.matchAll(/content-length:\s*(\d+)/gi)];
  return matched.length > 0 ? Number(matched[matched.length - 1][1]) : 0;
}

/**
 * 用 curl 下载，带断点续传。
 *
 * 首选 curl 而不是 fetch：实测本机 Node 的 fetch 拉取 40 MB 以上的分发包时
 * 会在传输中途被重置（ECONNRESET）。另外到 GitHub Releases 的实测带宽只有 ~25 KB/s，
 * 单个包要半小时以上，所以必须支持续传，否则一次超时就得从头再来。
 *
 * @param {string} url
 * @param {string} destination
 */
async function downloadWithCurl(url, destination) {
  const total = await contentLengthOf(url);

  for (let attempt = 1; attempt <= MAX_RESUME_ATTEMPTS; attempt += 1) {
    const current = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
    if (total > 0 && current >= total) return;

    try {
      await execFileAsync(
        CURL_BIN,
        [
          '-sS', '-L',
          '--connect-timeout', '30',
          '--max-time', String(CURL_MAX_TIME_SECONDS),
          '-C', '-',
          '-o', destination,
          url,
        ],
        { maxBuffer: 1 << 20 }
      );
      const got = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
      if (total === 0 || got >= total) return;
    } catch (error) {
      const got = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
      // curl 用 -C - 续传时，文件下完再请求会返回 416，这里按大小判定为完成
      if (total > 0 && got >= total) return;
      if (attempt === MAX_RESUME_ATTEMPTS) throw error;
      console.log(`      第 ${attempt} 次中断（已 ${(got / 1024 / 1024).toFixed(1)} MB），继续续传`);
    }
  }
}

/** @param {string} url @param {string} destination */
async function downloadWithFetch(url, destination) {
  const response = await fetch(url, { headers: { 'User-Agent': 'mcp-builder-fetch' } });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}: ${url}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

/**
 * 下载单个文件并计算 SHA256。curl 不可用时回退到 fetch。
 *
 * @param {string} url
 * @param {string} destination
 * @returns {Promise<{sha256: string, size: number}>}
 */
async function download(url, destination) {
  try {
    await downloadWithCurl(url, destination);
  } catch (error) {
    // 只有 curl 不存在时才回退；curl 存在但下载失败就让它抛出
    if (error?.code === 'ENOENT') {
      console.log(`      未找到 ${CURL_BIN}，回退到 fetch 下载`);
      await downloadWithFetch(url, destination);
    } else {
      throw error;
    }
  }
  return { sha256: await sha256OfFile(destination), size: fs.statSync(destination).size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const existing = readVersionFile();
  const version = args.version ?? existing?.version;
  if (!version) {
    console.error('未指定版本：请传 --version v3.21.14，或在 graphjin-binaries/version.json 中维护');
    process.exit(2);
  }

  const keys = args.only ? [args.only] : Object.keys(PLATFORMS);
  for (const key of keys) {
    if (!PLATFORMS[key]) throw new Error(`未知平台 ${key}`);
  }

  const releaseAssets = await fetchReleaseAssets(version);
  const checksums = await fetchChecksums(releaseAssets, version);
  console.log(`release ${version}：${releaseAssets ? `${releaseAssets.size} 个资产` : 'API 不可用'}，checksums ${checksums.size} 条`);

  const targetDir = path.join(BINARIES_DIR, version);
  fs.mkdirSync(targetDir, { recursive: true });

  const record = existing?.version === version && existing.platforms ? existing.platforms : {};
  const queue = [...keys];
  let failures = 0;

  async function processOne(key) {
    const asset = assetName(version, key);
    const destination = path.join(targetDir, asset);
    const expected = checksums.get(asset);
    if (!expected) {
      console.error(`  ${key}: checksums.txt 中没有 ${asset}`);
      failures += 1;
      return;
    }

    if (fs.existsSync(destination) && !args.force && record[key]?.sha256 === expected) {
      console.log(`  ${key}: 已存在且校验和一致，跳过`);
      return;
    }

    const started = Date.now();
    const url = releaseAssets?.get(asset)?.url ?? releaseDownloadUrl(version, asset);
    const { sha256, size } = await download(url, destination);

    if (sha256 !== expected) {
      fs.rmSync(destination, { force: true });
      console.error(`  ${key}: SHA256 不匹配，期望 ${expected}，实际 ${sha256}`);
      failures += 1;
      return;
    }

    record[key] = { asset, sha256, size, triple: PLATFORMS[key].triple };
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ${key}: 完成 ${(size / 1024 / 1024).toFixed(1)} MB / ${seconds}s`);
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const key = queue.shift();
      await processOne(key);
    }
  });
  await Promise.all(workers);

  fs.writeFileSync(
    VERSION_FILE,
    `${JSON.stringify(
      { version, repo: REPO, updatedAt: new Date().toISOString(), platforms: record },
      null,
      2
    )}\n`,
    'utf8'
  );
  console.log(`version.json 已更新，记录 ${Object.keys(record).length} 个平台`);

  if (failures > 0) {
    console.error(`有 ${failures} 个平台失败`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
