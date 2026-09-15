'use strict';

/**
 * 零依赖 RSS 2.0 / Atom 1.0 解析器 + HTML 清洗工具。
 *
 * 设计原则：
 *  - 绝不引入第三方 XML 库（离线可维护、无供应链风险）。
 *  - 所有字段都做防御性兜底，单个脏 item 不能拖垮整批抓取。
 *  - 解析失败返回空数组而不是抛异常，由上层决定如何记录错误。
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0',
  times: '\u00d7', divide: '\u00f7', laquo: '\u00ab', raquo: '\u00bb',
  bull: '\u2022', prime: '\u2032', Prime: '\u2033', euro: '\u20ac',
  pound: '\u00a3', yen: '\u00a5', sect: '\u00a7', para: '\u00b6',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', shy: ''
};

/** 解码 HTML 实体，支持命名实体与十进制/十六进制数字实体。 */
function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/** 去掉 CDATA 包装，做实体解码与首尾空白清理。 */
function cleanText(raw) {
  if (raw === undefined || raw === null) return '';
  let text = String(raw);
  // 反复解 CDATA 包装（部分源存在嵌套）
  for (let i = 0; i < 3 && /<!\[CDATA\[/.test(text); i += 1) {
    text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  }
  // 实体可能被二次转义（如 &amp;lt;），循环解码到稳定状态
  let prev = null;
  for (let i = 0; i < 3 && prev !== text; i += 1) {
    prev = text;
    text = decodeEntities(text);
  }
  return text.trim();
}

/**
 * 取第一个匹配的标签内容（大小写不敏感，支持属性与自闭合）。
 * 找不到返回空串。
 */
function pickTag(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1] : '';
}

/**
 * 尝试多个候选标签名，返回第一个非空结果。
 * 用于兼容 RSS / Atom / 各家自定义扩展字段。
 */
function pickAny(xml, tagNames) {
  for (const tag of tagNames) {
    const value = pickTag(xml, tag);
    if (value && cleanText(value)) return value;
  }
  return '';
}

/** 把 HTML 正文转成可读纯文本（保留段落换行，剔除脚本样式与图片）。 */
function htmlToText(html) {
  if (!html) return '';
  let text = String(html);
  // 纯文本快速路径：连实体引用都没有才可直接返回。
  // 注意必须同时判断 & ——二次转义的正文（&amp;lt;p&amp;gt;）里没有 < 但有 &，
  // 只看 < 会让这类正文跳过解码，把转义标签当成正文显示出来。
  if (!/[<&]/.test(text)) return text.trim();

  // CDATA 与二次转义解码
  text = cleanText(text);
  // 丢弃不可见内容
  text = text.replace(/<(script|style|noscript|iframe|svg|video|audio)\b[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // 块级元素转换行
  text = text.replace(/<\s*br\s*\/?>/gi, '\n');
  text = text.replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|blockquote|section|article)\s*>/gi, '\n');
  text = text.replace(/<\s*li\b[^>]*>/gi, '\n· ');
  // 剔除剩余标签
  text = text.replace(/<[^>]+>/g, '');
  // 最终实体解码
  text = decodeEntities(text);
  // 规整空白
  text = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
  return text;
}

/** 从 HTML 中提取首张有意义的图片地址（跳过 data: 与 1x1 追踪像素）。 */
function extractImage(html, baseUrl) {
  if (!html) return '';
  const re = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let src = decodeEntities(m[1]).trim();
    if (!src) continue;
    if (/^data:/i.test(src)) continue;
    if (/\.(gif|svg)(\?|$)/i.test(src) && /spacer|blank|pixel|1x1/i.test(src)) continue;
    if (/^\/\//.test(src)) src = `https:${src}`;
    else if (/^\//.test(src) && baseUrl) {
      try {
        src = new URL(src, baseUrl).href;
      } catch {
        /* 保持原样 */
      }
    }
    if (/^https?:\/\//i.test(src)) return src;
  }
  return '';
}

/** 解析日期：支持 RFC822（RSS）与 ISO8601（Atom），失败返回 null。 */
function parseDate(raw) {
  const text = cleanText(raw);
  if (!text) return null;

  // 少数源使用 "2026-09-15 10:30:00" 这类无时区格式
  const loose = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (loose) {
    const [, y, mo, d, h, mi, s] = loose;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;

  // 拒绝明显离谱的时间（解析错位 / 占位值）
  const year = new Date(ms).getUTCFullYear();
  if (year < 1990 || year > 2200) return null;
  return new Date(ms).toISOString();
}

/** 从形如 <link href="..."/> 的 Atom 节点里取地址。 */
function pickAtomLink(xml) {
  // 优先 rel="alternate"，其次无 rel，最后任意 href
  const links = [];
  const re = /<link\b([^>]*)\/?>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!href) continue;
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attrs);
    links.push({ href: decodeEntities(href[1]).trim(), rel: rel ? rel[1].toLowerCase() : '' });
  }
  const alternate = links.find((l) => l.rel === 'alternate');
  if (alternate) return alternate.href;
  const plain = links.find((l) => !l.rel);
  if (plain) return plain.href;
  return links.length ? links[0].href : '';
}

