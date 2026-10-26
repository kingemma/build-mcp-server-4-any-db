#!/usr/bin/env node
'use strict';

/**
 * 从产品源图生成前端用的品牌图标缩略图。
 *
 * electron/icon.png 是 512×512（约 417 KB），窗口图标与安装包图标都用它；
 * 前端侧栏只显示 34px、首屏占位 40px，直接引源图等于把 417 KB 打进 dist，
 * 所以统一按 2 倍图导出缩略图，HiDPI 屏也不糊。
 *
 * 用法：
 *   npm run gen:icons
 *
 * 换图标后重跑一次即可。缩放走 Windows 的 System.Drawing，仅支持 Windows。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'electron', 'icon.png');

/** 目标尺寸 = 显示尺寸 × 2（侧栏 34px、首屏占位 40px） */
const TARGETS = [
  { file: 'src/assets/brand-icon.png', size: 68 },
  { file: 'public/boot-icon.png', size: 80 },
];

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 清理过的 PSModulePath：只保留 Windows PowerShell 5.1 自己的模块目录。
 *
 * 父进程是 pwsh 时，继承来的 PSModulePath 会把 PowerShell 7 的模块目录排在最前面，
 * powershell.exe（5.1）加载同名模块会互相干扰。优先用 pwsh 就是为了绕开这一点。
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
      // 宿主不存在才换下一个；缩放本身失败要直接抛出去
      if (error.code !== 'ENOENT') throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function buildCommand() {
  const lines = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Drawing',
    `$src = [System.Drawing.Image]::FromFile(${psQuote(SOURCE)})`,
    `$targets = @(${TARGETS.map(
      (t) => `@{ size = ${t.size}; out = ${psQuote(path.join(ROOT, t.file))} }`
    ).join(', ')})`,
    'foreach ($t in $targets) {',
    '  $bmp = New-Object System.Drawing.Bitmap($t.size, $t.size)',
    '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
    '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
    '  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
    '  $g.DrawImage($src, 0, 0, $t.size, $t.size)',
    '  $g.Dispose()',
    '  $bmp.Save($t.out, [System.Drawing.Imaging.ImageFormat]::Png)',
    '  $bmp.Dispose()',
    '}',
    '$src.Dispose()',
  ];
  return lines.join('\n');
}

function main() {
  if (process.platform !== 'win32') {
    console.error('缩略图生成依赖 System.Drawing，只能在 Windows 上运行；图标已入库，其它平台无需生成');
    process.exit(1);
  }
  if (!fs.existsSync(SOURCE)) {
    console.error(`缺少源图 ${path.relative(ROOT, SOURCE).replace(/\\/g, '/')}`);
    process.exit(1);
  }

  try {
    runPowerShell(buildCommand());
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().trim() : error.message;
    console.error(`生成品牌图标失败：${detail}`);
    process.exit(1);
  }

  for (const target of TARGETS) {
    const file = path.join(ROOT, target.file);
    if (!fs.existsSync(file)) {
      console.error(`预期产物未生成：${target.file}`);
      process.exit(1);
    }
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`${target.file}  ${target.size}×${target.size}  ${kb} KB`);
  }
  console.log(`源图 ${path.relative(ROOT, SOURCE).replace(/\\/g, '/')}（窗口 / 安装包图标继续用它）`);
}

main();
