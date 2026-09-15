'use strict';

/**
 * 测试脚本。
 *
 *   node test/run-tests.mjs          离线单元测试（解析器 / 去重 / 配置）
 *   node test/run-tests.mjs --live   额外实测所有真实数据源
 *
 * 退出码 0 表示全部通过，1 表示有失败项。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const parser = require(path.join(root, 'src/main/parser.js'));
const { Scheduler } = require(path.join(root, 'src/main/scheduler.js'));
const { SOURCES, matchesAiKeywords } = require(path.join(root, 'src/main/sources.js'));
const { fetchAll, normalizeTitle } = require(path.join(root, 'src/main/aggregator.js'));
const { Store } = require(path.join(root, 'src/main/store.js'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/* ============================ 解析器测试 ============================ */

section('RSS 2.0 解析');

const rssSample = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>测试源</title>
  <link>https://example.com</link>
  <item>
    <title>OpenAI 发布新模型 &amp; 基准测试结果</title>
    <link>https://example.com/posts/1?utm_source=rss&amp;utm_medium=feed</link>
    <dc:creator><![CDATA[张三]]></dc:creator>
    <pubDate>Tue, 15 Sep 2026 02:17:34 +0000</pubDate>
    <category><![CDATA[大模型]]></category>
    <description><![CDATA[<p>第一段<strong>加粗</strong>内容。</p><p>第二段内容，包含实体 &amp;lt;tag&amp;gt; 与图片<img src="https://example.com/a.png"></p>]]></description>
  </item>
  <item>
    <title>第二条</title>
    <link>https://example.com/posts/2</link>
    <pubDate>Mon, 14 Sep 2026 10:00:00 +0800</pubDate>
    <description>纯文本摘要</description>
  </item>
  <item>
    <title></title>
    <link>https://example.com/posts/3</link>
  </item>
</channel>
</rss>`;

const rssItems = parser.parseFeed(rssSample, {
  id: 'test',
  name: '测试源',
  category: 'cn',
  lang: 'zh'
});

check('解析出 2 条（空标题条目被丢弃）', rssItems.length === 2, `实际 ${rssItems.length}`);
check('标题实体已解码', rssItems[0].title === 'OpenAI 发布新模型 & 基准测试结果', rssItems[0].title);
check('链接可作为 id 依据且已归一化', rssItems[0].link.includes('/posts/1'), rssItems[0].link);
check('CDATA 作者已解出', rssItems[0].author === '张三', rssItems[0].author);
check('日期解析正确', rssItems[0].publishedAt === '2026-09-15T02:17:34.000Z', String(rssItems[0].publishedAt));
check('+0800 时区正确换算', rssItems[1].publishedAt === '2026-09-14T02:00:00.000Z', String(rssItems[1].publishedAt));
check('HTML 已转纯文本', !/[<>]/.test(rssItems[0].body.replace(/·/g, '')), rssItems[0].body.slice(0, 80));
check(
  '正文中的字面尖括号不会残留成标签',
  !rssItems[0].body.includes('<tag>'),
  rssItems[0].body.slice(0, 80)
);
check('首图已提取', rssItems[0].image === 'https://example.com/a.png', rssItems[0].image);
check('分类标签已收集', rssItems[0].tags.includes('大模型'), JSON.stringify(rssItems[0].tags));
check('id 稳定且唯一', rssItems[0].id !== rssItems[1].id && rssItems[0].id.startsWith('n_'));
check('同链接二次解析 id 不变', parser.parseFeed(rssSample, { id: 'test', name: 't' })[0].id === rssItems[0].id);

section('Atom 1.0 解析');

const atomSample = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 测试源</title>
  <entry>
    <title>多模态模型新进展</title>
    <link rel="alternate" href="https://example.org/atom/1"/>
    <link rel="self" href="https://example.org/api/1"/>
    <published>2026-09-15T06:30:00Z</published>
    <updated>2026-09-15T07:00:00Z</updated>
    <author><name>李四</name></author>
    <summary type="html">摘要 &lt;b&gt;带标签&lt;/b&gt;</summary>
    <category term="multimodal"/>
  </entry>
</feed>`;

