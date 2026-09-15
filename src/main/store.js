'use strict';

/**
 * 本地持久化层。
 *
 * 三类数据分开存放，互不干扰：
 *  - config.json      用户设置（刷新间隔、关键词、启用源、通知开关…）
 *  - state.json       阅读状态（已读 id、收藏条目快照）
 *  - cache.json       最近一次成功抓取的结果，用于离线启动时立刻渲染
 *
 * 所有写入都走「先写临时文件再原子重命名」，避免断电/崩溃留下半截 JSON。
 */

const fs = require('fs');
const path = require('path');

const MAX_READ_IDS = 3000;
const MAX_CACHE_ITEMS = 600;
const MAX_FAVORITES = 500;

const DEFAULT_CONFIG = {
  refreshMinutes: 5,
  notifyEnabled: true,
  notifyMinScore: 3,
  launchAtLogin: false,
  closeToTray: true,
  maxItems: 500,
  theme: 'dark',
  enabledSources: null, // null 表示全部启用；否则为启用的源 id 数组
  keywords: ['大模型', 'Agent', '开源', '发布', 'GPT', 'Claude', 'Gemini', 'DeepSeek'],
  keywordOnly: false
};

class Store {
  constructor(baseDir) {
    this.dir = baseDir;
    this.paths = {
      config: path.join(baseDir, 'config.json'),
      state: path.join(baseDir, 'state.json'),
      cache: path.join(baseDir, 'cache.json')
    };
    this.config = { ...DEFAULT_CONFIG };
    this.state = { read: [], favorites: [], lastSeenAt: null };
    this.cache = null;

    this._readSet = new Set();
    this._favMap = new Map();
  }

  /** 从磁盘加载全部数据；文件不存在或损坏时回退到默认值。 */
  load() {
    fs.mkdirSync(this.dir, { recursive: true });

    const cfg = this._readJson(this.paths.config);
    if (cfg && typeof cfg === 'object') {
      this.config = { ...DEFAULT_CONFIG, ...cfg };
      // 类型纠偏，防止手改配置文件写入非法值
      this.config.refreshMinutes = clamp(Number(this.config.refreshMinutes) || 5, 1, 240);
      this.config.maxItems = clamp(Number(this.config.maxItems) || 500, 50, 3000);
      this.config.notifyMinScore = clamp(Number(this.config.notifyMinScore) || 3, 1, 10);
      if (!Array.isArray(this.config.keywords)) this.config.keywords = [...DEFAULT_CONFIG.keywords];
      if (this.config.enabledSources !== null && !Array.isArray(this.config.enabledSources)) {
        this.config.enabledSources = null;
      }
    }

    const state = this._readJson(this.paths.state);
    if (state && typeof state === 'object') {
      this.state.read = Array.isArray(state.read) ? state.read.filter((x) => typeof x === 'string') : [];
      this.state.favorites = Array.isArray(state.favorites) ? state.favorites.filter((x) => x && x.id) : [];
      this.state.lastSeenAt = typeof state.lastSeenAt === 'string' ? state.lastSeenAt : null;
    }
    this._readSet = new Set(this.state.read);
    this._favMap = new Map(this.state.favorites.map((f) => [f.id, f]));

    this.cache = this._readJson(this.paths.cache);
    return this;
  }