/** 将单个 RSS <item> 或 Atom <entry> 归一化为原始字段对象。 */
function parseEntry(entryXml, format, source) {
  let link = '';
  if (format === 'atom') {
    link = pickAtomLink(entryXml) || cleanText(pickAny(entryXml, ['id', 'guid']));
  } else {
    const linkRaw = pickTag(entryXml, 'link');
    link = cleanText(linkRaw) || pickAtomLink(entryXml);
    if (!link) {
      const guidRaw = pickTag(entryXml, 'guid');
      const isPerma = /isPermaLink\s*=\s*["']?true/i.test(guidRaw) || !/</.test(guidRaw);
      const guidText = cleanText(guidRaw.replace(/^<guid[^>]*>/i, ''));
      if (isPerma && /^https?:/i.test(guidText)) link = guidText;
    }
  }

  const title = cleanText(pickAny(entryXml, ['title']));
  const bodyHtml =
    pickAny(entryXml, ['content:encoded', 'content', 'description', 'summary', 'dc:description']) || '';
  const pubRaw = pickAny(entryXml, [
    'pubDate', 'published', 'updated', 'dc:date', 'date', 'lastBuildDate'
  ]);
  const author = cleanText(pickAny(entryXml, ['dc:creator', 'author', 'name', 'creator']));

  const categories = [];
  const catRe = /<category\b[^>]*>([\s\S]*?)<\/category>/gi;
  let cm;
  while ((cm = catRe.exec(entryXml)) !== null) {
    const c = cleanText(cm[1]);
    if (c) categories.push(c);
  }

  /* eslint-disable no-use-before-define */
  return normalizeItem({
    sourceId: source.id,
    sourceName: source.name,
    category: source.category,
    lang: source.lang,
    title,
    link,
    rawBody: bodyHtml,
    publishedAt: parseDate(pubRaw),
    author,
    image: '',
    tags: categories,
    points: null,
    comments: null
  }, source);
  /* eslint-enable no-use-before-define */
}

/** 解析 RSS 2.0 或 Atom 文档，返回归一化后的条目数组。 */
function parseFeed(xml, source) {
  if (!xml || typeof xml !== 'string') return [];
  const text = xml.replace(/^\uFEFF/, '').trim();
  if (!text) return [];

  // 判断格式：Atom 有 <feed>，RSS 有 <rss> 或 <channel>
  const isAtom = /<feed[\s>]/i.test(text.slice(0, 3000)) && !/<rss[\s>]/i.test(text.slice(0, 3000));
  const format = isAtom ? 'atom' : 'rss';

  // 先摘出 item/entry 区块，避免 channel 级元数据被误当作条目
  const entryRe = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const entries = text.match(entryRe) || [];
  if (!entries.length) return [];

  const out = [];
  const seen = new Set();
  for (const entryXml of entries) {
    try {
      const item = parseEntry(entryXml, format, source);
      if (!item || !item.title || !item.link) continue;
      const key = `${item.title}::${item.link}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    } catch {
      // 单条解析失败静默跳过
    }
  }
  return out;
}

/**
 * 判断一段摘要是否含有实际信息量。
 *
 * 部分源（如 InfoQ 中文）的 RSS description 里只有「点击查看原文」这类导航链接，
 * 正文需要登录才能看到。这类占位文本显示出来纯属噪音，必须识别并丢弃。
 */
function isMeaningfulSummary(text) {
  const s = String(text || '').trim();
  if (s.length < 20) return false;

  // 纯链接 / 空标记
  if (/^(https?:\/\/\S+|\[\s*\]\([^)]*\))+$/.test(s)) return false;

  const compact = s.replace(/\s+/g, '').toLowerCase();

  // 注意 compact 已经去掉所有空白（"the post" → "thepost"），正则不能依赖空格
  const junkPatterns = [
    /^点击查看原文[>》]?$/,
    /^阅读全文[>》]?$/,
    /^查看全文[>》]?$/,
    /^阅读原文[>》]?$/,
    /(点击|read|view)(查看|阅读)?(全文|原文|更多|more)/,
    /^(read|view)(more|full|original)/,
    /^(继续阅读|详见|原文链接|permalink)/,
    /^thepost.+appearedfirston/,
    /^(submitted|posted)by/,
    /^原文地址/
  ];
  if (junkPatterns.some((re) => re.test(compact))) return false;

  // 去掉链接与标点后如果几乎没剩下内容，说明只是导航
  const stripped = compact.replace(/https?:\/\/\S+/g, '').replace(/[。，、！？；：.,!?;:·\-—|/\\[\]()（）【】<>《》"'“”‘’]/g, '');
  if (stripped.length < 15) return false;

  return true;
}

/**
 * 归一化条目：清洗正文、提取摘要与图片、生成稳定 id。
 * 返回 null 表示该条目不合法应被丢弃。
 */
function normalizeItem(item, source) {
  const title = cleanText(item.title).replace(/\s+/g, ' ').trim();
  let link = String(item.link || '').trim();
  if (!title || !link) return null;

  // 修正协议相对地址
  if (/^\/\//.test(link)) link = `https:${link}`;
  // 裸站内路径用源主页补全
  if (/^\//.test(link) && source && source.homepage) {
    try {
      link = new URL(link, source.homepage).href;
    } catch {
      /* 忽略 */
    }
  }
  if (!/^https?:\/\//i.test(link)) return null;

  const rawBody = item.rawBody || item.summary || item.description || '';
  let body = htmlToText(rawBody);
  let summary = cleanText(item.summary || '').replace(/\s+/g, ' ').trim();

  // 无独立 summary 时从正文首段截取
  if (!summary && body) {
    const firstPara = body.split('\n').map((s) => s.trim()).find((s) => s.length > 20) || body;
    summary = firstPara.length > 260 ? `${firstPara.slice(0, 260)}…` : firstPara;
  }
  summary = summary.replace(/\s+/g, ' ').trim();
  // 正文与摘要完全重复时不再重复存储
  if (body && summary && body.replace(/\s+/g, '') === summary.replace(/…$/, '').replace(/\s+/g, '')) {
    body = '';
  }

  // 丢弃无信息量的占位摘要（否则界面会出现「点击查看原文」这种噪音）
  if (summary && !isMeaningfulSummary(summary)) {
    summary = '';
    body = '';
  }
  // 摘要为空时不退回标题，交由界面显示「暂无摘要」提示

  const image = item.image || extractImage(rawBody, link) || '';
  const publishedAt = item.publishedAt || null;

  const author = cleanText(item.author || '')
    // 某些 Atom 源的 author 会被正则整段捕获（<name>李四</name>），去掉残留标签
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    id: makeId(link, title),
    title,
    link,
    summary,
    body,
    image,
    author,
    sourceId: item.sourceId,
    sourceName: item.sourceName || (source && source.name) || item.sourceId,
    category: item.category || (source && source.category) || 'other',
    lang: item.lang || (source && source.lang) || 'zh',
    publishedAt,
    fetchedAt: new Date().toISOString(),
    points: Number.isFinite(item.points) ? item.points : null,
    comments: Number.isFinite(item.comments) ? item.comments : null,
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : []
  };
}

/** 稳定 id：对 URL 归一化后做 fnv1a 哈希，保证跨刷新同一文章 id 不变。 */
function makeId(link, title) {
  const canonical = canonicalUrl(link);
  const basis = canonical || `${title}`;
  return `n_${fnv1a(basis)}`;
}

/** URL 归一化：去掉追踪参数、hash，统一小写 host，去尾斜杠。 */
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    const junk = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'spm', 'from', 'share_token', 'ref', 'fbclid', 'gclid', 'yclid',
      'wxshare', 'scene', 'src', 'source'
    ];
    junk.forEach((k) => u.searchParams.delete(k));
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    let out = u.href;
    if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
    return out;
  } catch {
    return '';
  }
}

/** 32 位 FNV-1a 哈希，输出 8 位十六进制。 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

module.exports = {
  parseFeed,
  normalizeItem,
  htmlToText,
  cleanText,
  decodeEntities,
  parseDate,
  extractImage,
  canonicalUrl,
  makeId,
  fnv1a,
  isMeaningfulSummary,
  pickAtomLink,
  pickTag,
  pickAny
};
