'use strict';

/**
 * 应用冒烟测试与截图工具。
 *
 * 用法：
 *   node scripts/smoke-test.js            启动应用，抓取界面截图与运行日志后退出
 *   node scripts/smoke-test.js --keep     启动后保持运行（人工查看）
 *
 * 工作原理：以子进程方式启动 electron.exe，通过环境变量注入测试开关。
 * 应用侧（仅当 AI_RADAR_SMOKE 存在时）会在窗口就绪并完成一次抓取后，
 * 调用 capturePage 把界面写成 PNG，然后自动退出。
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

const outDir = path.join(root, '.smoke');
fs.mkdirSync(outDir, { recursive: true });

const keep = process.argv.includes('--keep');
const args = ['.', '--smoke-test'];
if (keep) args.push('--keep');

console.log('[smoke] 启动：', exe, args.join(' '));

const child = spawn(exe, args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    AI_RADAR_SMOKE: '1',
    AI_RADAR_SMOKE_KEEP: keep ? '1' : '0',
    AI_RADAR_SMOKE_DIR: outDir,
    ELECTRON_ENABLE_LOGGING: '1'
  }
});

const hardTimeout = setTimeout(() => {
  console.error('[smoke] 超时（180s），强制结束');
  child.kill();
  process.exit(1);
}, 180000);

child.on('exit', (code, signal) => {
  clearTimeout(hardTimeout);
  console.log(`[smoke] 应用退出 code=${code} signal=${signal}`);

  const report = path.join(outDir, 'report.json');
  if (fs.existsSync(report)) {
    try {
      const data = JSON.parse(fs.readFileSync(report, 'utf8'));
      console.log('\n===== 冒烟测试报告 =====');
      console.log('窗口标题      :', data.title);
      console.log('页面加载      :', data.pageLoaded ? '成功' : '失败');
      console.log('渲染进程报错  :', data.rendererErrors && data.rendererErrors.length ? data.rendererErrors.join(' | ') : '无');
      console.log('控制台错误    :', data.consoleErrors && data.consoleErrors.length ? data.consoleErrors.join(' | ') : '无');
      console.log('条目总数      :', data.itemCount);
      console.log('未读数量      :', data.unreadCount);
      console.log('收藏数量      :', data.favoriteCount);
      console.log('数据时间      :', data.fetchedAt);
      console.log('列表渲染节点  :', data.renderedCards);
      if (Array.isArray(data.sourceStatuses)) {
        console.log('\n----- 各数据源结果 -----');
        for (const s of data.sourceStatuses) {
          console.log(
            `${s.ok ? '✔' : '✘'} ${String(s.name).padEnd(20)} 抓取=${String(s.count).padEnd(4)} 耗时=${String(s.ms).padStart(5)}ms ${
              s.error ? `错误=${s.error}` : ''
            }`
          );
        }
      }

      if (data.uiExercises) {
        console.log('\n----- 交互功能验证 -----');
        const e = data.uiExercises;
        const mark = (ok) => (ok ? '✔' : '✘');

        if (e.search) {
          const ok = e.search.after < e.search.before && e.search.allMatch;
          console.log(
            `  ${mark(ok)} 搜索「${e.search.term}」: ${e.search.before} → ${e.search.after} 条，命中校验=${e.search.allMatch}`
          );
        }
        if (e.category) {
          const ok = e.category.allPapers && e.category.cards > 0;
          console.log(`  ${mark(ok)} 分类筛选(论文): ${e.category.cards} 条，全部为论文源=${e.category.allPapers}`);
        }
        if (e.readState) {
          const r = e.readState;
          const ok = r.btnFound && r.before && r.before.isRead === false && r.nowRead === true
            && r.dataAfter === true && r.unreadAfter === r.unreadBefore - 1;
          console.log(
            `  ${mark(ok)} 标记已读: ${r.before ? r.before.btn : '?'} → 卡片已读=${r.nowRead}，数据已读=${r.dataAfter}，未读 ${r.unreadBefore} → ${r.unreadAfter}`
          );
        }
        if (e.favorite) {
          const f = e.favorite;
          const ok = f.after === f.before + 1 && f.starOn === true;
          console.log(`  ${mark(ok)} 收藏: 计数 ${f.before} → ${f.after}，按钮点亮=${f.starOn}`);
        }
        if (e.favoriteView) {
          const v = e.favoriteView;
          // 关键校验：侧栏计数 > 0 时，收藏视图里必须真的有卡片 —— 回归
          // 「显示收藏 1 条、点进去却是空的」
          const ok = Number(v.badge) > 0 && v.cardCount > 0 && !v.emptyVisible;
          console.log(
            `  ${mark(ok)} 收藏视图: 计数=${v.badge} 卡片数=${v.cardCount} 空状态=${v.emptyVisible}` +
              (v.firstTitle ? `  首条=${v.firstTitle}` : '')
          );
        }
        if (e.favoriteCleanup) {
          const c = e.favoriteCleanup;
          // 用相对变化判断：userData 里可能还有用户自己先前收藏的条目
          const ok = c.afterCount === c.beforeCount - 1 && c.stillPresent === false;
          console.log(
            `  ${mark(ok)} 取消收藏: 计数 ${c.beforeCount} → ${c.afterCount}，` +
              `该条目仍在收藏视图=${c.stillPresent}（视图内共 ${c.cardsInFavView} 条）`
          );
        }
        if (e.sort) {
          const s = e.sort;
          const ok = s.hot > 0 && s.back === s.before;
          console.log(`  ${mark(ok)} 排序切换: 最新 ${s.before} → 最热 ${s.hot} → 最新 ${s.back}`);
        }
      }
      console.log('\n截图文件      :', (data.screenshots || []).join(', '));
      console.log('========================\n');
    } catch (err) {
      console.error('[smoke] 报告解析失败：', err.message);
    }
  } else {
    console.error('[smoke] 未生成报告文件（应用可能启动即崩溃）');
  }

  process.exit(code === 0 ? 0 : 1);
});
