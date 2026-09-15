'use strict';

/**
 * 刷新调度器：负责定时抓取、结果合并、缓存落盘、新内容通知。
 *
 * 通知策略（避免打扰）：
 *  - 首次抓取不发通知（否则一启动就弹一堆）。
 *  - 每次刷新最多推送 3 条，按「重要度」排序。
 *  - 重要度 = 源权重 + 命中用户关注关键词 + 社区热度。
 *  - 已推送过的条目 id 进内存集合，不会重复通知。
 */

const { EventEmitter } = require('events');
const { SOURCES } = require('./sources');
const { fetchAll } = require('./aggregator');

const MAX_NOTIFY_PER_ROUND = 3;

class Scheduler extends EventEmitter {
  /**
   * @param {import('./store').Store} store
   */
  constructor(store) {
    super();
    this.store = store;
    this.timer = null;
    this.refreshing = false;
    this.lastResult = null;
    this.notifiedIds = new Set();
    this.firstRunDone = false;
    this._stopped = false;
  }

  /** 当前启用的源列表（按用户的 enabledSources 过滤）。 */
  activeSources() {
    const cfg = this.store.getConfig();
    if (!Array.isArray(cfg.enabledSources)) return SOURCES.filter((s) => s.enabled !== false);
    const allowed = new Set(cfg.enabledSources);
    return SOURCES.filter((s) => allowed.has(s.id));
  }

  /** 启动定时器并立即抓取一次。 */
  start() {
    this._stopped = false;
    // 先用缓存把界面点亮，再去抓最新的
    const cached = this.store.readCache();
    if (cached) {
      this.lastResult = {
        items: cached.items,
        statuses: cached.statuses || [],
        fetchedAt: cached.fetchedAt,
        durationMs: cached.durationMs || 0,
        totalRaw: cached.totalRaw || cached.items.length,
        fromCache: true
      };
      this.emit('update', this.snapshot());
    }

    this.refresh('startup');
    this.schedule();
    return this;
  }

  /** 重新设定定时器（配置变更后调用）。 */
  schedule() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._stopped) return;
    const minutes = this.store.getConfig().refreshMinutes;
    const ms = Math.max(1, minutes) * 60 * 1000;
    this.timer = setInterval(() => this.refresh('timer'), ms);
    // 定时器不应阻止进程退出
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this._stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 执行一次刷新。
   * @param {string} reason startup | timer | manual | config
   * @returns {Promise<object>} 本次结果快照
   */
  async refresh(reason = 'manual') {
    if (this.refreshing) {
      return { skipped: true, reason: 'already-refreshing', snapshot: this.snapshot() };
    }
    this.refreshing = true;
    this.emit('status', { refreshing: true, reason });

    try {
      const sources = this.activeSources();
      if (!sources.length) {
        this.refreshing = false;
        this.emit('status', { refreshing: false, reason, error: '没有启用任何数据源' });
        return { ok: false, error: '没有启用任何数据源', snapshot: this.snapshot() };
      }

      const result = await fetchAll(sources, {
        onProgress: (p) => this.emit('progress', p)
      });

      const previousIds = new Set((this.lastResult ? this.lastResult.items : []).map((i) => i.id));
      const isFirst = !this.firstRunDone;
      this.firstRunDone = true;

      this.lastResult = {
        items: result.items,
        statuses: result.statuses,
        fetchedAt: result.fetchedAt,
        durationMs: result.durationMs,
        totalRaw: result.totalRaw,
        droppedOld: result.droppedOld,
        fromCache: false
      };
      this.store.writeCache(this.lastResult);

      const snapshot = this.snapshot();
      this.emit('update', snapshot);

      // 新条目：用于通知与未读计数
      const fresh = isFirst || reason === 'startup'
        ? []
        : result.items.filter((i) => !previousIds.has(i.id) && !this.notifiedIds.has(i.id));

      const notifiable = this.pickNotifiable(fresh);
      if (notifiable.length) {
        notifiable.forEach((i) => this.notifiedIds.add(i.id));
        this.emit('notify', { items: notifiable, reason });
      }

      this.emit('status', {
        refreshing: false,
        reason,
        ok: true,
        fetchedAt: result.fetchedAt,
        newCount: fresh.length,
        error: ''
      });

      return { ok: true, snapshot, newCount: fresh.length };
    } catch (err) {
      this.emit('status', {
        refreshing: false,
        reason,
        ok: false,
        error: err && err.message ? err.message : String(err)
      });
      return { ok: false, error: err && err.message ? err.message : String(err), snapshot: this.snapshot() };
    } finally {
      this.refreshing = false;
    }
  }

  /** 从新条目中挑选值得打扰用户的通知项。 */
  pickNotifiable(items) {
    const cfg = this.store.getConfig();
    if (!cfg.notifyEnabled || !items.length) return [];
    const threshold = cfg.notifyMinScore;

    const scored = items
      .map((item) => ({ item, score: this.scoreItem(item, cfg) }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, MAX_NOTIFY_PER_ROUND).map((x) => x.item);
  }

  /** 重要度评分：源权重(1-10) + 关键词命中 + 社区热度。 */
  scoreItem(item, cfg = this.store.getConfig()) {
    const source = SOURCES.find((s) => s.id === item.sourceId);
    let score = source ? Math.round(((source.weight || 50) / 100) * 8) : 4;

    const haystack = `${item.title} ${item.summary || ''}`.toLowerCase();
    const hits = (cfg.keywords || []).filter((k) => k && haystack.includes(String(k).toLowerCase()));
    score += Math.min(3, hits.length * 1.5);

    if (item.points && item.points >= 200) score += 1.5;
    else if (item.points && item.points >= 50) score += 0.5;

    // 官方一手发布优先级更高
    if (['openai-blog', 'google-ai-blog', 'hf-papers'].includes(item.sourceId)) score += 1;

    return score;
  }

  /** 生成给渲染进程的完整状态快照。 */
  snapshot() {
    const cfg = this.store.getConfig();
    const result = this.lastResult;
    const items = result ? result.items.slice(0, cfg.maxItems) : [];
    const readSet = this.store.getReadSet();

    return {
      items: items.map((item) => ({
        ...item,
        read: readSet.has(item.id),
        favorite: this.store.isFavorite(item.id)
      })),
      favorites: this.store.getFavorites(),
      statuses: result ? result.statuses : [],
      fetchedAt: result ? result.fetchedAt : null,
      durationMs: result ? result.durationMs : 0,
      totalRaw: result ? result.totalRaw : 0,
      fromCache: result ? Boolean(result.fromCache) : false,
      refreshing: this.refreshing,
      config: cfg,
      sources: SOURCES.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        lang: s.lang,
        homepage: s.homepage
      })),
      unreadCount: items.filter((i) => !readSet.has(i.id)).length
    };
  }
}

module.exports = { Scheduler };