const atomItems = parser.parseFeed(atomSample, { id: 'atom', name: 'Atom源', category: 'global', lang: 'en' });
check('解析出 1 条', atomItems.length === 1, `实际 ${atomItems.length}`);
check('优先取 rel=alternate 链接', atomItems[0] && atomItems[0].link === 'https://example.org/atom/1', atomItems[0] && atomItems[0].link);
check('published 优先于 updated', atomItems[0] && atomItems[0].publishedAt === '2026-09-15T06:30:00.000Z', atomItems[0] && String(atomItems[0].publishedAt));
check('author/name 已解出', atomItems[0] && atomItems[0].author === '李四', atomItems[0] && atomItems[0].author);
check('摘要 HTML 已清洗', atomItems[0] && !atomItems[0].summary.includes('<b>'), atomItems[0] && atomItems[0].summary);

section('异常输入健壮性');

check('空字符串返回空数组', parser.parseFeed('', { id: 'x' }).length === 0);
check('null 返回空数组', parser.parseFeed(null, { id: 'x' }).length === 0);
check('非 XML 文本返回空数组', parser.parseFeed('这不是 XML，只是一段话', { id: 'x' }).length === 0);
check('HTML 页面返回空数组', parser.parseFeed('<!DOCTYPE html><html><body>hi</body></html>', { id: 'x' }).length === 0);
check('缺少 link 的条目被丢弃', parser.parseFeed('<rss><channel><item><title>只有标题</title></item></channel></rss>', { id: 'x' }).length === 0);
check('非法日期返回 null', parser.parseDate('不是日期') === null);
check('异常年份被拒绝', parser.parseDate('Tue, 15 Sep 1899 02:17:34 +0000') === null);
check('无时区日期可解析', parser.parseDate('2026-09-15 10:30:00') !== null);
check('实体解码正确', parser.decodeEntities('&lt;a&gt; &amp; &#65; &#x42; &nbsp;') === '<a> & A B  ');

section('HTML 转纯文本');

check(
  '普通 HTML 标记被剥离',
  parser.htmlToText('<p>hi</p>') === 'hi',
  parser.htmlToText('<p>hi</p>')
);
check(
  '单层转义标记被识别为标记',
  parser.htmlToText('&lt;p&gt;hi&lt;/p&gt;') === 'hi',
  parser.htmlToText('&lt;p&gt;hi&lt;/p&gt;')
);
check(
  '二次转义标记仍能剥离',
  parser.htmlToText('&amp;lt;p&amp;gt;hello world&amp;lt;/p&amp;gt;') === 'hello world',
  parser.htmlToText('&amp;lt;p&amp;gt;hello world&amp;lt;/p&amp;gt;')
);
check(
  '二次转义实体还原为字面字符',
  parser.htmlToText('&amp;amp; 对比 &amp;lt;') === '& 对比 <',
  parser.htmlToText('&amp;amp; 对比 &amp;lt;')
);
check(
  '段落转换为换行',
  parser.htmlToText('<p>一</p><p>二</p>') === '一\n二',
  JSON.stringify(parser.htmlToText('<p>一</p><p>二</p>'))
);
check(
  'script/style 内容被丢弃',
  !parser.htmlToText('<script>evil()</script><p>正常</p>').includes('evil'),
  parser.htmlToText('<script>evil()</script><p>正常</p>')
);
check(
  '协议相对图片地址补全为 https',
  parser.extractImage('<img src="//cdn.example.com/a.png">') === 'https://cdn.example.com/a.png'
);
check('data: 图片被忽略', parser.extractImage('<img src="data:image/png;base64,AAAA">') === '');

section('无信息量摘要识别');

check('「点击查看原文>」被判定为噪音', !parser.isMeaningfulSummary('点击查看原文>'));
check('「阅读全文」被判定为噪音', !parser.isMeaningfulSummary('阅读全文'));
check('「Read more」被判定为噪音', !parser.isMeaningfulSummary('Read more'));
check('「The post ... appeared first on ...」被判定为噪音', !parser.isMeaningfulSummary('The post AI news appeared first on TechCrunch'));
check('纯链接被判定为噪音', !parser.isMeaningfulSummary('https://example.com/a/b/c'));
check('过短文本被判定为噪音', !parser.isMeaningfulSummary('短的'));
check('空字符串被判定为噪音', !parser.isMeaningfulSummary(''));
check(
  '正常中文摘要被保留',
  parser.isMeaningfulSummary('研究团队提出了一种新的稀疏注意力机制，在长上下文任务上把推理成本降低了约四成。')
);
check(
  '正常英文摘要被保留',
  parser.isMeaningfulSummary('Researchers introduced a sparse attention mechanism that cuts inference cost by 40%.')
);

