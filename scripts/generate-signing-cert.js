#!/usr/bin/env node
'use strict';

/**
 * 生成自签名代码签名证书（仅 Windows）。
 *
 * 用途：给本地/内部测试包盖上签名，验证 electron-builder 的签名链路是通的。
 * 自签名证书不受信任，SmartScreen 仍会告警，正式分发必须换成受信任的 OV/EV 证书。
 *
 * 用法：
 *   node scripts/generate-signing-cert.js
 *   MCPB_WIN_CERT_PASSWORD=xxx node scripts/generate-signing-cert.js
 *
 * 生成的 pfx/cer 落在 build/signing/（已在 .gitignore 中排除）。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'signing');
const PFX_FILE = path.join(OUT_DIR, 'mcp-builder-selfsigned.pfx');
const CER_FILE = path.join(OUT_DIR, 'mcp-builder-selfsigned.cer');

const SUBJECT = process.env.MCPB_WIN_CERT_SUBJECT || 'CN=MCP Server Build (Self-Signed), O=MCP Builder, C=CN';
const PASSWORD = process.env.MCPB_WIN_CERT_PASSWORD || 'mcpb-selfsigned-dev';
const VALID_YEARS = 3;

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 清理过的 PSModulePath：只保留 Windows PowerShell 5.1 自己的模块目录。
 *
 * 父进程是 pwsh 时，继承来的 PSModulePath 会把 PowerShell 7 的模块目录排在最前面，
 * powershell.exe（5.1）加载 Microsoft.PowerShell.Security 时会被 5.1 的同名模块干扰，
 * 结果是 Cert: 驱动器根本没注册（Cannot find drive 'Cert'）。
 */
function windowsPowerShellEnv() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const modulePath = [
    path.join(systemRoot, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    path.join(programFiles, 'WindowsPowerShell', 'Modules'),
  ].join(';');
  return { ...process.env, PSModulePath: modulePath };
}

function runPowerShell(command) {
  const hosts = [
    { file: 'pwsh', env: process.env },
    { file: 'powershell.exe', env: windowsPowerShellEnv() },
  ];
  let lastError = null;
  for (const host of hosts) {
    try {
      return execFileSync(
        host.file,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: host.env }
      ).trim();
    } catch (error) {
      // 宿主不存在才换下一个；命令本身失败要直接抛出去
      if (error.code !== 'ENOENT') throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function main() {
  if (process.platform !== 'win32') {
    console.error('自签名证书生成依赖 New-SelfSignedCertificate，只能在 Windows 上运行');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const command = [
    '$ErrorActionPreference = "Stop"',
    `$subject = ${psQuote(SUBJECT)}`,
    // 同主题的旧证书先清掉，避免证书库里堆一串同名证书
    'Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq $subject } | Remove-Item -Force',
    '$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject ' +
      '-KeyUsage DigitalSignature -KeyExportPolicy Exportable -KeyLength 2048 -HashAlgorithm sha256 ' +
      `-CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(${VALID_YEARS})`,
    `$secure = ConvertTo-SecureString -String ${psQuote(PASSWORD)} -Force -AsPlainText`,
    `Export-PfxCertificate -Cert $cert -FilePath ${psQuote(PFX_FILE)} -Password $secure -Force | Out-Null`,
    `Export-Certificate -Cert $cert -FilePath ${psQuote(CER_FILE)} -Force | Out-Null`,
    'Write-Output $cert.Thumbprint',
  ].join('\n');

  let thumbprint;
  try {
    thumbprint = runPowerShell(command);
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().trim() : error.message;
    console.error(`生成自签名证书失败：${detail}`);
    process.exit(1);
  }

  const sizeKb = (file) => Math.round(fs.statSync(file).size / 1024);
  console.log(`证书主题: ${SUBJECT}`);
  console.log(`指纹    : ${thumbprint}`);
  console.log(`PFX     : ${path.relative(ROOT, PFX_FILE)} (${sizeKb(PFX_FILE)} KB)`);
  console.log(`CER     : ${path.relative(ROOT, CER_FILE)} (${sizeKb(CER_FILE)} KB)`);
  console.log('');
  console.log('打包时用这组环境变量启用签名（PowerShell）：');
  console.log('  $env:MCPB_WIN_CERT_FILE = "build/signing/mcp-builder-selfsigned.pfx"');
  console.log(`  $env:MCPB_WIN_CERT_PASSWORD = "${PASSWORD}"`);
  console.log('  npm run dist:win');
  console.log('');
  console.log('要让本机信任这个自签名证书（需要管理员权限，仅本地测试用）：');
  console.log(
    `  Import-Certificate -FilePath ${path.relative(ROOT, CER_FILE)} -CertStoreLocation Cert:\\LocalMachine\\Root`
  );
}

main();
