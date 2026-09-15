'use strict';

/**
 * 探测 DeepSeek 相关专属数据源是否可用（本机网络环境实测）。
 *
 * 用法：node test/probe-deepseek-sources.mjs
 */

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
  Accept: 'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml, */*'
};
const H_MIN = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/rss+xml, application/xml, text/xml, */*' };
const PROXY = 'https://gh-proxy.com/';

const CANDIDATES = [
  // ---- 官方 ----
  { name: 'DeepSeek GitHub Releases', url: 'https://gh-proxy.com/https://github.com/deepseek-ai/DeepSeek-R1/releases.atom', kind: 'atom' },
  { name: 'DeepSeek-V3 Releases', url: 'https://gh-proxy.com/https://github.com/deepseek-ai/DeepSeek-V3/releases.atom', kind: 'atom' },
  { name: 'DeepSeek API News', url: 'https://api-docs.deepseek.com/news/', kind: 'html' },
  { name: 'DeepSeek 官网', url: 'https://www.deepseek.com/', kind: 'html' },
  { name: 'DeepSeek 更新日志', url: 'https://api-docs.deepseek.com/updates', kind: 'html' },

  // ---- HF 镜像上的模型 ----
  { name: 'hf-mirror deepseek 模型', url: 'https://hf-mirror.com/api/models?author=deepseek-ai&sort=lastModified&limit=20', kind: 'json' },
  { name: 'hf-mirror 搜 deepseek', url: 'https://hf-mirror.com/api/models?search=deepseek&sort=lastModified&limit=20', kind: 'json' },

  // ---- 中文媒体 ----
  { name: '量子位 DeepSeek 标签', url: 'https://www.qbitai.com/tag/deepseek/feed', kind: 'rss', headers: H_MIN },
  { name: '机器之心', url: 'https://www.jiqizhixin.com/rss', kind: 'rss' },
  { name: '36氪', url: 'https://36kr.com/feed', kind: 'rss' },
  { name: '钛媒体', url: 'https://www.tmtpost.com/rss.xml', kind: 'rss' },
  { name: '虎嗅', url: 'https://www.huxiu.com/rss/0.xml', kind: 'rss' },
  { name: '品玩', url: 'https://www.pingwest.com/feed', kind: 'rss' },
  { name: 'InfoQ AI 频道', url: 'https://www.infoq.cn/feed', kind: 'rss' },

  // ---- 海外 ----
  { name: 'DeepSeek 官方博客?', url: 'https://deepseek.com/blog/rss.xml', kind: 'rss' },
  { name: 'The Decoder', url: 'https://the-decoder.com/feed/', kind: 'rss' },
  { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/', kind: 'rss' },
  { name: 'AI News (smol.ai)', url: 'https://news.smol.ai/rss.xml', kind: 'rss' },
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', kind: 'atom' },
  { name: 'Import AI', url: 'https://importai.substack.com/feed', kind: 'rss' },

  // ---- 聚合器 ----
  { name: 'Bing News 搜 DeepSeek', url: 'https://www.bing.com/news/search?q=DeepSeek&format=RSS', kind: 'rss' },
  { name: '百度新闻 搜 DeepSeek', url: 'https://news.baidu.com/ns?word=DeepSeek&tn=newsrss&sr=0&cl=2&rn=20&ct=0', kind: 'rss' },
  { name: 'Google News 搜 DeepSeek', url: 'https://news.google.com/rss/search?q=DeepSeek&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', kind: 'rss' },
  { name: 'HN 搜 DeepSeek', url: 'https://hn.algolia.com/api/v1/search_by_date?query=DeepSeek&tags=story&hitsPerPage=20', kind: 'json' },
  { name: 'GitHub 搜 deepseek 仓库', url: 'https://gh-proxy.com/https://api.github.com/search/repositories?q=deepseek&sort=updated&order=desc&per_page=20', kind: 'json' },

  // ---- 聚合 RSS 服务 ----
  { name: 'RSSHub 量子位', url: 'https://rsshub.app/qbitai/category/资讯', kind: 'rss' },
  { name: 'RSSHub GitHub DeepSeek', url: 'https://rsshub.app/github/repos/deepseek-ai', kind: 'rss' }
];

async function probe(c) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(c.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: c.headers || H
    });
    clearTimeout(timer);
    const text = await res.text();
    const ms = Date.now() - t0;

    if (!res.ok) {
      console.log(`HTTP ${res.status}  ${String(ms).padStart(6)}ms  ${c.name}  (len=${text.length})`);
      return { name: c.name, ok: false, status: res.status };
    }

    const isXml = /<\?xml|<rss|<feed/i.test(text.slice(0, 500));
    const items = (text.match(/<item[\s>]/gi) || []).length + (text.match(/<entry[\s>]/gi) || []).length;

    let dsCount = 0;
    let detail = '';
    if (c.kind === 'json') {
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : j.items || j.hits || [];
        dsCount = arr.length;
        detail = `JSON ${arr.length} 条`;
        if (arr[0]) {
          const first = arr[0];
          detail += ` 例: ${first.full_name || first.id || first.title || first.name || ''}`;
        }
      } catch {
        detail = 'JSON 解析失败';
      }
    } else if (isXml && items) {
      dsCount = items;
      detail = `XML ${items} 条`;
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text.slice(text.indexOf('<item') >= 0 ? text.indexOf('<item') : 0));
      if (m) detail += ` 例: ${m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim().slice(0, 40)}`;
    } else {
      detail = `HTML 页面 len=${text.length}`;
    }

    console.log(`OK   ${String(ms).padStart(6)}ms  ${c.name.padEnd(28)} ${detail}`);
    return { name: c.name, ok: true, count: dsCount, kind: c.kind, url: c.url };
  } catch (e) {
    console.log(`FAIL ${String(Date.now() - t0).padStart(6)}ms  ${c.name.padEnd(28)} ${e.message}`);
    return { name: c.name, ok: false, error: e.message };
  }
}

console.log('探测 DeepSeek 相关候选源…\n');
const results = [];
for (const c of CANDIDATES) {
  results.push(await probe(c));
}

console.log('\n=== 可用且含条目 ===');
for (const r of results.filter((r) => r.ok && r.count > 0)) {
  console.log(`  ✔ ${r.name}  (${r.kind}, ${r.count} 条)`);
}
console.log('\n=== 可达但疑似无条目/非订阅源 ===');
for (const r of results.filter((r) => r.ok && !r.count)) console.log(`  ~ ${r.name}`);
console.log('\n=== 不可用 ===');
for (const r of results.filter((r) => !r.ok)) console.log(`  ✘ ${r.name}  ${r.error || 'HTTP ' + r.status}`);