// InfoQ 的 description 只有导航链接，归一化后摘要应为空
const infoqItem = parser.normalizeItem(
  {
    sourceId: 'infoq-cn',
    sourceName: 'InfoQ 中文',
    category: 'cn',
    lang: 'zh',
    title: 'Meta 打造组织第二大脑智能体的设计思路',
    link: 'https://www.infoq.cn/article/abc',
    rawBody: "&lt;div align=&#39;right&#39;&gt;&lt;a href=&#39;https://www.infoq.cn/article/abc&#39;&gt;点击查看原文&gt;&lt;/a&gt;&lt;/div&gt;",
    publishedAt: '2026-09-15T11:21:00.000Z'
  },
  { id: 'infoq-cn', name: 'InfoQ 中文', category: 'cn', lang: 'zh' }
);
check('InfoQ 类占位摘要被清空', infoqItem.summary === '', JSON.stringify(infoqItem.summary));
check('InfoQ 标题仍然保留', infoqItem.title.includes('Meta'), infoqItem.title);

section('收藏不因掉出抓取列表而丢失');

// 回归测试：曾经出现「侧栏显示收藏 1 条，点进去却空」的问题。
// 根因是快照的 items 会按 maxItems 截断、且有时效过滤，而收藏是独立持久化的，
// 一条内容被收藏后仍可能不在 items 里。快照必须把这类收藏补回来。
{
  const favStore = new Store(path.join(root, '.tmp-test-fav')).load();
  const orphan = {
    id: 'fav_orphan_1',
    title: '一条已被收藏但早已掉出抓取列表的内容',
    link: 'https://example.com/old/1',
    summary: '很久以前的文章',
    sourceId: 'qbitai',
    sourceName: '量子位',
    category: 'cn',
    lang: 'zh',
    publishedAt: '2026-01-01T00:00:00.000Z',
    savedAt: '2026-01-02T00:00:00.000Z'
  };
  favStore.toggleFavorite(orphan);

  const sched = new Scheduler(favStore);
  sched.lastResult = {
    items: [
      {
        id: 'normal_1',
        title: '当前列表里的普通条目',
        link: 'https://example.com/new/1',
        summary: '',
        sourceId: 'qbitai',
        sourceName: '量子位',
        category: 'cn',
        lang: 'zh',
        publishedAt: '2026-09-15T00:00:00.000Z'
      }
    ],
    statuses: [],
    fetchedAt: '2026-09-15T00:00:00.000Z',
    durationMs: 0,
    totalRaw: 1,
    fromCache: false
  };

  const snap = sched.snapshot();
  const ids = snap.items.map((i) => i.id);
  check('收藏计数为 1', snap.favorites.length === 1, String(snap.favorites.length));
  check('收藏条目被补进快照 items', ids.includes('fav_orphan_1'), JSON.stringify(ids));
  check(
    '补进来的收藏带有 favorite 标记',
    snap.items.find((i) => i.id === 'fav_orphan_1').favorite === true
  );
  check(
    '补进来的收藏有可用于排序的时间',
    Boolean(snap.items.find((i) => i.id === 'fav_orphan_1').publishedAt)
  );
  check('原有条目未被破坏', ids.includes('normal_1'));

  // 取消收藏后不应再被补进来
  favStore.toggleFavorite(orphan);
  const snap2 = sched.snapshot();
  check(
    '取消收藏后不再出现',
    !snap2.items.map((i) => i.id).includes('fav_orphan_1'),
    JSON.stringify(snap2.items.map((i) => i.id))
  );

  try {
    const fsx = await import('node:fs');
    fsx.rmSync(path.join(root, '.tmp-test-fav'), { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
}

section('URL 归一化与去重');

const u1 = parser.canonicalUrl('https://Example.com/news/1/?utm_source=rss&utm_medium=feed#top');
const u2 = parser.canonicalUrl('https://example.com/news/1');
check('追踪参数 / hash / 尾斜杠已剔除', u1 === u2, `${u1} vs ${u2}`);
check('标题指纹忽略标点空白', normalizeTitle('OpenAI 发布 GPT-5！') === normalizeTitle('openai发布gpt5'), normalizeTitle('OpenAI 发布 GPT-5！'));

section('AI 关键词过滤');

check('中文命中', matchesAiKeywords('国产大模型取得突破'));
check('英文命中（词边界）', matchesAiKeywords('New LLM benchmark released'));
check('AI 不误伤 said', !matchesAiKeywords('He said hello to everyone'));
check('无关内容不命中', !matchesAiKeywords('今天天气不错，适合出门散步'));
check('大小写不敏感', matchesAiKeywords('openai announces'));

section('配置存储');

const tmpDir = path.join(root, '.tmp-test-store');
const store = new Store(tmpDir).load();
check('默认配置加载', store.getConfig().refreshMinutes === 5, String(store.getConfig().refreshMinutes));
const updated = store.updateConfig({ refreshMinutes: 12, keywords: [' 测试 ', '', 'Agent'] });
check('配置写入生效', updated.refreshMinutes === 12, String(updated.refreshMinutes));
check('关键词去空白去空项', JSON.stringify(updated.keywords) === JSON.stringify(['测试', 'Agent']), JSON.stringify(updated.keywords));
check('非法间隔被钳制', store.updateConfig({ refreshMinutes: 99999 }).refreshMinutes === 240);
store.markRead(['a', 'b'], true);
check('已读状态持久化', store.getReadSet().has('a') && store.getReadSet().has('b'));
store.markRead(['a'], false);
check('取消已读生效', !store.getReadSet().has('a'));
const favRes = store.toggleFavorite({ id: 'f1', title: 'T', link: 'https://e.com/1', summary: 's' });
check('收藏写入成功', favRes.favorite && store.isFavorite('f1'));
store.toggleFavorite({ id: 'f1', title: 'T', link: 'https://e.com/1' });
check('再次切换取消收藏', !store.isFavorite('f1'));
store.writeCache({ fetchedAt: new Date().toISOString(), items: [{ id: 'c1' }], statuses: [] });
check('缓存可回读', new Store(tmpDir).load().readCache().items[0].id === 'c1');

try {
  const fs = await import('node:fs');
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* 忽略清理失败 */
}

/* ============================ 真实网络测试 ============================ */

if (process.argv.includes('--live')) {
  section('真实数据源抓取');

  console.log(`共 ${SOURCES.length} 个源，开始抓取…\n`);
  const result = await fetchAll(SOURCES, {
    onProgress: ({ finished, total, source, status }) => {
      const mark = status.ok ? '✔' : '✘';
      console.log(
        `  ${mark} [${finished}/${total}] ${source.name.padEnd(20)} ${String(status.count).padStart(5)} 条 ${String(
          status.ms
        ).padStart(6)}ms ${status.error || ''}`
      );
    }
  });

  console.log('');
  const okCount = result.statuses.filter((s) => s.ok).length;
  check(`至少 10 个源抓取成功（实际 ${okCount}/${result.statuses.length}）`, okCount >= 10);
  check(`抓到内容条目（实际 ${result.items.length} 条）`, result.items.length > 30);
  check('条目均带 id 与标题', result.items.every((i) => i.id && i.title));
  check('条目均带合法链接', result.items.every((i) => /^https?:\/\//.test(i.link)));
  check('条目按时间倒序', (() => {
    for (let i = 1; i < result.items.length; i += 1) {
      const a = Date.parse(result.items[i - 1].publishedAt || 0) || 0;
      const b = Date.parse(result.items[i].publishedAt || 0) || 0;
      if (a < b) return false;
    }
    return true;
  })());
  const idSet = new Set(result.items.map((i) => i.id));
  check('id 无重复', idSet.size === result.items.length, `${idSet.size} vs ${result.items.length}`);
  const titleSet = new Set(result.items.map((i) => normalizeTitle(i.title)));
  check('标题指纹无重复', titleSet.size === result.items.length, `${titleSet.size} vs ${result.items.length}`);

  const byCategory = {};
  for (const item of result.items) byCategory[item.category] = (byCategory[item.category] || 0) + 1;
  console.log('\n  分类分布：', JSON.stringify(byCategory, null, 0));

  const failedSources = result.statuses.filter((s) => !s.ok);
  if (failedSources.length) {
    console.log('\n  失败源明细：');
    for (const s of failedSources) console.log(`    - ${s.name}: ${s.error}`);
  }
}

/* ============================ 汇总 ============================ */

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`${'='.repeat(50)}\n`);

process.exit(failed === 0 ? 0 : 1);
