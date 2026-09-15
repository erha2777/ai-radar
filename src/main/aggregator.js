'use strict';

/**
 * 网络抓取层：并发受控地拉取所有数据源，解析、过滤、去重、排序。
 *
 * 关键设计：
 *  - 每个源独立超时（AbortController），单源失败不影响其它源。
 *  - 全局并发上限，避免同时打开十几个连接被限速。
 *  - 返回结构里带上每个源的成功/失败状态，界面可以如实展示。
 */

const { SOURCES, matchesAiKeywords } = require('./sources');
const { parseFeed, normalizeItem, canonicalUrl, makeId, htmlToText } = require('./parser');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * 部分源会按 User-Agent 做反爬判断，且实测行为反直觉：
 * 量子位与 MarkTechPost 都拒绝「完整浏览器 UA」，反而接受最简 UA。
 * 这里不做 UA 伪装去骗过风控，只按源声明其实际接受的请求头。
 */
const UA_MINIMAL = 'Mozilla/5.0';
const UA_TOOL = 'curl/8.4.0';

/** 请求头预设，源定义里用 headers: PRESET.xxx 引用。 */
const PRESET = {
  /** 默认：主流 AI/科技站点的 RSS 端点 */
  default: {
    'User-Agent': USER_AGENT,
    Accept: 'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  },
  /** 最简 UA：量子位等对浏览器 UA 返回 403 的站点 */
  minimal: {
    'User-Agent': UA_MINIMAL,
    Accept: 'application/rss+xml, application/xml, text/xml, */*'
  },
  /** 工具型 UA：MarkTechPost 等只对非浏览器 UA 放行 */
  tool: {
    'User-Agent': UA_TOOL,
    Accept: 'application/rss+xml, application/xml, text/xml, */*'
  },
  /** GitHub API（经代理） */
  github: {
    'User-Agent': UA_MINIMAL,
    Accept: 'application/vnd.github+json'
  }
};

const DEFAULT_TIMEOUT = 20000;
const MAX_CONCURRENCY = 6;
/** 只保留最近 N 天的内容，避免首次加载被历史文章淹没。 */
const MAX_AGE_DAYS = 21;

/** 带超时的 fetch，返回文本；非 2xx 抛错。 */
async function fetchText(url, { timeout = DEFAULT_TIMEOUT, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { ...PRESET.default, ...headers }
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 带超时的 fetch，返回 JSON。 */
async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('响应不是合法 JSON');
  }
}

/**
 * 判断错误是否值得重试。
 * 只对网络类抖动重试；HTTP 4xx 这类确定性错误重试没有意义。
 */
function isRetriable(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  if (err.status >= 400 && err.status < 500) return false;
  return /aborted|timeout|fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT|EAI_AGAIN|network/i.test(
    msg
  );
}

/** 执行抓取，失败时按次数重试（用于抵御间歇性网络超时）。 */
async function withRetry(fn, attempt = 1) {
  let lastErr;
  for (let i = 0; i < attempt; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempt - 1 || !isRetriable(err)) throw err;
      // 退避一下再试，避免立刻撞上同样的瞬时故障
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * 各类型源的抓取器
 * ------------------------------------------------------------------ */

/** RSS / Atom 源。 */
async function fetchRssSource(source, timeout) {
  const xml = await withRetry(
    () =>
      fetchText(source.url, {
        timeout: source.timeout || timeout,
        headers: source.headers || {}
      }),
    source.retries || 2
  );
  const items = parseFeed(xml, source);
  if (!items.length) throw new Error('未解析出任何条目（源格式可能已变更）');
  return items;
}

/** HuggingFace 每日论文（走 hf-mirror 镜像）。 */
async function fetchHfPapers(source, timeout) {
  const data = await withRetry(
    () =>
      fetchJson(source.url, {
        timeout: source.timeout || timeout,
        headers: source.headers || {}
      }),
    source.retries || 2
  );
  if (!Array.isArray(data)) throw new Error('返回结构不是数组');

  const out = [];
  for (const entry of data) {
    const paper = entry && entry.paper ? entry.paper : entry;
    if (!paper) continue;

    const arxivId = paper.id || '';
    const title = paper.title || '';
    if (!title) continue;

    const authors = Array.isArray(paper.authors)
      ? paper.authors.map((a) => (a && a.name) || '').filter(Boolean)
      : [];
    const authorText = authors.length
      ? authors.length > 3
        ? `${authors.slice(0, 3).join(', ')} 等 ${authors.length} 人`
        : authors.join(', ')
      : '';

    const link = arxivId
      ? `https://hf-mirror.com/papers/${arxivId}`
      : paper.url || source.homepage;

    // 镜像不提供摘要正文时用标题兜底
    const summaryRaw = paper.summary || entry.summary || '';
    const summary = htmlToText(summaryRaw).replace(/\s+/g, ' ').trim();

    const upvotes = Number(entry.upvotes ?? paper.upvotes ?? 0);
    const published = paper.publishedAt || entry.publishedAt || entry.date || null;

    const item = normalizeItem(
      {
        sourceId: source.id,
        sourceName: source.name,
        category: source.category,
        lang: source.lang,
        title,
        link,
        rawBody: '',
        summary,
        publishedAt: published ? safeIso(published) : null,
        author: authorText,
        image: '',
        tags: Array.isArray(paper.ai_keywords) ? paper.ai_keywords : [],
        points: Number.isFinite(upvotes) && upvotes > 0 ? upvotes : null,
        comments: null
      },
      source
    );
    if (item) {
      item.arxivId = arxivId;
      item.arxivUrl = arxivId ? `https://arxiv.org/abs/${arxivId}` : '';
      out.push(item);
    }
  }
  if (!out.length) throw new Error('镜像返回了数据但没有可用的论文条目');
  return out;
}

/**
 * HuggingFace 模型列表（走 hf-mirror 镜像）。
 * 用于追踪某个组织的模型发布，例如 DeepSeek 官方模型。
 */
async function fetchHfModels(source, timeout) {
  const data = await withRetry(
    () =>
      fetchJson(source.url, {
        timeout: source.timeout || timeout,
        headers: source.headers || {}
      }),
    source.retries || 2
  );
  if (!Array.isArray(data)) throw new Error('返回结构不是数组');

  const out = [];
  for (const model of data) {
    const id = model && (model.id || model.modelId);
    if (!id) continue;

    // 模型名取最后一段，标题里就不必重复组织名
    const shortName = String(id).split('/').pop();
    const downloads = Number(model.downloads) || 0;
    const likes = Number(model.likes) || 0;
    const parts = [];
    if (downloads) parts.push(`⬇ ${formatCount(downloads)}`);
    if (likes) parts.push(`♥ ${formatCount(likes)}`);
    if (model.pipeline_tag) parts.push(model.pipeline_tag);

    const item = normalizeItem(
      {
        sourceId: source.id,
        sourceName: source.name,
        category: source.category,
        lang: source.lang,
        title: shortName,
        link: `https://hf-mirror.com/${id}`,
        rawBody: '',
        summary: parts.length ? `HuggingFace 模型 · ${parts.join(' · ')}` : 'HuggingFace 模型',
        publishedAt: model.lastModified ? safeIso(model.lastModified) : null,
        author: String(id).split('/')[0] || '',
        image: '',
        // tags 里形如 "license:mit" 的元数据没有展示价值，过滤掉
        tags: Array.isArray(model.tags) ? model.tags.filter((t) => !String(t).includes(':')).slice(0, 6) : [],
        points: downloads || null,
        comments: null
      },
      source
    );
    if (item) out.push(item);
  }
  if (!out.length) throw new Error('镜像返回了数据但没有可用的模型条目');
  return out;
}

/**
 * GitHub 仓库搜索（走 gh-proxy.com 代理）。
 *
 * 注意：GitHub 搜索 API 会把「只含逻辑运算符、没有检索词」的查询判定为 422，
 * 所以 `topic:a OR topic:b` 这类写法非法。这里改为多条单条件查询后合并去重。
 */
async function fetchGithubSource(source, timeout) {
  const queries = Array.isArray(source.queries) && source.queries.length
    ? source.queries
    : [source.query].filter(Boolean);
  if (!queries.length) throw new Error('未配置搜索条件');

  const minStars = source.minStars || 50;
  const perQuery = source.perQuery || 30;

  // 逐条串行查询：GitHub 搜索接口本身开销大，5 条并发会挤满超时窗口，
  // 串行 + 单条短超时反而更稳（单条失败只损失该条结果）。
  const results = [];
  for (const q of queries) {
    const params = new URLSearchParams({
      q: `${q} stars:>=${minStars}`,
      sort: source.sort || 'updated',
      order: 'desc',
      per_page: String(perQuery)
    });
    try {
      const data = await fetchJson(`${source.url}?${params.toString()}`, {
        timeout: source.queryTimeout || 12000,
        headers: PRESET.github
      });
      if (Array.isArray(data.items)) results.push(data.items);
    } catch {
      // 单条查询失败不影响其它查询
    }
  }

  const repos = new Map();
  for (const list of results) {
    for (const repo of list) {
      if (repo && repo.full_name && !repos.has(repo.full_name)) repos.set(repo.full_name, repo);
    }
  }
  if (!repos.size) throw new Error('GitHub 未返回仓库结果');

  const out = [];
  for (const repo of repos.values()) {
    const pushedAt = repo.pushed_at || repo.updated_at || null;
    const desc = repo.description || '';
    const summaryParts = [];
    if (desc) summaryParts.push(desc);
    summaryParts.push(
      `⭐ ${formatCount(repo.stargazers_count)} · Fork ${formatCount(repo.forks_count)}${
        repo.language ? ` · ${repo.language}` : ''
      }`
    );

    const item = normalizeItem(
      {
        sourceId: source.id,
        sourceName: source.name,
        category: source.category,
        lang: source.lang,
        title: repo.full_name,
        link: repo.html_url,
        rawBody: '',
        summary: summaryParts.join('\n'),
        publishedAt: pushedAt ? safeIso(pushedAt) : null,
        author: (repo.owner && repo.owner.login) || '',
        image: '',
        tags: Array.isArray(repo.topics) ? repo.topics : [],
        points: Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : null,
        comments: Number.isFinite(repo.open_issues_count) ? repo.open_issues_count : null
      },
      source
    );
    if (item) out.push(item);
  }
  if (!out.length) throw new Error('GitHub 结果中没有可用条目');
  return out;
}

const FETCHERS = {
  rss: fetchRssSource,
  'hf-papers': fetchHfPapers,
  'hf-models': fetchHfModels,
  github: fetchGithubSource
};

/* ------------------------------------------------------------------ *
 * 调度
 * ------------------------------------------------------------------ */

/** 把任意日期字符串转成 ISO，失败返回 null。 */
function safeIso(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function formatCount(n) {
  const num = Number(n) || 0;
  if (num >= 10000) return `${(num / 1000).toFixed(1)}k`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

/**
 * 并发池：限制同时进行的任务数，保持结果顺序与输入一致。
 * @param {Array} items 输入列表
 * @param {number} limit 并发上限
 * @param {(item:any, index:number)=>Promise<any>} worker 任务函数
 */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = { __error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 抓取指定源集合。
 * @param {Array} sources 源定义数组
 * @param {{ onProgress?: Function, timeout?: number, filterFn?: Function }} options
 * @returns {Promise<{items: Array, statuses: Array, fetchedAt: string, durationMs: number}>}
 */
async function fetchAll(sources, options = {}) {
  const { onProgress = () => {}, timeout = DEFAULT_TIMEOUT, filterFn = matchesAiKeywords } = options;
  const startedAt = Date.now();
  const statuses = [];
  let finished = 0;

  const perSource = await mapPool(sources, MAX_CONCURRENCY, async (source) => {
    const t0 = Date.now();
    const status = {
      id: source.id,
      name: source.name,
      category: source.category,
      ok: false,
      count: 0,
      rawCount: 0,
      filteredCount: 0,
      error: '',
      ms: 0
    };

    try {
      const fetcher = FETCHERS[source.kind] || fetchRssSource;
      let items = await fetcher(source, timeout);
      if (!Array.isArray(items)) items = [];
      status.rawCount = items.length;

      // 全站型科技源需要按 AI 关键词过滤
      if (source.filterKeywords && typeof filterFn === 'function') {
        const before = items.length;
        items = items.filter((it) => filterFn(`${it.title} ${it.summary || ''} ${(it.tags || []).join(' ')}`));
        status.filteredCount = before - items.length;
      }

      status.ok = true;
      status.items = items;
      status.count = items.length;
    } catch (err) {
      status.ok = false;
      status.error = describeError(err);
      status.items = [];
    } finally {
      status.ms = Date.now() - t0;
      finished += 1;
      onProgress({ finished, total: sources.length, source, status });
    }

    return status;
  });

  const allItems = [];
  for (const status of perSource) {
    if (!status || status.__error) {
      statuses.push({
        id: 'unknown',
        name: '未知源',
        ok: false,
        count: 0,
        rawCount: 0,
        error: describeError(status && status.__error),
        ms: 0
      });
      continue;
    }
    if (Array.isArray(status.items)) allItems.push(...status.items);
    delete status.items;
    statuses.push(status);
  }

  // 时效过滤：每个源可以用 maxAgeDays 覆盖默认窗口。
  // 专题源（如量子位的 DeepSeek 标签页）更新很慢，平均一个多月才一篇，
  // 统一用 21 天会把内容全部丢掉，所以允许按源放宽。
  const now = Date.now();
  const defaultCutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const cutoffBySource = new Map();
  for (const s of sources) {
    const days = Number(s.maxAgeDays);
    cutoffBySource.set(
      s.id,
      Number.isFinite(days) && days > 0 ? now - days * 24 * 60 * 60 * 1000 : defaultCutoff
    );
  }

  const fresh = allItems.filter((it) => {
    if (!it.publishedAt) return true; // 无时间的保留，交给排序兜底
    const ms = Date.parse(it.publishedAt);
    if (!Number.isFinite(ms)) return true;
    return ms >= (cutoffBySource.get(it.sourceId) ?? defaultCutoff);
  });

  const merged = dedupe(fresh).sort(byRecency);

  return {
    items: merged,
    statuses,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    totalRaw: allItems.length,
    droppedOld: allItems.length - fresh.length
  };
}

/** 去重：优先按归一化 URL，其次按标题指纹（跨源转载合并，保留权重高的源）。 */
function dedupe(items) {
  const byUrl = new Map();
  const byTitle = new Map();

  const score = (it) => {
    let s = 0;
    if (it.image) s += 2;
    if (it.summary && it.summary.length > 60) s += 2;
    if (it.body) s += 3;
    if (it.points) s += Math.min(3, it.points / 100);
    return s;
  };

  for (const item of items) {
    const url = canonicalUrl(item.link) || item.link;
    const titleKey = normalizeTitle(item.title);

    const existingUrl = byUrl.get(url);
    if (existingUrl) {
      if (score(item) > score(existingUrl)) {
        byUrl.set(url, item);
        byTitle.set(titleKey, item);
      }
      continue;
    }

    const existingTitle = byTitle.get(titleKey);
    if (existingTitle) {
      // 同一标题不同链接：保留信息更全的一条，另一条链接记进 altLinks
      const winner = score(item) > score(existingTitle) ? item : existingTitle;
      const loser = winner === item ? existingTitle : item;
      winner.altLinks = Array.isArray(winner.altLinks) ? winner.altLinks : [];
      if (loser.link && loser.link !== winner.link) winner.altLinks.push(loser.link);
      // 重新登记 winner 覆盖 loser 的 url 键
      byUrl.delete(canonicalUrl(loser.link) || loser.link);
      byUrl.set(canonicalUrl(winner.link) || winner.link, winner);
      byTitle.set(titleKey, winner);
      continue;
    }

    byUrl.set(url, item);
    byTitle.set(titleKey, item);
  }

  return Array.from(new Set(byUrl.values()));
}

/** 标题指纹：去掉标点空白与常见前后缀，用于跨源判重。 */
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[|｜\-–—_·:：,，.。!！?？"'“”‘’()（）\[\]【】<>《》]/g, '')
    .slice(0, 60);
}

/** 排序：先按发布时间倒序，无时间的排最后；同时间按源权重。 */
function byRecency(a, b) {
  const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
  const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
  if (tb !== ta) return tb - ta;
  const wa = (a.points || 0) + (a.body ? 1 : 0);
  const wb = (b.points || 0) + (b.body ? 1 : 0);
  return wb - wa;
}

/** 把异常转成给用户看得懂的中文描述。 */
function describeError(err) {
  if (!err) return '未知错误';
  const msg = String(err.message || err);
  if (err.name === 'AbortError' || /aborted|timeout/i.test(msg)) return '请求超时（网络不可达）';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg)) return '网络连接失败（可能被墙）';
  if (/HTTP 4\d\d/.test(msg)) return `源返回 ${msg}（可能已失效）`;
  if (/HTTP 5\d\d/.test(msg)) return `源服务器错误 ${msg}`;
  if (/JSON/.test(msg)) return '返回格式异常';
  return msg.slice(0, 120);
}

module.exports = { fetchAll, fetchText, fetchJson, describeError, safeIso, normalizeTitle };
