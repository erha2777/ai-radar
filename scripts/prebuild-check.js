/**
 * 打包前置检查：确认没有正在运行的应用实例。
 *
 * 为什么需要它：
 *   Electron 应用运行时会锁定 dist/win-unpacked 下的 AI Radar.exe 与 app.asar，
 *   此时 electron-builder 清理输出目录会失败，报出一段难以理解的底层错误：
 *       ⨯ remove ...\AI Radar.exe: Access is denied.
 *       ⨯ app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
 *   这个脚本把它转换成一句可操作的提示。
 *
 * 实现说明：
 *   两条判据，都不依赖应用显示名（将来改名也不会失效）：
 *     1. 可执行文件位于本项目的 node_modules\electron 下 —— 覆盖 `npm start` 开发态
 *     2. 可执行文件位于本项目的 dist 下      —— 覆盖打包后运行态
 *   之所以不用进程名匹配：开发态进程名是 electron，打包态是 AI Radar，
 *   而应用名随时可能改成中文，按名字判断很脆弱。
 *
 * 用法：
 *   node scripts/prebuild-check.js        # 有实例在跑则退出码 1
 *   node scripts/prebuild-check.js --kill # 自动结束这些进程后继续
 */

const { execFileSync } = require('child_process');

/** 同步休眠，避免忙等占用 CPU。 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * 枚举正在运行的本项目应用进程。
 *
 * 这里有一个必须绕开的坑：
 *   PowerShell 5.1 默认按系统 OEM 代码页编码管道输出，而 Node 按 UTF-8 解码。
 *   本项目路径含中文（…\Desktop\ai开发\project），读回来会变成乱码
 *   （ai????\project），任何基于「路径以项目根目录开头」的判断都会永远失败，
 *   使这个检查形同虚设 —— 这正是最初版本漏检的原因。
 *
 * 因此判据全部改用 **纯 ASCII 的路径片段**，不依赖任何非 ASCII 字符：
 *   开发态：...\node_modules\electron\dist\electron.exe
 *   打包态：...\dist\win-unpacked\...
 * 这两段在任何代码页下都能无损比对，同时也天然排除了其它 Electron 应用
 * （它们不会带本项目的 node_modules\electron 或 dist\win-unpacked 路径片段）。
 *
 * @returns {{checked: boolean, list: Array<{pid:number, kind:string}>}}
 *   checked=false 表示没能枚举成功（例如子进程被安全策略拦截），
 *   此时绝不能对外宣称「未检测到」——那是把「没检查」说成了「检查通过」。
 */
function findRunningApp() {
  const found = [];

  let pidText;
  try {
    // 只向 PowerShell 要 PID（纯数字，跨代码页无损）
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
    // 无法枚举时不谎报「检查通过」——如实说明没检查成，让用户知道锁风险仍在
    console.log(`[prebuild] ⚠ 无法枚举进程（${String(err.message).split('\n')[0]}）`);
    console.log('[prebuild]   已跳过检查继续打包；若出现 “Access is denied”，请先退出正在运行的 AI Radar');
    return { checked: false, list: [] };
  }

  const pids = String(pidText)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!pids.length) return { checked: true, list: [] };

  // 纯 ASCII 标记；项目路径里的中文一律不参与比较
  const DEV_MARKER = '\\node_modules\\electron\\dist\\electron.exe';
  const PACKAGED_MARKER = '\\dist\\win-unpacked\\';

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

    // 注意：exePath 中非 ASCII 段可能已被代码页破坏，但下面两段标记是 ASCII，不受影响
    const lower = exePath.toLowerCase();
    if (lower.includes(DEV_MARKER)) {
      found.push({ pid, kind: '开发版' });
    } else if (lower.includes(PACKAGED_MARKER)) {
      found.push({ pid, kind: '打包版' });
    }
  }

  return { checked: true, list: found };
}

/** 请求结束指定进程，返回成功发出的数量。 */
function killProcesses(list) {
  let ok = 0;
  for (const p of list) {
    try {
      process.kill(p.pid, 'SIGKILL');
      ok += 1;
    } catch {
      // 进程可能已退出，或权限不足
    }
  }
  return ok;
}

/**
 * 等待进程退出（文件锁随之释放）。
 * @returns {Array} 仍未退出的进程
 */
function waitForExit(list, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let remaining = list.slice();
  while (remaining.length && Date.now() < deadline) {
    remaining = remaining.filter((p) => {
      try {
        process.kill(p.pid, 0); // 信号 0 仅探测存活，不实际发送
        return true;
      } catch {
        return false;
      }
    });
    if (remaining.length) sleepSync(300);
  }
  return remaining;
}

/* ------------------------------- 主流程 ------------------------------- */

const autoKill = process.argv.includes('--kill');
const probe = findRunningApp();
const running = probe.list;

if (!running.length) {
  // 只有确实检查过、且确认没有实例在跑，才给出明确的通过结论
  if (probe.checked) {
    console.log('[prebuild] ✔ 未检测到运行中的 AI Radar，可以开始打包');
  }
  process.exit(0);
}

console.log(`[prebuild] 检测到 ${running.length} 个运行中的 AI Radar 进程：`);
for (const p of running) console.log(`           PID ${String(p.pid).padEnd(7)} ${p.kind}`);

if (!autoKill) {
  console.log('');
  console.log('  打包需要覆盖 dist 目录，而运行中的应用会锁定其中的 exe 与 app.asar，');
  console.log('  直接打包会报 “Access is denied” 这类难以理解的底层错误。');
  console.log('');
  console.log('  请先退出应用（托盘图标右键 → 退出），然后重新执行打包；');
  console.log('  或执行以下命令自动结束这些进程后继续：');
  console.log('');
  console.log('      node scripts/prebuild-check.js --kill');
  console.log('      （等价于 npm run build:force）');
  console.log('');
  process.exit(1);
}

console.log('[prebuild] 正在结束这些进程…');
const killed = killProcesses(running);
console.log(`[prebuild] 已请求结束 ${killed} 个进程，等待文件锁释放…`);
const remaining = waitForExit(running);

if (remaining.length) {
  console.log(`[prebuild] ✘ 仍有 ${remaining.length} 个进程未退出（PID: ${remaining.map((p) => p.pid).join(', ')}）`);
  console.log('          请手动退出应用后重试。');
  process.exit(1);
}

console.log('[prebuild] ✔ 进程已退出，可以开始打包');
process.exit(0);

