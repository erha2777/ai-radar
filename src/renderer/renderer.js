'use strict';

/**
 * 渲染进程主逻辑。
 *
 * 数据来源：主进程通过 IPC 推送完整快照（window.api.onUpdate）。
 * 本文件只负责：本地筛选 / 排序 / 搜索、DOM 渲染、交互与偏好持久化。
 *
 * 渲染策略：卡片按 id 复用 DOM 节点，刷新时只增删差异节点，
 * 因此滚动位置、展开状态、动画都不会被打断。
 */

/* ============================== 状态 ============================== */

const state = {
  snapshot: {
    items: [],
    favorites: [],
    statuses: [],
    sources: [],
    unreadCount: 0,
    fetchedAt: null,
    refreshing: false,
    config: null
  },
  info: null,
  ui: {
    category: 'all',      // all | papers | cn | global | community | opensource | favorites
    sort: 'time',         // time | hot
    unreadOnly: false,
    keywordOnly: false,
    search: '',
    activeKeyword: ''
  },
  rendered: new Map(),    // id -> HTMLElement
  openIds: new Set(),     // 展开阅读的条目
  progress: { finished: 0, total: 0 },
  pendingNew: new Set(),  // 本次刷新新增的 id，用于入场动画
  manualRefresh: false    // 是否由用户手动触发（用于避免重复提示）
};

const UI_KEY = 'ai-radar:ui';

