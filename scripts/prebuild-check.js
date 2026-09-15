/**
 * 打包前置检查：确认 dist 目录没有被正在运行的应用占用。
 *
 * 为什么需要它：
 *   Electron 应用运行时会锁定 dist/win-unpacked 下的 AI Radar.exe 与 app.asar，
 *   此时 electron-builder 清空输出目录会失败，报出一段难以理解的底层错误：
 *       ⨯ remove ...\app.asar: The process cannot access the file
 *       ⨯ app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
 *   这个脚本把它转换成一句可操作的提示。
 *
 * 判据（按可靠性排序）：
 *   1. 【权威】直接尝试把 dist 改名 —— 这是打包真正需要的条件（能清空输出目录）。
 *      文件系统会给出确定答案，不像进程枚举那样可能因权限问题静默漏判。
 *      曾出现过「进程枚举说没占用、实际文件锁着」的误判，所以这里以实测为准。
 *   2. 【辅助】枚举本项目的应用进程 —— 仅在需要自动结束进程（--kill）时才用，
 *      失败也不影响 1 的结论。
 *
 * 为什么不用进程名做判据：开发态进程名是 electron，打包态是 AI Radar，
 * 而应用名随时可能改成中文，按名字判断很脆弱。进程路径判据又受权限影响。
 *
 * 用法：
 *   node scripts/prebuild-check.js        # dist 被占用则退出码 1
 *   node scripts/prebuild-check.js --kill # 自动结束相关进程后重试
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 项目根目录（本脚本在 scripts/ 下） */
const PROJECT_ROOT = path.resolve(__dirname, '..');
/**
 * 打包输出目录。
 * 支持用环境变量覆盖，便于针对其它输出目录复用本检查（也方便测试）。
 */
const DIST_DIR = process.env.PREBUILD_CHECK_DIST
  ? path.resolve(process.env.PREBUILD_CHECK_DIST)
  : path.join(PROJECT_ROOT, 'dist');

/** 同步休眠，避免忙等占用 CPU。 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * 实测 dist 目录能否被独占改名——等价于「打包能否清空输出目录」。
 *
 * 改名而不是删除：改名是可逆的、瞬时完成的，不会真的破坏上次的构建产物；
 * 而 Windows 上只要有进程持有目录内文件的句柄，改名就会失败。
 *
 * @returns {{free: boolean, error: string, lockedFile: string}}
 */
function probeDistWritable() {
  if (!fs.existsSync(DIST_DIR)) {
    return { free: true, error: '', lockedFile: '' };
  }

  const probeName = path.join(PROJECT_ROOT, `.dist-probe-${process.pid}`);
  try {
    fs.renameSync(DIST_DIR, probeName);
    // 成功即说明没有句柄占用，立刻改回来
    fs.renameSync(probeName, DIST_DIR);
    return { free: true, error: '', lockedFile: '' };
  } catch (err) {
    // 万一改回来了但第二步失败，尽量恢复，避免把用户的 dist 弄丢
    try {
      if (fs.existsSync(probeName) && !fs.existsSync(DIST_DIR)) {
        fs.renameSync(probeName, DIST_DIR);
      } else if (fs.existsSync(probeName)) {
        fs.rmSync(probeName, { recursive: true, force: true });
      }
    } catch {
      /* 恢复失败也不影响结论 */
    }
    const message = String(err.message || err);
    // 说明：改名是对整个目录的操作，err.path 只会给出 dist 目录本身。
    // 曾尝试逐个文件探测（openSync 'r+'）来定位被锁文件，但在 Windows 上
    // 共享句柄仍允许读写打开、只有删除/改名才失败，探测不可靠，故不做。
    return { free: false, error: message, lockedFile: '' };
  }
}

/**
 * 枚举本项目的 Electron 进程（仅用于 --kill）。
 *
 * 判据用纯 ASCII 的路径片段：PowerShell 5.1 按系统 OEM 代码页编码管道输出、
 * Node 按 UTF-8 解码，含中文的项目路径读回来会变成乱码，任何路径前缀比较都会失效。
 *
 * @returns {{checked: boolean, list: Array<{pid:number, kind:string}>}}
 */
