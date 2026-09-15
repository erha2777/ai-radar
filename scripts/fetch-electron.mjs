'use strict';

/**
 * Electron 二进制手动下载脚本。
 *
 * 为什么不直接依赖 npm postinstall：本机受限环境下 npm 的 rebuild 阶段
 * 无法 spawn 子进程（spawn EPERM），所以用 --ignore-scripts 安装依赖后，
 * 由这个脚本自行下载并解压官方二进制。
 *
 * 用法：node scripts/fetch-electron.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const pkgPath = path.join(root, 'node_modules', 'electron', 'package.json');
if (!fs.existsSync(pkgPath)) {
  console.error('[x] 未找到 node_modules/electron，请先执行 npm install --ignore-scripts');
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

const platform = process.platform;
const arch = process.arch;
const platformKey = `${platform}-${arch}`;

const MIRRORS = [
  `https://npmmirror.com/mirrors/electron/${version}/electron-v${version}-${platformKey}.zip`,
  `https://registry.npmmirror.com/-/binary/electron/${version}/electron-v${version}-${platformKey}.zip`,
  `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${platformKey}.zip`
];

const cacheDir = path.join(root, '.tmp-dl');
fs.mkdirSync(cacheDir, { recursive: true });
const zipPath = path.join(cacheDir, `electron-v${version}-${platformKey}.zip`);
const distDir = path.join(root, 'node_modules', 'electron', 'dist');

function log(...args) {
  console.log('[electron-fetch]', ...args);
}

async function download() {
  const expected = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
  if (expected > 50 * 1024 * 1024) {
    log(`已存在缓存包 ${(expected / 1048576).toFixed(1)} MB，跳过下载`);
    return zipPath;
  }

  const errors = [];
  for (const url of MIRRORS) {
    const started = Date.now();
    log(`尝试下载：${url}`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 900000);
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length') || 0);
      const fileStream = fs.createWriteStream(zipPath);
      const reader = res.body.getReader();
      let received = 0;
      let lastLog = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        received += value.length;
        const now = Date.now();
        if (now - lastLog > 5000) {
          lastLog = now;
          const pct = total ? ` (${((received / total) * 100).toFixed(0)}%)` : '';
          log(`  已下载 ${(received / 1048576).toFixed(1)} MB${pct}`);
        }
      }
      await new Promise((resolve, reject) => {
        fileStream.end((err) => (err ? reject(err) : resolve()));
      });
      clearTimeout(timer);
      const size = fs.statSync(zipPath).size;
      if (size < 50 * 1024 * 1024) throw new Error(`文件过小（${size} 字节），可能不是有效安装包`);
      log(`下载完成：${(size / 1048576).toFixed(1)} MB，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return zipPath;
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
      log(`  失败：${err.message}`);
      try {
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      } catch {
        /* 忽略 */
      }
    }
  }
  throw new Error(`所有镜像均下载失败：\n${errors.join('\n')}`);
}

function extract() {
  log('解压到 node_modules/electron/dist ...');
  if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${distDir}' -Force`
    ],
    { stdio: 'inherit' }
  );
  if (res.status !== 0) {
    throw new Error(`解压失败，PowerShell 退出码 ${res.status}`);
  }

  const exePath = path.join(distDir, 'electron.exe');
  if (!fs.existsSync(exePath)) throw new Error('解压后未找到 electron.exe');

  // electron 的 index.js 依赖 path.txt 定位可执行文件
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron.exe', 'utf8');
  const versionFile = path.join(distDir, 'version');
  if (!fs.existsSync(versionFile)) fs.writeFileSync(versionFile, `v${version}`, 'utf8');

  const size = fs.statSync(exePath).size;
  log(`完成：electron.exe ${(size / 1048576).toFixed(1)} MB`);
  return exePath;
}

try {
  await download();
  extract();
  // 校验能启动（--version 会打印版本号后退出）
  const check = spawnSync(path.join(distDir, 'electron.exe'), ['--version'], { encoding: 'utf8' });
  if (check.status === 0) {
    log(`二进制自检通过：${String(check.stdout).trim()}`);
  } else {
    log(`警告：--version 退出码 ${check.status}，stderr=${String(check.stderr).slice(0, 300)}`);
  }
  log('Electron 安装就绪 ✔');
} catch (err) {
  console.error('[x]', err.message);
  process.exit(1);
}
