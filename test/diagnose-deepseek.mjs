'use strict';

/**
 * DeepSeek 内容覆盖度诊断。
 *
 * 目的：搞清楚「DeepSeek 新闻少」到底是
 *   (a) 数据源本身就不怎么报道，还是
 *   (b) 被我们的某一步处理（AI 过滤 / 时效 / 截断）丢掉了。
 *
 * 用法：node test/diagnose-deepseek.mjs
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { SOURCES, matchesAiKeywords } = require(path.join(root, 'src/main/sources.js'));
const { fetchAll } = require(path.join(root, 'src/main/aggregator.js'));

const DS_PATTERNS = [
  'deepseek',
  '深度求索',
  'deepseek-r1',
  'deepseek-v3',
  'deepseek v3',
  'deepseek r1',
  '深度搜索',
  '幻方'
];

function mentionsDeepSeek(text) {
  const h = String(text || '').toLowerCase();
  return DS_PATTERNS.some((p) => h.includes(p));
}

console.log('正在抓取全部数据源（原始数据，未做时效过滤）…\n');

const result = await fetchAll(SOURCES, { onProgress: () => {} });

console.log('数据源'.padEnd(24) + '原始'.padStart(6) + 'AI过滤'.padStart(8) + 'DeepSeek'.padStart(10) + '  说明');
console.log('-'.repeat(78));

let totalDs = 0;
const perSource = [];

for (const st of result.statuses) {
  const src = SOURCES.find((s) => s.id === st.id);
  const note = src && src.filterKeywords ? '按 AI 关键词过滤' : '';
  // statuses 里没有条目内容，改从合并结果里按来源统计
  const merged = result.items.filter((i) => i.sourceId === st.id);
  const ds = merged.filter((i) => mentionsDeepSeek(`${i.title} ${i.summary || ''}`));
  totalDs += ds.length;
  perSource.push({ name: st.name, raw: st.rawCount, count: st.count, ds: ds.length, error: st.error });
  console.log(
    String(st.name).padEnd(24) +
      String(st.rawCount ?? '-').padStart(6) +
      String(st.count).padStart(8) +
      String(ds.length).padStart(10) +
      '  ' + (st.error || note)
  );
}

console.log('-'.repeat(78));
console.log(`合计 DeepSeek 相关条目（已过时效窗口）: ${totalDs}`);

/* ---------------- 时效窗口的影响 ---------------- */

const now = Date.now();
const withDates = result.items.filter((i) => mentionsDeepSeek(`${i.title} ${i.summary || ''}`));
console.log(`\n这些条目的发布时间分布：`);
const buckets = { '7天内': 0, '8-21天': 0, '更早': 0, '无时间': 0 };
for (const i of withDates) {
  if (!i.publishedAt) { buckets['无时间'] += 1; continue; }
  const days = (now - Date.parse(i.publishedAt)) / 86400000;
  if (days <= 7) buckets['7天内'] += 1;
  else if (days <= 21) buckets['8-21天'] += 1;
  else buckets['更早'] += 1;
}
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(8)} ${v}`);

console.log('\n最近 10 条 DeepSeek 相关条目：');
for (const i of withDates.slice(0, 10)) {
  console.log(`  [${i.sourceName}] ${(i.publishedAt || '无时间').slice(0, 10)}  ${i.title.slice(0, 52)}`);
}

/* ---------------- 被 AI 关键词过滤掉的 ---------------- */

console.log('\n提示：带「按 AI 关键词过滤」的源，其原始条目会先经 AI 关键词筛选。');
console.log('若某源 DeepSeek 条目为 0，需要区分「源里本来就没有」和「被过滤掉了」。');
console.log('下面直接检查这些源的原始条目里有没有 DeepSeek：\n');

const { fetchText } = require(path.join(root, 'src/main/aggregator.js'));
const { parseFeed } = require(path.join(root, 'src/main/parser.js'));

for (const src of SOURCES.filter((s) => s.filterKeywords && s.kind === 'rss')) {
  try {
    const xml = await fetchText(src.url, { timeout: src.timeout || 25000, headers: src.headers || {} });
    const items = parseFeed(xml, src);
    const ds = items.filter((i) => mentionsDeepSeek(`${i.title} ${i.summary || ''}`));
    const aiPass = items.filter((i) => matchesAiKeywords(`${i.title} ${i.summary || ''}`));
    console.log(
      `${src.name.padEnd(16)} 原始=${String(items.length).padStart(3)}  ` +
        `AI通过=${String(aiPass.length).padStart(3)}  ` +
        `其中DeepSeek=${String(ds.length).padStart(2)}  ` +
        `DeepSeek但被AI过滤误杀=${ds.filter((d) => !matchesAiKeywords(`${d.title} ${d.summary || ''}`)).length}`
    );
    for (const d of ds.slice(0, 3)) {
      console.log(`      · ${d.title.slice(0, 62)}`);
    }
  } catch (err) {
    console.log(`${src.name.padEnd(16)} 抓取失败：${err.message}`);
  }
}