function findAppProcesses() {
  let pidText;
  try {
    pidText = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'electron*' -or $_.ProcessName -like '*AI Radar*' }).Id -join ','"
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 25000, windowsHide: true }
    );
  } catch (err) {
    return { checked: false, list: [], error: String(err.message).split('\n')[0] };
  }

  const pids = String(pidText)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!pids.length) return { checked: true, list: [] };

  const DEV_MARKER = '\\node_modules\\electron\\dist\\electron.exe';
  const PACKAGED_MARKER = '\\dist\\win-unpacked\\';
  const list = [];

  for (const pid of pids) {
    let exePath = '';
    try {
      exePath = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true }
      ).trim();
    } catch {
      continue;
    }
    if (!exePath) continue;

    const lower = exePath.toLowerCase();
    if (lower.includes(DEV_MARKER)) list.push({ pid, kind: '开发版' });
    else if (lower.includes(PACKAGED_MARKER)) list.push({ pid, kind: '打包版' });
  }

  return { checked: true, list };
}

/** 结束指定进程，返回成功发出的数量。 */
function killProcesses(list) {
  let ok = 0;
  for (const p of list) {
    try {
      process.kill(p.pid, 'SIGKILL');
      ok += 1;
    } catch {
      /* 进程可能已退出，或权限不足 */
    }
  }
  return ok;
}

/* ------------------------------- 主流程 ------------------------------- */

const autoKill = process.argv.includes('--kill');

function reportBlocked(probe) {
  console.log('');
  console.log('[prebuild] ✘ dist 目录正被占用，现在打包会失败：');
  console.log(`           ${probe.error}`);
  console.log('');
  console.log('  原因：应用运行时会锁住 dist 里的 app.asar 与 exe，electron-builder');
  console.log('        无法清空输出目录，只能抛出难懂的底层错误。');
  console.log('');
  console.log('  处理顺序：');
  console.log('    1. 退出应用 —— 注意它在托盘里，要右键托盘图标选「退出」，');
  console.log('       而不是只关掉窗口（关窗口默认只是最小化到托盘）。');
  console.log('    2. 仍失败就执行 npm run build:force，自动结束相关进程后重试。');
  console.log('    3. 还失败说明进程已退出但句柄未释放（Windows 上内存映射文件的');
  console.log('       常见行为），此时重启电脑可彻底释放。');
}

let probe = probeDistWritable();

if (probe.free) {
  console.log('[prebuild] ✔ dist 目录可写，可以开始打包');
  process.exit(0);
}

if (!autoKill) {
  reportBlocked(probe);
  process.exit(1);
}

/* --kill：结束相关进程后重试 */
console.log('[prebuild] dist 被占用，尝试结束相关进程…');
const found = findAppProcesses();
if (found.list.length) {
  console.log(`[prebuild] 检测到 ${found.list.length} 个相关进程：`);
  for (const p of found.list) console.log(`           PID ${String(p.pid).padEnd(7)} ${p.kind}`);
  console.log(`[prebuild] 已请求结束 ${killProcesses(found.list)} 个进程，等待文件锁释放…`);
} else {
  console.log('[prebuild] 未能定位到具体进程，等待文件锁自行释放…');
}

// 轮询等待锁释放，最多 20 秒
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  sleepSync(500);
  probe = probeDistWritable();
  if (probe.free) break;
}

if (probe.free) {
  console.log('[prebuild] ✔ 文件锁已释放，可以开始打包');
  process.exit(0);
}

reportBlocked(probe);
console.log('');
console.log('  自动结束进程后仍未释放。可能原因：句柄尚未回收（重启可解决）、');
console.log('  杀毒软件 / 同步盘 / 编辑器正在扫描该目录，或另一个终端里也在跑打包。');
process.exit(1);
