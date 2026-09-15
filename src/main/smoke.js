'use strict';

/**
 * 冒烟测试支持（仅在带 --smoke-test 参数时启用）。
 *
 * 流程：等窗口加载完成 → 等首次抓取结束 → 截图 → 写诊断报告 → 退出。
 * 报告内容用于自动化核验：页面是否加载、有无 JS 报错、各源抓取结果、渲染出的卡片数量。
 */

const fs = require('fs');
const path = require('path');

function isSmokeTest() {
  return process.argv.includes('--smoke-test') || process.env.AI_RADAR_SMOKE === '1';
}

function isKeepAlive() {
  return process.argv.includes('--keep') || process.env.AI_RADAR_SMOKE_KEEP === '1';
}

function outDir() {
  return process.env.AI_RADAR_SMOKE_DIR || path.join(__dirname, '..', '..', '.smoke');
}

/**
 * 安装冒烟测试流程。
 * @param {{ app: Electron.App, window: Electron.BrowserWindow, scheduler: object, store: object }} ctx
 */
function install({ app, window, scheduler, store }) {
  const dir = outDir();
  fs.mkdirSync(dir, { recursive: true });

  const report = {
    startedAt: new Date().toISOString(),
    title: '',
    pageLoaded: false,
    rendererErrors: [],
    consoleErrors: [],
    screenshots: [],
    itemCount: 0,
    unreadCount: 0,
    favoriteCount: 0,
    renderedCards: 0,
    fetchedAt: null,
    sourceStatuses: [],
    error: ''
  };

  const wc = window.webContents;

  wc.on('did-finish-load', () => {
    report.pageLoaded = true;
    report.title = wc.getTitle();
  });

  wc.on('render-process-gone', (_e, details) => {
    report.rendererErrors.push(`render-process-gone: ${details.reason}`);
  });

  wc.on('preload-error', (_e, file, error) => {
    report.rendererErrors.push(`preload-error ${file}: ${error && error.message}`);
  });

  wc.on('console-message', (_e, level, message, line, source) => {
    // level: 0=verbose 1=info 2=warning 3=error
    if (level >= 2) {
      report.consoleErrors.push(`[${level}] ${String(message).slice(0, 300)} @${path.basename(String(source))}:${line}`);
    }
  });

  wc.on('did-fail-load', (_e, code, desc, url) => {
    report.rendererErrors.push(`did-fail-load ${code} ${desc} ${url}`);
  });

  let shots = 0;

  async function capture(name) {
    try {
      const image = await wc.capturePage();
      const size = image.getSize();
      const file = path.join(dir, `${name}.png`);
      fs.writeFileSync(file, image.toPNG());
      shots += 1;
      report.screenshots.push(`${file} (${size.width}x${size.height})`);
      return true;
    } catch (err) {
      report.rendererErrors.push(`截图失败 ${name}: ${err.message}`);
      return false;
    }
  }

  /** 从渲染进程读取界面实际状态，验证 DOM 真的渲染了内容。 */
  async function readUiState() {
    try {
      return await wc.executeJavaScript(
        `(() => {
          const cards = document.querySelectorAll('#feed .card').length;
          const seps = document.querySelectorAll('#feed .day-sep').length;
          const status = document.getElementById('statusText');
          const detail = document.getElementById('statusDetail');
          const empty = document.getElementById('emptyState');
          const navBadges = Array.from(document.querySelectorAll('#navCategories .badge')).map(b => b.textContent);
          const firstTitle = document.querySelector('#feed .card .card__title');
          const firstSrc = document.querySelector('#feed .card .src-tag');

          // 量一下头部空白到底来自哪个元素
          const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height) }; };
          const feed = document.getElementById('feed');
          const firstChild = feed ? feed.firstElementChild : null;
          const layout = {
            titlebar: rect(document.querySelector('.titlebar')),
            toolbar: rect(document.querySelector('.toolbar')),
            keywordBar: rect(document.getElementById('keywordBar')),
            progress: rect(document.getElementById('progressBar')),
            feed: rect(feed),
            feedFirstChild: firstChild ? { cls: firstChild.className, tag: firstChild.tagName, text: (firstChild.textContent||'').slice(0,12), ...rect(firstChild) } : null,
            firstCard: rect(document.querySelector('#feed .card')),
            emptyRect: rect(empty),
            emptyHidden: empty ? empty.hidden : null,
            emptyDisplay: empty ? getComputedStyle(empty).display : null,
            feedPaddingTop: feed ? getComputedStyle(feed).paddingTop : null
          };

          return {
            cards, seps,
            layout,
            statusText: status ? status.textContent : '',
            statusDetail: detail ? detail.textContent : '',
            emptyVisible: empty ? !empty.hidden : null,
            emptyTitle: document.getElementById('emptyTitle')?.textContent || '',
            navBadges,
            firstTitle: firstTitle ? firstTitle.textContent.slice(0, 80) : '',
            firstSource: firstSrc ? firstSrc.textContent : '',
            hasApi: typeof window.api === 'object'
          };
        })()`,
        true
      );
    } catch (err) {
      report.rendererErrors.push(`读取界面状态失败：${err.message}`);
      return null;
    }
  }

  /** 在界面里真实操作一遍核心功能，验证交互逻辑而不只是渲染。 */
  async function exerciseUi() {
    const probe = async (script) => {
      try {
        return await wc.executeJavaScript(script, true);
      } catch (err) {
        report.rendererErrors.push(`交互测试失败：${err.message}`);
        return null;
      }
    };

    const results = {};

    // 1) 搜索过滤：结果数应减少，且每条都能在「标题+摘要+来源+标签」里找到关键词
    results.search = await probe(`(() => {
      const before = document.querySelectorAll('#feed .card').length;
      const input = document.getElementById('inputSearch');
      const term = (document.querySelector('#feed .card .card__title')?.textContent || '').trim().slice(0, 4);
      input.value = term;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise((resolve) => setTimeout(() => {
        const after = document.querySelectorAll('#feed .card').length;
        const cards = Array.from(document.querySelectorAll('#feed .card'));
        const lower = term.toLowerCase();
        // 必须覆盖渲染层搜索用到的全部字段：标题 + 摘要 + 来源 + 标签。
        // 曾漏掉 tags 导致误报（GitHub 条目的 deepseek 只出现在 topics 标签里）。
        // 用 textContent 读取以避开高亮插入的 <mark>。
        const misses = cards.filter(c => {
          const hay = [
            c.querySelector('.card__title')?.textContent || '',
            c.querySelector('.card__summary')?.textContent || '',
            c.querySelector('.src-tag')?.textContent || '',
            Array.from(c.querySelectorAll('.tag')).map(t => t.textContent).join(' ')
          ].join(' ').toLowerCase();
          return !hay.includes(lower);
        }).map(c => (c.querySelector('.card__title')?.textContent || '').slice(0, 40));
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => resolve({
          term, before, after,
          allMatch: cards.length > 0 && misses.length === 0,
          missCount: misses.length,
          missSample: misses.slice(0, 3)
        }), 400);
      }, 500));
    })()`);

    // 2) 分类筛选：切到「论文」，所有卡片应属于该分类
    results.category = await probe(`(() => {
      const btn = document.querySelector('[data-category="papers"]');
      if (!btn) return { error: '找不到论文分类按钮' };
      btn.click();
      return new Promise((resolve) => setTimeout(() => {
        const cards = document.querySelectorAll('#feed .card').length;
        const sources = Array.from(document.querySelectorAll('#feed .card .src-tag')).map(e => e.textContent);
        const allPapers = sources.length > 0 && sources.every(s => s.includes('HuggingFace'));
        document.querySelector('[data-category="all"]')?.click();
        setTimeout(() => resolve({ cards, allPapers, sampleSources: sources.slice(0, 3) }), 400);
      }, 500));
    })()`);

    // 3) 标记已读：必须挑一张「未读」卡片，否则点下去是取消已读
    results.readState = await probe(`(() => {
      const info = (el) => el ? {
        isRead: el.classList.contains('is-read'),
        btn: el.querySelector('[data-action="read"]')?.textContent || ''
      } : null;

      // 明确挑未读卡片，避免依赖「第一张恰好未读」这个假设
      const target = document.querySelector('#feed .card:not(.is-read)');
      const id = target ? target.dataset.id : null;
      const unreadBefore = document.querySelectorAll('#feed .card:not(.is-read)').length;
      const dataBefore = window.__debug ? window.__debug.read[id] : null;
      const before = info(target);

      const btn = target ? target.querySelector('[data-action="read"]') : null;
      if (btn) btn.click();

      return new Promise((resolve) => setTimeout(() => {
        const card = document.querySelector('#feed .card[data-id="' + id + '"]');
        resolve({
          id,
          btnFound: Boolean(btn),
          before,
          after: info(card),
          dataBefore,
          dataAfter: window.__debug ? window.__debug.read[id] : null,
          unreadBefore,
          unreadAfter: document.querySelectorAll('#feed .card:not(.is-read)').length,
          nowRead: card ? card.classList.contains('is-read') : null
        });
      }, 900));
    })()`);

    // 4) 收藏：点击收藏后侧栏计数应 +1
    results.favorite = await probe(`(() => {
      const before = parseInt(document.getElementById('favCount')?.textContent || '0', 10);
      const first = document.querySelector('#feed .card');
      const id = first?.dataset.id;
      first?.querySelector('[data-action="star"]')?.click();
      return new Promise((resolve) => setTimeout(() => {
        const after = parseInt(document.getElementById('favCount')?.textContent || '0', 10);
        const card = document.querySelector('#feed .card[data-id="' + id + '"]');
        const starOn = card ? card.querySelector('.act--star')?.classList.contains('is-on') : null;
        resolve({ before, after, starOn, id });
      }, 500));
    })()`);
    // 5) 收藏视图：切到「我的收藏」应能看到刚收藏的条目
    //    回归「侧栏显示收藏 N 条、点进去却是空的」这个问题
    results.favoriteView = await probe(`(() => {
      document.getElementById('btnFavorites')?.click();
      return new Promise((resolve) => setTimeout(() => {
        const cards = Array.from(document.querySelectorAll('#feed .card'));
        const badge = document.getElementById('favCount')?.textContent || '0';
        const emptyVisible = !(document.getElementById('emptyState')?.hidden ?? true);
        const emptyTitle = document.getElementById('emptyTitle')?.textContent || '';
        const firstTitle = cards.length ? (cards[0].querySelector('.card__title')?.textContent || '').slice(0, 40) : '';
        // 回到全部视图，避免影响后续检查
        document.getElementById('btnShowAll')?.click();
        setTimeout(() => resolve({
          badge,
          cardCount: cards.length,
          emptyVisible,
          emptyTitle,
          firstTitle
        }), 400);
      }, 600));
    })()`);

    // 6) 清理收藏：取消后再进收藏视图，该条目应消失
    //    注意用「相对变化」判断，不能用绝对值为 0 —— userData 里可能有用户
    //    自己先前收藏的条目，绝对断言会误报失败。
    results.favoriteCleanup = await probe(`(() => {
      const beforeCount = parseInt(document.getElementById('favCount')?.textContent || '0', 10);
      const beforeCards = document.querySelectorAll('#feed .card .act--star.is-on').length;
      const star = document.querySelector('#feed .card .act--star.is-on');
      const id = star?.closest('.card')?.dataset.id;
      star?.click();
      return new Promise((resolve) => setTimeout(() => {
        const afterCount = parseInt(document.getElementById('favCount')?.textContent || '0', 10);
        document.getElementById('btnFavorites')?.click();
        setTimeout(() => {
          const cardIds = Array.from(document.querySelectorAll('#feed .card')).map(c => c.dataset.id);
          document.getElementById('btnShowAll')?.click();
          setTimeout(() => resolve({
            beforeCount,
            afterCount,
            beforeCards,
            removedId: id,
            stillPresent: cardIds.includes(id),
            cardsInFavView: cardIds.length
          }), 350);
        }, 500);
      }, 500));
    })()`);

    // 7) 排序切换
    results.sort = await probe(`(() => {
      const before = document.querySelectorAll('#feed .card').length;
      document.querySelector('[data-sort="hot"]')?.click();
      return new Promise((resolve) => {
        setTimeout(() => {
          const hot = document.querySelectorAll('#feed .card').length;
          document.querySelector('[data-sort="time"]')?.click();
          setTimeout(() => resolve({ before, hot, back: document.querySelectorAll('#feed .card').length }), 350);
        }, 500);
      });
    })()`);

    report.uiExercises = results;
    return results;
  }

  async function finish(reason) {
    const snap = scheduler.snapshot();
    report.itemCount = snap.items.length;
    report.unreadCount = snap.unreadCount;
    report.favoriteCount = snap.favorites.length;
    report.fetchedAt = snap.fetchedAt;
    report.sourceStatuses = (snap.statuses || []).map((s) => ({
      id: s.id,
      name: s.name,
      ok: s.ok,
      count: s.count,
      rawCount: s.rawCount,
      filteredCount: s.filteredCount,
      ms: s.ms,
      error: s.error
    }));

    const ui = await readUiState();
    if (ui) {
      report.renderedCards = ui.cards;
      report.daySeparators = ui.seps;
      report.uiStatus = ui.statusText;
      report.uiDetail = ui.statusDetail;
      report.emptyVisible = ui.emptyVisible;
      report.emptyTitle = ui.emptyTitle;
      report.navBadges = ui.navBadges;
      report.firstTitle = ui.firstTitle;
      report.firstSource = ui.firstSource;
      report.hasApi = ui.hasApi;
      report.layout = ui.layout;
    }

    report.finishedAt = new Date().toISOString();
    report.finishReason = reason;

    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('[smoke] 报告已写入', path.join(dir, 'report.json'));
  }

  // 等首次抓取完成后截图；最多等 90 秒
  const maxWait = 90000;
  const startedAt = Date.now();

  const poll = setInterval(async () => {
    const snap = scheduler.snapshot();
    const elapsed = Date.now() - startedAt;

    if (!snap.refreshing && snap.fetchedAt && report.screenshots.length === 0) {
      clearInterval(poll);
      // 留一点时间让渲染进程完成布局与动画
      await new Promise((r) => setTimeout(r, 1200));
      await capture('main-window');
      // 展开第一张卡片，验证展开态渲染
      try {
        await wc.executeJavaScript(
          `document.querySelector('#feed .card')?.click(); true`,
          true
        );
        await new Promise((r) => setTimeout(r, 600));
        await capture('card-expanded');
      } catch {
        /* 忽略 */
      }
      // 打开设置面板
      try {
        await wc.executeJavaScript(`document.getElementById('btnSettings').click(); true`, true);
        await new Promise((r) => setTimeout(r, 700));
        await capture('settings');
        await wc.executeJavaScript(`document.getElementById('settingsModal').hidden = true; true`, true);
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        /* 忽略 */
      }

      // 真实操作一遍核心交互功能
      await exerciseUi();

      await finish('completed');

      if (isKeepAlive()) {
        console.log('[smoke] --keep 指定，保持运行中');
        return;
      }
      setTimeout(() => {
        app.exit(0);
      }, 500);
      return;
    }

    if (elapsed > maxWait) {
      clearInterval(poll);
      report.error = `等待首次抓取超时（${maxWait}ms）`;
      await capture('timeout-state');
      await finish('timeout');
      setTimeout(() => app.exit(2), 500);
    }
  }, 500);
}

module.exports = { isSmokeTest, isKeepAlive, install };