/* ============================== 工具函数 ============================== */

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 相对时间：刚刚 / N分钟前 / N小时前 / 昨天 HH:mm / M月D日 */
function relativeTime(iso) {
  if (!iso) return '时间未知';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '时间未知';

  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;

  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;

  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const days = Math.floor(hours / 24);
  if (days === 1) return `昨天 ${hh}:${mm}`;
  if (days < 7) return `${days} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function fullTime(iso) {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日期分组标签：今天 / 昨天 / 具体日期 */
function dayLabel(iso) {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return '今天';
  if (t >= startOfToday - 86400000) return '昨天';
  if (t >= startOfToday - 86400000 * 6) return `${d.getMonth() + 1}月${d.getDate()}日 · 周${'日一二三四五六'[d.getDay()]}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 命中关键词高亮；先转义再插入 mark 标签，避免 XSS。 */
function highlight(text, terms) {
  const safe = escapeHtml(text);
  if (!terms || !terms.length) return safe;
  const valid = terms
    .filter((t) => t && t.length >= 1)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  if (!valid.length) return safe;
  try {
    return safe.replace(new RegExp(`(${valid.join('|')})`, 'gi'), '<mark>$1</mark>');
  } catch {
    return safe;
  }
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 提示条 */
let toastTimer = null;
function toast(message, kind = '') {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = `toast${kind ? ` toast--${kind}` : ''}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 3200);
  clearTimeout(toastTimer);
}

/* ============================== UI 偏好持久化 ============================== */

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(state.ui, {
      category: typeof saved.category === 'string' ? saved.category : 'all',
      sort: saved.sort === 'hot' ? 'hot' : 'time',
      unreadOnly: Boolean(saved.unreadOnly),
      keywordOnly: Boolean(saved.keywordOnly)
    });
  } catch {
    /* 忽略损坏的偏好 */
  }
}

function saveUiPrefs() {
  try {
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({
        category: state.ui.category,
        sort: state.ui.sort,
        unreadOnly: state.ui.unreadOnly,
        keywordOnly: state.ui.keywordOnly
      })
    );
  } catch {
    /* 忽略写入失败 */
  }
}

/* ============================== 筛选与排序 ============================== */

/** 复合搜索：空格分隔多个词，全部命中才算匹配。 */
function matchSearch(item, query) {
  if (!query) return true;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = `${item.title} ${item.summary || ''} ${item.sourceName} ${(item.tags || []).join(' ')}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

function matchCategory(item, category) {
  if (category === 'all') return true;
  if (category === 'favorites') return Boolean(item.favorite);
  return item.category === category;
}

function matchKeyword(item, keyword) {
  if (!keyword) return true;
  const kw = keyword.toLowerCase();
  return `${item.title} ${item.summary || ''} ${(item.tags || []).join(' ')}`.toLowerCase().includes(kw);
}

function matchFollowKeywords(item, keywords) {
  if (!keywords || !keywords.length) return true;
  const haystack = `${item.title} ${item.summary || ''}`.toLowerCase();
  return keywords.some((k) => haystack.includes(String(k).toLowerCase()));
}

/**
 * 把收藏数据补进当前条目列表。
 *
 * 为什么需要：收藏是主进程单独持久化的快照（snapshot.favorites），生命周期比
 * 抓取列表长。一条内容被收藏后，仍可能从 snapshot.items 里消失——超出保留时效、
 * 被 maxItems 截断、或该数据源被停用。此时若只看 items，就会出现
 * 「侧栏显示收藏 1 条、点进去却是空的」。这里用收藏快照兜底。
 *
 * @param {Array} items 当前的 snapshot.items
 * @returns {Array} 合并后的列表（含已不在 items 里的收藏）
 */
function withFavorites(items) {
  const list = Array.isArray(items) ? items : [];
  const favorites = state.snapshot.favorites || [];
  if (!favorites.length) return list;

  const have = new Set(list.map((i) => i.id));
  const recovered = [];
  for (const fav of favorites) {
    if (!fav || !fav.id || have.has(fav.id)) continue;
    recovered.push({
      ...fav,
      // 收藏快照只存了保存时间，没有发布时间就退回用它排序，避免沉底
      publishedAt: fav.publishedAt || fav.savedAt || null,
      favorite: true,
      read: false,
      tags: Array.isArray(fav.tags) ? fav.tags : [],
      points: null
    });
  }
  return recovered.length ? [...list, ...recovered] : list;
}

function visibleItems() {
  const cfg = state.snapshot.config || {};
  const followKeywords = cfg.keywords || [];
  const ui = state.ui;
  // 收藏视图下并入收藏快照，保证收藏过就一定看得到
  const source = ui.category === 'favorites' ? withFavorites(state.snapshot.items) : state.snapshot.items;

  let list = source.filter((item) => {
    if (!matchCategory(item, ui.category)) return false;
    if (ui.unreadOnly && item.read) return false;
    if (ui.keywordOnly && !matchFollowKeywords(item, followKeywords)) return false;
    if (!matchKeyword(item, ui.activeKeyword)) return false;
    if (!matchSearch(item, ui.search)) return false;
    return true;
  });

  if (ui.sort === 'hot') {
    list = list.slice().sort((a, b) => {
      const ha = (a.points || 0) * 2 + (a.body ? 2 : 0);
      const hb = (b.points || 0) * 2 + (b.body ? 2 : 0);
      if (hb !== ha) return hb - ha;
      return Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
    });
  }
  return list;
}

/** 当前生效的高亮词：搜索词 + 激活的关键词 + 用户关注词 */
function highlightTerms() {
  const cfg = state.snapshot.config || {};
  const terms = [];
  if (state.ui.search) terms.push(...state.ui.search.split(/\s+/).filter(Boolean));
  if (state.ui.activeKeyword) terms.push(state.ui.activeKeyword);
  return terms;
}

/* ============================== 侧栏渲染 ============================== */

const CATEGORY_DEFS = [
  { id: 'all', name: '全部', icon: '📡' },
  { id: 'papers', name: '论文', icon: '📄' },
  { id: 'cn', name: '国内资讯', icon: '🇨🇳' },
  { id: 'global', name: '海外资讯', icon: '🌍' },
  { id: 'community', name: '社区热议', icon: '💬' },
  { id: 'opensource', name: '开源项目', icon: '⭐' },
  { id: 'deepseek', name: 'DeepSeek 专区', icon: '🐋' }
];

function renderCategories() {
  const nav = $('navCategories');
  const items = state.snapshot.items;
  const counts = { all: items.length, favorites: items.filter((i) => i.favorite).length };
  for (const def of CATEGORY_DEFS) {
    if (def.id === 'all') continue;
    counts[def.id] = items.filter((i) => i.category === def.id).length;
  }

  const html = CATEGORY_DEFS.map((def) => {
    const active = state.ui.category === def.id ? ' is-active' : '';
    return `<button class="nav-item${active}" data-category="${def.id}">
      <span class="nav-item__icon">${def.icon}</span>
      <span class="nav-item__label">${def.name}</span>
      <span class="badge">${counts[def.id] || 0}</span>
    </button>`;
  }).join('');

  nav.innerHTML = `<div class="nav__title">分类</div>${html}`;
}

function renderSources() {
  const list = $('sourceList');
  const cfg = state.snapshot.config || {};
  const enabled = Array.isArray(cfg.enabledSources) ? new Set(cfg.enabledSources) : null;
  const statusMap = new Map((state.snapshot.statuses || []).map((s) => [s.id, s]));
  const countMap = new Map();
  for (const item of state.snapshot.items) {
    countMap.set(item.sourceId, (countMap.get(item.sourceId) || 0) + 1);
  }

  list.innerHTML = state.snapshot.sources
    .map((src) => {
      const on = enabled === null || enabled.has(src.id);
      const st = statusMap.get(src.id);
      const err = st && !st.ok ? `<span class="source-item__err" title="${escapeHtml(st.error || '抓取失败')}"></span>` : '';
      return `<label class="source-item${on ? '' : ' is-off'}" title="${escapeHtml(src.name)}">
        <input type="checkbox" data-source="${src.id}" ${on ? 'checked' : ''} />
        <span class="source-item__name">${escapeHtml(src.name)}</span>
        ${err}
        <span class="source-item__count">${countMap.get(src.id) || 0}</span>
      </label>`;
    })
    .join('');

  $('favCount').textContent = state.snapshot.favorites.length;
  $('allCount').textContent = state.snapshot.items.length;
  $('btnFavorites').classList.toggle('is-active', state.ui.category === 'favorites');
  $('btnShowAll').classList.toggle('is-active', state.ui.category === 'all');
}

function renderKeywordBar() {
  const cfg = state.snapshot.config || {};
  const bar = $('keywordBar');
  const keywords = cfg.keywords || [];
  if (!keywords.length) {
    bar.innerHTML = '';
    return;
  }
  bar.innerHTML =
    `<span class="muted" style="font-size:12px">关注词：</span>` +
    keywords
      .map(
        (k) =>
          `<button class="kw-chip${state.ui.activeKeyword === k ? ' is-active' : ''}" data-keyword="${escapeHtml(k)}">${escapeHtml(k)}</button>`
      )
      .join('') +
    (state.ui.activeKeyword ? `<button class="kw-chip" data-keyword="">清除</button>` : '');
}

/* ============================== 卡片渲染 ============================== */

function cardElement(item) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = item.id;
  el.innerHTML = `
    <div class="card__head">
      <span class="src-tag"></span>
      <span class="card__time" title=""></span>
      <span class="card__spacer"></span>
      <span class="card__pills"></span>
    </div>
    <h3 class="card__title"></h3>
    <p class="card__summary"></p>
    <div class="card__tags"></div>
    <div class="card__foot">
      <span class="card__author muted"></span>
      <span class="card__actions">
        <button class="act act--star" data-action="star" title="收藏">☆ 收藏</button>
        <button class="act act--read" data-action="read" title="标记已读/未读">标记已读</button>
        <button class="act act--primary" data-action="open" title="在浏览器中打开原文">打开原文 ↗</button>
      </span>
    </div>`;
  updateCard(el, item);
  return el;
}

function updateCard(el, item) {
  const terms = highlightTerms();
  const isOpen = state.openIds.has(item.id);

  el.classList.toggle('is-read', Boolean(item.read));
  el.classList.toggle('is-open', isOpen);

  const srcTag = el.querySelector('.src-tag');
  srcTag.textContent = item.sourceName;

  const time = el.querySelector('.card__time');
  time.textContent = relativeTime(item.publishedAt);
  time.title = fullTime(item.publishedAt);

  // 右上角徽标：热度 / 语言
  const pills = [];
  if (item.points != null && item.points > 0) {
    const unit = item.category === 'opensource' ? '⭐' : '🔥';
    pills.push(`<span class="pill${item.points >= 100 ? ' pill--hot' : ''}">${unit} ${item.points}</span>`);
  }
  if (item.arxivId) pills.push('<span class="pill">arXiv</span>');
  if (item.lang === 'en') pills.push('<span class="pill">EN</span>');
  el.querySelector('.card__pills').innerHTML = pills.join('');

  el.querySelector('.card__title').innerHTML = highlight(item.title, terms);

  const summaryEl = el.querySelector('.card__summary');
  const bodyText = isOpen && item.body ? item.body : item.summary || '';
  if (bodyText) {
    summaryEl.innerHTML = highlight(bodyText, terms);
    summaryEl.classList.remove('is-empty');
  } else {
    // 该源只给了标题（正文需登录/付费），用一行短提示占位即可，
    // 不必长篇解释——右侧本来就有「打开原文」按钮。
    summaryEl.textContent = '暂无摘要';
    summaryEl.classList.add('is-empty');
  }

  const tags = (item.tags || []).slice(0, 6);
  el.querySelector('.card__tags').innerHTML = tags
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join('');

  el.querySelector('.card__author').textContent = item.author ? `✍ ${item.author}` : '';

  const star = el.querySelector('.act--star');
  star.classList.toggle('is-on', Boolean(item.favorite));
  star.innerHTML = item.favorite ? '★ 已收藏' : '☆ 收藏';

  const readBtn = el.querySelector('.act--read');
  readBtn.textContent = item.read ? '标为未读' : '标记已读';
}

/** 差异渲染：按可见列表增删节点，复用已有卡片。 */
function renderFeed() {
  const feed = $('feed');
  const items = visibleItems();
  const terms = highlightTerms();
  const seen = new Set();
  let lastDay = null;
  let anchor = null; // 上一个插入的节点，用于保持顺序

  for (const item of items) {
    seen.add(item.id);

    const label = dayLabel(item.publishedAt);
    if (label !== lastDay) {
      lastDay = label;
      const sepId = `sep:${label}`;
      let sep = state.rendered.get(sepId);
      if (!sep) {
        sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.textContent = label;
        state.rendered.set(sepId, sep);
      }
      // 放到正确位置
      if (anchor ? anchor.nextSibling !== sep : feed.firstChild !== sep) {
        insertAfter(feed, sep, anchor);
      }
      anchor = sep;
    }

    let card = state.rendered.get(item.id);
    if (!card) {
      card = cardElement(item);
      state.rendered.set(item.id, card);
      if (state.pendingNew.has(item.id)) {
        card.classList.add('is-new');
        setTimeout(() => card.classList.remove('is-new'), 600);
      }
    } else {
      updateCard(card, item);
    }
    card.__item = item;

    if (anchor ? anchor.nextSibling !== card : feed.firstChild !== card) {
      insertAfter(feed, card, anchor);
    }
    anchor = card;
  }

  // 移除不再可见的节点（含旧的分隔条）
  for (const [key, node] of state.rendered) {
    if (key.startsWith('sep:')) {
      // 本轮未使用的分隔条：如果它的下一个兄弟不是卡片则删除
      if (!seen.size || !isSepUsed(node, feed)) {
        node.remove();
        state.rendered.delete(key);
      }
      continue;
    }
    if (!seen.has(key)) {
      node.remove();
      state.rendered.delete(key);
    }
  }

  // 高亮词变化时，已渲染卡片需要重绘文字
  if (terms.length || state._lastTerms !== terms.join('|')) {
    for (const item of items) {
      const card = state.rendered.get(item.id);
      if (card) updateCard(card, item);
    }
  }
  state._lastTerms = terms.join('|');

  // 空状态
  const empty = $('emptyState');
  if (!items.length) {
    empty.hidden = false;
    const refreshing = state.snapshot.refreshing;
    const noData = state.snapshot.items.length === 0;
    $('emptyTitle').textContent = noData
      ? refreshing
        ? '正在扫描信号…'
        : '暂时没有拿到数据'
      : '没有符合条件的内容';
    $('emptyDesc').textContent = noData
      ? refreshing
        ? `已连接 ${state.progress.finished}/${state.progress.total || '?'} 个数据源`
        : '可能是网络受限，点击下方按钮重试'
      : '试试切换分类、清空搜索或关闭筛选条件';
    $('btnEmptyRefresh').hidden = !noData;
  } else {
    empty.hidden = true;
  }

  // 更新侧栏计数（未读数会随阅读变化）
  renderCategories();
  renderSources();
}

function isSepUsed(node, feed) {
  const next = node.nextElementSibling;
  return Boolean(next && next.classList.contains('card'));
}

function insertAfter(container, node, ref) {
  if (ref) {
    if (ref.nextSibling !== node) container.insertBefore(node, ref.nextSibling);
  } else if (container.firstChild !== node) {
    container.insertBefore(node, container.firstChild);
  }
}

/* ============================== 状态栏 ============================== */

function renderStatus() {
  const snap = state.snapshot;
  const dot = $('statusDot');
  const text = $('statusText');
  const detail = $('statusDetail');

  const okCount = (snap.statuses || []).filter((s) => s.ok).length;
  const total = (snap.statuses || []).length;

  if (snap.refreshing) {
    dot.className = 'dot dot--busy';
    text.textContent = `正在抓取 ${state.progress.finished}/${state.progress.total || total || '?'} 个数据源…`;
    detail.textContent = '';
  } else if (!snap.fetchedAt) {
    dot.className = 'dot dot--idle';
    text.textContent = '尚未获取数据';
    detail.textContent = '';
  } else {
    dot.className = okCount === total && total > 0 ? 'dot dot--ok' : 'dot dot--err';
    text.textContent = `更新于 ${relativeTime(snap.fetchedAt)}`;
    const parts = [`${snap.items.length} 条`, `未读 ${snap.unreadCount}`];
    if (total) parts.push(`源 ${okCount}/${total} 正常`);
    if (snap.fromCache) parts.push('缓存');
    detail.textContent = parts.join(' · ');
  }

  $('statusSep').hidden = !detail.textContent;
  $('btnRefresh').classList.toggle('is-spinning', Boolean(snap.refreshing));
  $('btnRefresh').disabled = Boolean(snap.refreshing);
}

function renderProgress() {
  const bar = $('progressBar');
  const fill = $('progressFill');
  if (!state.snapshot.refreshing) {
    bar.hidden = true;
    fill.style.width = '0%';
    return;
  }
  bar.hidden = false;
  const total = state.progress.total || 1;
  fill.style.width = `${Math.min(100, (state.progress.finished / total) * 100)}%`;
}

/* ============================== 设置面板 ============================== */

function openSettings() {
  const cfg = state.snapshot.config || {};
  $('selInterval').value = String(cfg.refreshMinutes || 5);
  $('selMaxItems').value = String(cfg.maxItems || 500);
  $('chkNotify').checked = Boolean(cfg.notifyEnabled);
  $('rangeNotifyScore').value = String(cfg.notifyMinScore || 3);
  $('outNotifyScore').textContent = String(cfg.notifyMinScore || 3);
  $('chkLaunchAtLogin').checked = Boolean(cfg.launchAtLogin);
  $('chkCloseToTray').checked = Boolean(cfg.closeToTray);
  renderKeywordChips();
  renderStatusTable();
  renderAbout();
  $('settingsModal').hidden = false;
}

function closeSettings() {
  $('settingsModal').hidden = true;
}

function renderKeywordChips() {
  const cfg = state.snapshot.config || {};
  const chips = $('keywordChips');
  const list = cfg.keywords || [];
  chips.innerHTML = list.length
    ? list
        .map(
          (k) => `<span class="chip">${escapeHtml(k)}<button data-remove-keyword="${escapeHtml(k)}" title="删除">×</button></span>`
        )
        .join('')
    : '<span class="muted" style="font-size:12px">暂无关键词，添加后会自动高亮并提升通知优先级</span>';
}

function renderStatusTable() {
  const statuses = state.snapshot.statuses || [];
  const table = $('statusTable');
  if (!statuses.length) {
    table.innerHTML = '<div class="muted" style="font-size:12px">尚未抓取</div>';
    return;
  }
  table.innerHTML = statuses
    .map((s) => {
      const cls = s.ok ? 'status-ok' : 'status-err';
      const mark = s.ok ? '✔' : '✘';
      const meta = s.ok
        ? `${s.count} 条${s.filteredCount ? `（过滤 ${s.filteredCount}）` : ''} · ${s.ms}ms`
        : escapeHtml(s.error || '失败');
      return `<div class="status-row">
        <span class="${cls}">${mark}</span>
        <span class="status-row__name">${escapeHtml(s.name)}</span>
        <span class="status-row__meta">${meta}</span>
      </div>`;
    })
    .join('');
}

function renderAbout() {
  const info = state.info || {};
  $('aboutBox').innerHTML = `
    <div><b>AI Radar</b> v${escapeHtml(info.version || '1.0.0')}</div>
    <div>Electron ${escapeHtml(info.electron || '?')} · Chromium ${escapeHtml(info.chrome || '?')} · Node ${escapeHtml(info.node || '?')}</div>
    <div>数据目录：${escapeHtml(info.userData || '')}</div>`;
}

async function applyConfig(patch, { silent = false } = {}) {
  try {
    const cfg = await window.api.updateConfig(patch);
    state.snapshot.config = cfg;
    renderKeywordBar();
    renderFeed();
    if (!silent) toast('设置已保存', 'ok');
    return cfg;
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
    return null;
  }
}

/* ============================== 数据接入 ============================== */

/**
 * 本地乐观状态。
 *
 * 背景：主进程的抓取是异步的，一次刷新推送过来的快照可能早于用户刚做的
 * 「标记已读 / 收藏」写盘。若直接整份替换，用户眼前刚变灰的卡片会被刷回未读。
 * 这里记录本地刚做的改动，并在每份新快照上重新套用，保证用户操作不会被回滚。
 * 上限受控，避免长时间运行后无限增长。
 */
const localRead = new Map();     // id -> true/false
const localFav = new Map();      // id -> true/false
const LOCAL_STATE_MAX = 4000;

function rememberLocal(map, id, value) {
  map.delete(id);
  map.set(id, value);
  while (map.size > LOCAL_STATE_MAX) {
    map.delete(map.keys().next().value);
  }
}

/** 把本地乐观状态套用到新收到的快照上。 */
function mergeLocalState(snap) {
  if (!snap || !Array.isArray(snap.items)) return snap;
  if (localRead.size) {
    for (const item of snap.items) {
      const local = localRead.get(item.id);
      if (local !== undefined) item.read = local;
    }
  }
  if (localFav.size) {
    for (const item of snap.items) {
      const local = localFav.get(item.id);
      if (local !== undefined) item.favorite = local;
    }
  }
  // 未读数按合并后的结果重算，否则角标会和列表不一致
  snap.unreadCount = snap.items.filter((i) => !i.read).length;
  return snap;
}

async function bootstrap() {
  loadUiPrefs();

  try {
    state.info = await window.api.getInfo();
  } catch {
    state.info = {};
  }

  // 主题
  const savedTheme = localStorage.getItem('ai-radar:theme');
  setTheme(savedTheme === 'light' ? 'light' : 'dark');

  syncUiControls();
  bindEvents();

  try {
    const snap = await window.api.getFeed();
    applySnapshot(snap, { initial: true });
  } catch (err) {
    toast(`初始化失败：${err.message}`, 'err');
  }

  renderFeed();
  renderStatus();
}

function applySnapshot(snap, { initial = false } = {}) {
  if (!snap) return;
  const previousIds = new Set(state.snapshot.items.map((i) => i.id));

  // 先套用本地乐观状态，避免刚标记的已读/收藏被在途快照回滚
  snap = mergeLocalState(snap);
  state.snapshot = snap;
  // 只读调试句柄：供冒烟测试直接读「数据里的已读状态」，不受快照替换影响
  window.__lastSnap = snap;
  window.__debug = window.__debug || { read: {}, fav: {} };
  for (const item of snap.items) {
    window.__debug.read[item.id] = Boolean(item.read);
    window.__debug.fav[item.id] = Boolean(item.favorite);
  }

  if (!initial && snap.items.length) {
    state.pendingNew.clear();
    for (const item of snap.items) {
      if (!previousIds.has(item.id)) state.pendingNew.add(item.id);
    }
  }

  renderCategories();
  renderSources();
  renderKeywordBar();
  renderFeed();
  renderStatus();
  renderProgress();

  if (!$('settingsModal').hidden) {
    renderKeywordChips();
    renderStatusTable();
  }
}

/* ============================== 事件绑定 ============================== */

function syncUiControls() {
  $('chkUnreadOnly').checked = state.ui.unreadOnly;
  $('chkKeywordOnly').checked = state.ui.keywordOnly;
  $('inputSearch').value = state.ui.search;
  $('btnClearSearch').hidden = !state.ui.search;
  for (const btn of document.querySelectorAll('#segSort .seg__item')) {
    btn.classList.toggle('is-active', btn.dataset.sort === state.ui.sort);
  }
  $('btnShowAll').classList.toggle('is-active', state.ui.category === 'all');
  $('btnFavorites').classList.toggle('is-active', state.ui.category === 'favorites');
}

function bindEvents() {
  /* --- 标题栏 --- */
  $('btnRefresh').addEventListener('click', doRefresh);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnTheme').addEventListener('click', () => {
    const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
    setTheme(next);
  });

  /* --- 分类 --- */
  $('navCategories').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-category]');
    if (!btn) return;
    state.ui.category = btn.dataset.category;
    saveUiPrefs();
    syncUiControls();
    renderFeed();
  });

  $('btnFavorites').addEventListener('click', () => {
    state.ui.category = state.ui.category === 'favorites' ? 'all' : 'favorites';
    saveUiPrefs();
    syncUiControls();
    renderFeed();
  });

  $('btnShowAll').addEventListener('click', () => {
    state.ui.category = 'all';
    saveUiPrefs();
    syncUiControls();
    renderFeed();
  });

  /* --- 数据源开关 --- */
  $('sourceList').addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-source]');
    if (!input) return;
    const all = Array.from(document.querySelectorAll('#sourceList input[data-source]'));
    const enabled = all.filter((i) => i.checked).map((i) => i.dataset.source);
    // 全选等价于 null（默认全部启用），避免以后新增源被漏掉
    await applyConfig({ enabledSources: enabled.length === all.length ? null : enabled }, { silent: true });
    toast('数据源已更新，正在重新抓取…');
  });

  $('btnToggleAllSources').addEventListener('click', async () => {
    const all = Array.from(document.querySelectorAll('#sourceList input[data-source]'));
    const anyOff = all.some((i) => !i.checked);
    for (const i of all) i.checked = anyOff;
    const enabled = all.filter((i) => i.checked).map((i) => i.dataset.source);
    await applyConfig({ enabledSources: enabled.length === all.length ? null : enabled }, { silent: true });
    toast(anyOff ? '已启用全部数据源' : '已停用全部数据源（请在设置里至少启用一个）');
  });

  /* --- 工具栏 --- */
  const onSearch = debounce((value) => {
    state.ui.search = value.trim();
    $('btnClearSearch').hidden = !state.ui.search;
    renderFeed();
  }, 180);

  $('inputSearch').addEventListener('input', (e) => onSearch(e.target.value));
  $('btnClearSearch').addEventListener('click', () => {
    $('inputSearch').value = '';
    state.ui.search = '';
    $('btnClearSearch').hidden = true;
    renderFeed();
  });

  $('segSort').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    state.ui.sort = btn.dataset.sort;
    saveUiPrefs();
    syncUiControls();
    renderFeed();
  });

  $('chkUnreadOnly').addEventListener('change', (e) => {
    state.ui.unreadOnly = e.target.checked;
    saveUiPrefs();
    renderFeed();
  });

  $('chkKeywordOnly').addEventListener('change', (e) => {
    state.ui.keywordOnly = e.target.checked;
    saveUiPrefs();
    renderFeed();
  });

  $('btnMarkAllRead').addEventListener('click', async () => {
    // 只标记「当前可见」的条目，而不是全部条目：
    // 用户看到的按钮文案是当前视图，把被筛掉的内容也标成已读会造成未读数对不上。
    const list = visibleItems();
    const unread = list.filter((i) => !i.read);
    if (!unread.length) {
      toast('当前视图没有未读内容');
      return;
    }
    for (const item of unread) item.read = true;
    state.snapshot.unreadCount = state.snapshot.items.filter((i) => !i.read).length;
    renderFeed();
    renderStatus();
    try {
      await window.api.markRead(unread.map((i) => i.id), true);
      toast(`已将当前视图的 ${unread.length} 条标记为已读`, 'ok');
    } catch (err) {
      toast(`标记失败：${err.message}`, 'err');
    }
  });

  /* --- 关键词快捷筛选 --- */
  $('keywordBar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-keyword]');
    if (!btn) return;
    const kw = btn.dataset.keyword;
    state.ui.activeKeyword = state.ui.activeKeyword === kw ? '' : kw;
    renderKeywordBar();
    renderFeed();
  });

  /* --- 卡片交互（事件委托） --- */
  $('feed').addEventListener('click', async (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const item = state.snapshot.items.find((i) => i.id === id);
    if (!item) return;

    const actionBtn = e.target.closest('[data-action]');
    const action = actionBtn ? actionBtn.dataset.action : '';

    if (action === 'open') {
      await window.api.openExternal(item.arxivUrl && e.altKey ? item.arxivUrl : item.link);
      if (!item.read) markRead(id, true);
      return;
    }

    if (action === 'star') {
      const res = await window.api.toggleFavorite(item);
      if (res && typeof res.favorite === 'boolean') {
        rememberLocal(localFav, item.id, res.favorite);
      }
      applySnapshot(res.snapshot);
      toast(res.favorite ? '已加入收藏' : '已取消收藏', res.favorite ? 'ok' : '');
      return;
    }

    if (action === 'read') {
      markRead(id, !item.read);
      return;
    }

    // 点击卡片主体：展开/收起并标记已读
    if (state.openIds.has(id)) state.openIds.delete(id);
    else {
      state.openIds.add(id);
      if (!item.read) markRead(id, true);
    }
    const el = state.rendered.get(id);
    if (el) updateCard(el, item);
  });

  /* --- 空状态按钮 --- */
  $('btnEmptyRefresh').addEventListener('click', doRefresh);

  /* --- 设置面板 --- */
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target.dataset.close) closeSettings();

    const rm = e.target.closest('[data-remove-keyword]');
    if (rm) {
      const kw = rm.dataset.removeKeyword;
      const cfg = state.snapshot.config || {};
      applyConfig({ keywords: (cfg.keywords || []).filter((k) => k !== kw) }, { silent: true });
    }
  });

  $('selInterval').addEventListener('change', (e) => applyConfig({ refreshMinutes: Number(e.target.value) }));
  $('selMaxItems').addEventListener('change', (e) => applyConfig({ maxItems: Number(e.target.value) }));
  $('chkNotify').addEventListener('change', (e) => applyConfig({ notifyEnabled: e.target.checked }));
  $('chkLaunchAtLogin').addEventListener('change', (e) => applyConfig({ launchAtLogin: e.target.checked }));
  $('chkCloseToTray').addEventListener('change', (e) => applyConfig({ closeToTray: e.target.checked }));

  $('rangeNotifyScore').addEventListener('input', (e) => {
    $('outNotifyScore').textContent = e.target.value;
  });
  $('rangeNotifyScore').addEventListener('change', (e) =>
    applyConfig({ notifyMinScore: Number(e.target.value) }, { silent: true })
  );

  $('btnTestNotify').addEventListener('click', async () => {
    const ok = await window.api.testNotification();
    toast(ok ? '测试通知已发送，请查看系统通知中心' : '当前系统不支持通知', ok ? 'ok' : 'err');
  });

  const addKeyword = () => {
    const input = $('inputKeyword');
    const value = input.value.trim();
    if (!value) return;
    const cfg = state.snapshot.config || {};
    const list = cfg.keywords || [];
    if (list.includes(value)) {
      toast('该关键词已存在');
      input.value = '';
      return;
    }
    applyConfig({ keywords: [...list, value] }, { silent: true });
    input.value = '';
    toast(`已添加关注词：${value}`, 'ok');
  };
  $('btnAddKeyword').addEventListener('click', addKeyword);
  $('inputKeyword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addKeyword();
  });

  $('btnOpenData').addEventListener('click', () => window.api.openPath('userData'));

  /* --- 快捷键 --- */
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (!$('settingsModal').hidden) closeSettings();
      else if (state.ui.search) {
        $('inputSearch').value = '';
        state.ui.search = '';
        $('btnClearSearch').hidden = true;
        renderFeed();
      }
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('inputSearch').focus();
      $('inputSearch').select();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      setTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light');
      return;
    }
    if (ctrl && e.key === ',') {
      e.preventDefault();
      openSettings();
      return;
    }
    if (e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      doRefresh();
    }
  });

  /* --- 主进程事件 --- */
  window.api.onUpdate((snap) => applySnapshot(snap));
  window.api.onStatus((s) => {
    state.snapshot.refreshing = Boolean(s.refreshing);
    if (!s.refreshing) {
      state.progress = { finished: 0, total: 0 };
      if (s.ok === false && s.error) {
        toast(`刷新失败：${s.error}`, 'err');
      } else if (s.newCount && !state.manualRefresh) {
        // 自动刷新时告知有新内容；手动刷新由 doRefresh 统一提示，避免一次刷新弹两条
        toast(`发现 ${s.newCount} 条新内容`, 'ok');
      }
    } else {
      state.progress = { finished: 0, total: 0 };
    }
    renderStatus();
    renderProgress();
  });
  window.api.onProgress((p) => {
    state.progress = { finished: p.finished, total: p.total };
    renderStatus();
    renderProgress();
  });
  window.api.onHighlight((id) => {
    const card = state.rendered.get(id);
    if (!card) {
      toast('该内容已被新内容挤出列表，可在搜索中查找');
      return;
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('is-flash');
    setTimeout(() => card.classList.remove('is-flash'), 2000);
  });
  window.api.onConfigChanged((cfg) => {
    state.snapshot.config = cfg;
    renderKeywordBar();
    renderFeed();
  });
}

function setTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
  try {
    localStorage.setItem('ai-radar:theme', theme);
  } catch {
    /* 忽略 */
  }
  const icon = $('themeIcon');
  icon.innerHTML =
    theme === 'light'
      ? '<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5v2m0 18v-2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>'
      : '<path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.39 5.39 0 0 1 12 3z"/>';
}

async function doRefresh() {
  if (state.snapshot.refreshing) return;
  state.manualRefresh = true;
  state.snapshot.refreshing = true;
  state.progress = { finished: 0, total: 0 };
  renderStatus();
  renderProgress();
  try {
    const res = await window.api.refresh();
    if (res && res.snapshot) applySnapshot(res.snapshot);
    if (res && res.result && res.result.ok === false) {
      toast(`刷新失败：${res.result.error || '未知错误'}`, 'err');
    } else if (res && res.result && !res.result.skipped) {
      const n = res.result.newCount || 0;
      toast(n ? `刷新完成，新增 ${n} 条` : '刷新完成，暂无新内容', 'ok');
    }
  } catch (err) {
    toast(`刷新失败：${err.message}`, 'err');
  } finally {
    state.manualRefresh = false;
    state.snapshot.refreshing = false;
    renderStatus();
    renderProgress();
  }
}

async function markRead(id, read) {
  const item = state.snapshot.items.find((i) => i.id === id);
  if (!item) return;
  item.read = read;
  // 记录本地乐观状态，防止在途快照把它刷回去
  rememberLocal(localRead, id, read);
  if (window.__debug) window.__debug.read[id] = read;
  state.snapshot.unreadCount = state.snapshot.items.filter((i) => !i.read).length;
  const card = state.rendered.get(id);
  if (card) updateCard(card, item);
  renderStatus();
  try {
    await window.api.markRead([id], read);
  } catch {
    /* 状态已本地更新，落盘失败不影响使用 */
  }
}

/* ============================== 启动 ============================== */

document.addEventListener('DOMContentLoaded', () => {
  bootstrap().catch((err) => {
    toast(`启动失败：${err.message}`, 'err');
    console.error(err);
  });

  // 定时刷新相对时间显示
  setInterval(() => {
    for (const item of state.snapshot.items) {
      const card = state.rendered.get(item.id);
      if (card) {
        const t = card.querySelector('.card__time');
        if (t) t.textContent = relativeTime(item.publishedAt);
      }
    }
    renderStatus();
  }, 60000);
});
