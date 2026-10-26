'use strict';

/**
 * electron-builder 构建配置。
 *
 * 为什么用 JS 配置文件而不是 package.json 的 "build" 字段：
 * 1) 「有证书就签名、没证书就跳过」需要在构建期判断环境变量，JSON 表达不了；
 * 2) electron-builder 一旦在 package.json 读到 "build" 字段就会完全忽略本文件
 *    （app-builder-lib/out/util/config/load.js 的 loadConfig），所以配置只能留一份。
 *
 * 文件名必须是 electron-builder.js：查找列表只认
 * electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}，写成 electron-builder.config.js
 * 会被静默忽略，打包退回全默认配置（产物落到 dist/、productName 变成 mcp-builder）。
 *
 * 签名环境变量（全部可选，缺省时跳过 Windows 代码签名）：
 *   MCPB_WIN_CERT_FILE      .pfx/.p12 证书路径
 *   MCPB_WIN_CERT_PASSWORD  证书密码
 *   MCPB_WIN_CERT_SUBJECT   证书主题名（证书装在系统证书库里、没有 pfx 时用）
 *   MCPB_WIN_TIMESTAMP_URL  RFC3161 时间戳服务，缺省用 electron-builder 的 digicert
 * 也兼容 electron-builder 原生变量 WIN_CSC_LINK / CSC_LINK（base64 或路径）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

const CERT_FILE_ENV = ['MCPB_WIN_CERT_FILE'];
const CERT_SUBJECT_ENV = ['MCPB_WIN_CERT_SUBJECT'];
const CERT_PASSWORD_ENV = ['MCPB_WIN_CERT_PASSWORD', 'WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD'];
const TIMESTAMP_URL_ENV = ['MCPB_WIN_TIMESTAMP_URL'];
const NATIVE_CERT_LINK_ENV = ['WIN_CSC_LINK', 'CSC_LINK'];

function readEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return { name, value: value.trim() };
    }
  }
  return null;
}

function log(message) {
  process.stdout.write(`[electron-builder] ${message}\n`);
}

/**
 * 根据环境变量推导 win 平台的签名配置。
 *
 * 显式关闭 signing 时返回 signExecutable: false：否则 electron-builder 会先打印
 * "signing with signtool.exe"，然后在没有证书时静默跳过，日志看起来像签过一样。
 */
function resolveWinSigning() {
  const certFile = readEnv(CERT_FILE_ENV);
  const certSubject = readEnv(CERT_SUBJECT_ENV);
  const certPassword = readEnv(CERT_PASSWORD_ENV);
  const timestampUrl = readEnv(TIMESTAMP_URL_ENV);
  const nativeLink = readEnv(NATIVE_CERT_LINK_ENV);

  if (certFile == null && certSubject == null && nativeLink == null) {
    log('未检测到签名证书（MCPB_WIN_CERT_FILE / MCPB_WIN_CERT_SUBJECT / CSC_LINK），跳过 Windows 代码签名');
    return { signExecutable: false };
  }

  // 证书密码统一交给 electron-builder 原生的 CSC_KEY_PASSWORD：
  // v26 取证书密码时只认 cscKeyPassword 配置项和 CSC_KEY_PASSWORD，
  // 把密码写进配置对象会被带进 release/builder-effective-config.yaml。
  if (certPassword != null && !process.env.CSC_KEY_PASSWORD) {
    process.env.CSC_KEY_PASSWORD = certPassword.value;
  }

  if (certFile == null && nativeLink != null) {
    log(`使用 ${nativeLink.name} 作为签名证书来源`);
    return {};
  }

  const signtoolOptions = { signingHashAlgorithms: ['sha256'] };

  if (certFile != null) {
    const resolved = path.resolve(ROOT, certFile.value);
    if (!fs.existsSync(resolved)) {
      throw new Error(`签名证书不存在：${resolved}（来自 ${certFile.name}）`);
    }
    signtoolOptions.certificateFile = resolved;
    log(`启用 Windows 签名：${resolved}`);
  } else {
    signtoolOptions.certificateSubjectName = certSubject.value;
    log(`启用 Windows 签名：证书库主题 ${certSubject.value}`);
  }

  if (timestampUrl != null) {
    signtoolOptions.rfc3161TimeStampServer = timestampUrl.value;
  }

  return { signtoolOptions };
}

const winSigning = resolveWinSigning();

module.exports = {
  appId: 'com.mcpbuilder.desktop',
  productName: 'MCP Server Build',
  directories: {
    output: 'release',
  },
  electronDist: 'node_modules/electron/dist',
  files: [
    'dist/**/*',
    'electron/**/*',
    '!electron/mcp-build-server.png',
    'sidecar-backend/src/**/*',
    'sidecar-backend/package.json',
    'graphjin-binaries/version.json',
    'scripts/platforms.js',
    'package.json',
    'LICENSE',
  ],
  extraResources: [
    {
      from: 'binaries',
      to: 'binaries',
      filter: ['graphjin-*'],
    },
  ],
  win: {
    target: ['nsis'],
    icon: 'build/icon.png',
    ...winSigning,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'MCP Server Build',
  },
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    maintainer: 'Evan, Zhen Wang <18901599114@163.com>',
    icon: 'build/icon.png',
  },
};
