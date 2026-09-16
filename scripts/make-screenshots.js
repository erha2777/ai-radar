'use strict';

/**
 * 生成 README 展示用的界面截图。
 *
 * 用法：node scripts/make-screenshots.js
 *
 * 与冒烟测试（scripts/smoke-test.js）的区别：
 *   冒烟测试截的是「测试过程」的画面，会带着测试痕迹 —— 排序停在最热、
 *   卡片有高亮边框、分类停在最后点过的那个，不适合当展示图。
 *   本脚本以 --demo 启动应用，跑完常规校验后会把界面复位成干净状态再截图，
 *   输出到 screenshots/ 目录，文件名固定，便于 README 长期引用。
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(exe)) {
  console.error('[x] 未找到 electron.exe，请先执行：node scripts/fetch-electron.mjs');
  process.exit(1);
}

const outDir = path.join(root, 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

// 清掉旧图，避免把上次的残留当成新结果
for (const f of fs.readdirSync(outDir)) {
  if (f.endsWith('.png')) fs.unlinkSync(path.join(outDir, f));
}

console.log('[shots] 启动应用并生成演示截图…');
console.log('[shots] 输出目录：', outDir);

const child = spawn(exe, ['.', '--smoke-test', '--demo'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    AI_RADAR_SMOKE: '1',
    AI_RADAR_SMOKE_DEMO: '1',
    AI_RADAR_SMOKE_DIR: outDir
  }
});

const hardTimeout = setTimeout(() => {
  console.error('[shots] 超时（240s），强制结束');
  child.kill();
  process.exit(1);
}, 240000);

child.on('exit', (code) => {
  clearTimeout(hardTimeout);

  // 只保留 demo-*.png：冒烟测试期间还会顺手截几张过程图
  // （main-window / card-expanded / settings），它们带着测试痕迹，不是交付内容。
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      if (f.endsWith('.png') && !f.startsWith('demo-')) {
        fs.unlinkSync(path.join(outDir, f));
      }
    }
  }

  const shots = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png'))
    : [];

  console.log('');
  if (!shots.length) {
    console.error('[shots] ✘ 未生成任何截图');
    process.exit(1);
  }

  console.log(`[shots] ✔ 生成 ${shots.length} 张截图：`);
  for (const f of shots.sort()) {
    const size = fs.statSync(path.join(outDir, f)).size;
    console.log(`         ${f.padEnd(22)} ${(size / 1024).toFixed(0)} KB`);
  }

  // 报告里记录了演示图的卡片数，用来发现「截出空列表」这种问题
  const reportFile = path.join(outDir, 'report.json');
  if (fs.existsSync(reportFile)) {
    try {
      const r = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      console.log('');
      console.log(`[shots] 截图时列表卡片数：${r.showcaseCardCount}`);
      console.log(`[shots] 条目总数：${r.itemCount}`);
      if (r.rendererErrors && r.rendererErrors.length) {
        console.log(`[shots] 渲染进程报错：${r.rendererErrors.join(' | ')}`);
      }
      if (!r.showcaseCardCount) {
        console.warn('[shots] ⚠ 演示截图时列表为空，请检查数据抓取是否成功');
      }
    } catch {
      /* 报告解析失败不影响截图结果 */
    }
    // report.json 是过程产物，不随截图一起交付
    fs.unlinkSync(reportFile);
  }

  process.exit(code === 0 ? 0 : 1);
});