  _readJson(file) {
    try {
      if (!fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch (err) {
      // 损坏的 JSON 备份一份，方便排查，不阻塞启动
      try {
        if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt`);
      } catch {
        /* 忽略 */
      }
      return null;
    }
  }

  _writeJson(file, data) {
    const tmp = `${file}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      // 重命名在部分环境下可能失败，降级为直接写入
      try {
        fs.writeFileSync(file, payload, 'utf8');
        return true;
      } catch {
        return false;
      }
    }
  }

  /* ----------------------------- 配置 ----------------------------- */

  getConfig() {
    return { ...this.config, keywords: [...this.config.keywords] };
  }

  /** 合并式更新配置并落盘，返回更新后的完整配置。 */
  updateConfig(patch) {
    if (patch && typeof patch === 'object') {
      const next = { ...this.config, ...patch };
      next.refreshMinutes = clamp(Number(next.refreshMinutes) || 5, 1, 240);
      next.maxItems = clamp(Number(next.maxItems) || 500, 50, 3000);
      next.notifyMinScore = clamp(Number(next.notifyMinScore) || 3, 1, 10);
      next.notifyEnabled = Boolean(next.notifyEnabled);
      next.launchAtLogin = Boolean(next.launchAtLogin);
      next.closeToTray = Boolean(next.closeToTray);
      next.keywordOnly = Boolean(next.keywordOnly);
      next.theme = next.theme === 'light' ? 'light' : 'dark';
      if (!Array.isArray(next.keywords)) next.keywords = [...DEFAULT_CONFIG.keywords];
      next.keywords = next.keywords
        .map((k) => String(k || '').trim())
        .filter(Boolean)
        .slice(0, 60);
      if (next.enabledSources !== null) {
        if (!Array.isArray(next.enabledSources)) next.enabledSources = null;
        else next.enabledSources = next.enabledSources.map(String);
      }
      this.config = next;
    }
    this._writeJson(this.paths.config, this.config);
    return this.getConfig();
  }

  /* --------------------------- 阅读状态 --------------------------- */

  getReadSet() {
    return this._readSet;
  }

  isRead(id) {
    return this._readSet.has(id);
  }

  markRead(ids, read = true) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      if (typeof id !== 'string' || !id) continue;
      if (read) this._readSet.add(id);
      else this._readSet.delete(id);
    }
    // 控制文件体积：超出上限时丢弃最早记录（Set 保持插入顺序）
    while (this._readSet.size > MAX_READ_IDS) {
      const oldest = this._readSet.values().next().value;
      this._readSet.delete(oldest);
    }
    this.state.read = Array.from(this._readSet);
    this._writeJson(this.paths.state, this.state);
    return true;
  }

  markAllRead(ids) {
    return this.markRead(ids, true);
  }

  /* ---------------------------- 收藏 ---------------------------- */

  getFavorites() {
    return Array.from(this._favMap.values()).sort(
      (a, b) => Date.parse(b.savedAt || 0) - Date.parse(a.savedAt || 0)
    );
  }

  isFavorite(id) {
    return this._favMap.has(id);
  }

  /** 切换收藏；item 为条目快照，保证原文失效后收藏仍可读。 */
  toggleFavorite(item) {
    if (!item || !item.id) return { ok: false, favorite: false };
    if (this._favMap.has(item.id)) {
      this._favMap.delete(item.id);
    } else {
      this._favMap.set(item.id, {
        id: item.id,
        title: item.title,
        link: item.link,
        summary: item.summary,
        body: item.body ? String(item.body).slice(0, 4000) : '',
        image: item.image || '',
        author: item.author || '',
        sourceId: item.sourceId,
        sourceName: item.sourceName,
        category: item.category,
        lang: item.lang,
        publishedAt: item.publishedAt,
        savedAt: new Date().toISOString()
      });
      while (this._favMap.size > MAX_FAVORITES) {
        const oldest = this._favMap.keys().next().value;
        this._favMap.delete(oldest);
      }
    }
    this.state.favorites = Array.from(this._favMap.values());
    this._writeJson(this.paths.state, this.state);
    return { ok: true, favorite: this._favMap.has(item.id) };
  }

  /* ---------------------------- 缓存 ---------------------------- */

  readCache() {
    if (!this.cache || !Array.isArray(this.cache.items)) return null;
    return this.cache;
  }

  writeCache(result) {
    if (!result || !Array.isArray(result.items)) return false;
    this.cache = {
      fetchedAt: result.fetchedAt,
      durationMs: result.durationMs || 0,
      totalRaw: result.totalRaw || result.items.length,
      items: result.items.slice(0, MAX_CACHE_ITEMS),
      statuses: (result.statuses || []).map((s) => ({ ...s }))
    };
    return this._writeJson(this.paths.cache, this.cache);
  }

  setLastSeenAt(iso) {
    this.state.lastSeenAt = iso;
    this._writeJson(this.paths.state, this.state);
  }

  get lastSeenAt() {
    return this.state.lastSeenAt;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = { Store, DEFAULT_CONFIG };
