'use strict';

const os = require('node:os');

/**
 * 平台矩阵。
 *
 * 官方产物按 `<os>_<arch>` 命名，Tauri sidecar 却要求文件名带 Rust 目标三元组，
 * 所以这里同时维护两套标识：asset 用 os/arch，落盘文件名用 triple。
 */
const PLATFORMS = {
  'windows-amd64': { os: 'windows', arch: 'amd64', triple: 'x86_64-pc-windows-msvc', ext: '.exe' },
  'windows-arm64': { os: 'windows', arch: 'arm64', triple: 'aarch64-pc-windows-msvc', ext: '.exe' },
  'linux-amd64': { os: 'linux', arch: 'amd64', triple: 'x86_64-unknown-linux-gnu', ext: '' },
  'linux-arm64': { os: 'linux', arch: 'arm64', triple: 'aarch64-unknown-linux-gnu', ext: '' },
  'darwin-amd64': { os: 'darwin', arch: 'amd64', triple: 'x86_64-apple-darwin', ext: '' },
  'darwin-arm64': { os: 'darwin', arch: 'arm64', triple: 'aarch64-apple-darwin', ext: '' },
};

const NODE_ARCH_TO_ASSET = { x64: 'amd64', arm64: 'arm64', ia32: '386' };
// os.platform() 返回 win32，而官方产物与 Tauri 三元组都用 windows
const NODE_PLATFORM_TO_ASSET = { win32: 'windows', darwin: 'darwin', linux: 'linux' };

/**
 * 当前运行平台对应的 key。
 *
 * @returns {string} 形如 windows-amd64
 */
function currentPlatformKey() {
  const arch = NODE_ARCH_TO_ASSET[os.arch()];
  const platform = NODE_PLATFORM_TO_ASSET[os.platform()];
  const key = `${platform}-${arch}`;
  if (!PLATFORMS[key]) {
    throw new Error(`当前平台 ${key} 不在支持列表中：${Object.keys(PLATFORMS).join(', ')}`);
  }
  return key;
}

/**
 * 官方 release 产物名。
 *
 * @param {string} version 形如 v3.21.14
 * @param {string} platformKey 形如 windows-amd64
 * @returns {string} 形如 graphjin_3.21.14_windows_amd64.tar.gz
 */
function assetName(version, platformKey) {
  const platform = PLATFORMS[platformKey];
  if (!platform) throw new Error(`未知平台 ${platformKey}`);
  return `graphjin_${version.replace(/^v/, '')}_${platform.os}_${platform.arch}.tar.gz`;
}

/**
 * Tauri sidecar 要求的落盘文件名。
 *
 * @param {string} platformKey 形如 windows-amd64
 * @returns {string} 形如 graphjin-x86_64-pc-windows-msvc.exe
 */
function sidecarFileName(platformKey) {
  const platform = PLATFORMS[platformKey];
  if (!platform) throw new Error(`未知平台 ${platformKey}`);
  return `graphjin-${platform.triple}${platform.ext}`;
}

module.exports = { PLATFORMS, assetName, sidecarFileName, currentPlatformKey };
