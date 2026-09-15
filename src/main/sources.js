'use strict';

/**
 * 数据源目录。
 *
 * 所有地址均在本机实测可直连（中国大陆网络环境、无代理）：
 *  - 国内源直连；
 *  - HuggingFace 走 hf-mirror.com 镜像（主站 huggingface.co 不可达）；
 *  - GitHub API 走 gh-proxy.com 代理（api.github.com 不可达）；
 *  - arXiv 官方 API（export.arxiv.org / arxiv.org）在本机完全超时，故不使用。
 *
 * 字段说明：
 *  kind     抓取器类型：rss | json
 *  category 分类键，用于界面筛选
 *  lang     原文语言，用于界面语言标记
 *  enabled  默认是否启用（用户可在设置里改）
 */

const CATEGORIES = [
  { id: 'papers', name: '论文', icon: '📄', desc: '每日前沿论文与研究成果' },
  { id: 'cn', name: '国内资讯', icon: '🇨🇳', desc: '中文科技媒体 AI 报道' },
  { id: 'global', name: '海外资讯', icon: '🌍', desc: '海外官方博客与科技媒体' },
  { id: 'community', name: '社区热议', icon: '💬', desc: '开发者社区讨论与热点' },
  { id: 'opensource', name: '开源项目', icon: '⭐', desc: 'GitHub 上活跃的 AI 项目' }
];

/**
 * 请求头预设（与 aggregator.js 中的 PRESET 同名字段对应）。
 * 实测背景：量子位与 MarkTechPost 会拒绝「完整浏览器 UA」，只放行最简 UA，
 * 因此按源声明其实际接受的请求头，而不是统一伪装成浏览器。
 */
const HEADERS = {
  /** 最简 UA */
  minimal: { 'User-Agent': 'Mozilla/5.0' },
  /** 工具型 UA */
  tool: { 'User-Agent': 'curl/8.4.0' }
};

const SOURCES = [
  /* ---------------- 论文 ---------------- */
  {
    id: 'hf-papers',
    name: 'HuggingFace 每日论文',
    category: 'papers',
    lang: 'en',
    kind: 'hf-papers',
    homepage: 'https://hf-mirror.com/papers',
    url: 'https://hf-mirror.com/api/daily_papers?limit=50',
    enabled: true,
    weight: 100
  },

  /* ---------------- 国内资讯 ---------------- */
  {
    id: 'qbitai',
    name: '量子位',
    category: 'cn',
    lang: 'zh',
    kind: 'rss',
    homepage: 'https://www.qbitai.com',
    url: 'https://www.qbitai.com/feed',
    enabled: true,
    weight: 80,
    headers: HEADERS.minimal
  },
  {
    id: 'ithome',
    name: 'IT之家',
    category: 'cn',
    lang: 'zh',
    kind: 'rss',
    homepage: 'https://www.ithome.com',
    url: 'https://www.ithome.com/rss/',
    enabled: true,
    weight: 50,
    // IT之家是全站科技源，需要按关键词过滤出 AI 相关
    filterKeywords: true
  },
  {
    id: 'infoq-cn',
    name: 'InfoQ 中文',
    category: 'cn',
    lang: 'zh',
    kind: 'rss',
    homepage: 'https://www.infoq.cn',
    url: 'https://www.infoq.cn/feed',
    enabled: true,
    weight: 60
  },
  {
    id: 'leiphone',
    name: '雷锋网',
    category: 'cn',
    lang: 'zh',
    kind: 'rss',
    homepage: 'https://www.leiphone.com',
    url: 'https://www.leiphone.com/feed',
    enabled: true,
    weight: 60,
    filterKeywords: true
  },
  {
    id: 'oschina',
    name: '开源中国',
    category: 'cn',
    lang: 'zh',
    kind: 'rss',
    homepage: 'https://www.oschina.net',
    url: 'https://www.oschina.net/news/rss',
    enabled: true,
    weight: 40,
    filterKeywords: true
  },
  {
    id: 'solidot',
    name: 'Solidot 奇客',
    category: 'cn',
    lang: 'zh',
    kind: 'rss',
    homepage: 'https://www.solidot.org',
    url: 'https://www.solidot.org/index.rss',
    enabled: true,
    weight: 40,
    filterKeywords: true
  },

  /* ---------------- 海外资讯 ---------------- */
  {
    id: 'openai-blog',
    name: 'OpenAI Blog',
    category: 'global',
    lang: 'en',
    kind: 'rss',
    homepage: 'https://openai.com',
    url: 'https://openai.com/blog/rss.xml',
    enabled: true,
    weight: 95
  },
  {
    id: 'google-ai-blog',
    name: 'Google AI Blog',
    category: 'global',
    lang: 'en',
    kind: 'rss',
    homepage: 'https://blog.google',
    url: 'https://blog.google/technology/ai/rss/',
    /**
     * 实测：该源在本机网络下响应时间剧烈波动（快时 500ms，慢时直接卡到超时），
     * 连续 4 次实测有 3 次失败。为不让首次刷新被它拖慢，默认关闭；
     * 用户可在侧栏「数据源」里勾选启用，也可在设置里看到它的实时状态。
     */
    enabled: false,
    weight: 90,
    timeout: 12000,
    retries: 2
  },
  {
    id: 'techcrunch-ai',
    name: 'TechCrunch AI',
    category: 'global',
    lang: 'en',
    kind: 'rss',
    homepage: 'https://techcrunch.com',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    enabled: true,
    weight: 75
  },
  {
    id: 'marktechpost',
    name: 'MarkTechPost',
    category: 'global',
    lang: 'en',
    kind: 'rss',
    homepage: 'https://www.marktechpost.com',
    url: 'https://www.marktechpost.com/feed/',
    enabled: true,
    weight: 65,
    headers: HEADERS.tool
  },
  {
    id: 'hf-blog',
    name: 'HuggingFace Blog',
    category: 'global',
    lang: 'en',
    kind: 'rss',
    homepage: 'https://hf-mirror.com/blog',
    url: 'https://hf-mirror.com/blog/feed.xml',
    enabled: true,
    weight: 85
  },

  /* ---------------- 社区热议 ---------------- */
  {
    id: 'hn-front',
    name: 'Hacker News',
    category: 'community',
    lang: 'en',
    kind: 'rss',
    homepage: 'https://news.ycombinator.com',
    url: 'https://hnrss.org/frontpage?points=80',
    enabled: true,
    weight: 70,
    filterKeywords: true
  },

  /* ---------------- 开源项目 ---------------- */
  {
    id: 'gh-trending',
    name: 'GitHub 热门仓库',
    category: 'opensource',
    lang: 'en',
    kind: 'github',
    homepage: 'https://github.com',
    url: 'https://gh-proxy.com/https://api.github.com/search/repositories',
    enabled: true,
    weight: 55,
    /**
     * GitHub 搜索 API 会拒绝「只含逻辑运算符、无检索词」的查询（422），
     * 因此这里用多条单条件查询再合并，而不是写成 topic:a OR topic:b。
     * 全部按最近推送时间排序，保证拿到的是「最近仍在活跃」的项目。
     */
    queries: [
      'topic:llm',
      'topic:ai-agents',
      'topic:generative-ai',
      'large language model in:name,description',
      'AI agent in:name,description'
    ],
    minStars: 300,
    perQuery: 25,
    sort: 'updated',
    // 5 条查询串行执行，整体留足时间（默认 20s 会不够）
    timeout: 90000,
    queryTimeout: 15000
  }
];

/** 判断一条内容是否与 AI 相关（用于全站型科技源的过滤）。 */
const AI_KEYWORDS = [
  // 中文
  '人工智能', '大模型', '大语言模型', '语言模型', '生成式', '机器学习', '深度学习',
  '神经网络', '智能体', '多模态', '具身智能', '机器人', '算力', '推理', '训练',
  '英伟达', 'OpenAI', 'ChatGPT', 'GPT', 'Claude', 'Gemini', 'DeepSeek', '通义',
  '文心', '豆包', 'Kimi', '智谱', 'Qwen', '千问', 'Llama', 'Mistral', 'Grok',
  'AGI', 'AIGC', 'Transformer', 'RAG', '微调', '对齐', '提示词', 'token',
  '自动驾驶', '智驾', '芯片', 'GPU', 'TPU', 'AI',
  // 英文
  'artificial intelligence', 'machine learning', 'deep learning', 'neural',
  'large language model', 'llm', 'generative', 'agent', 'diffusion',
  'transformer', 'inference', 'fine-tun', 'embodied', 'robotics', 'anthropic',
  'multimodal', 'reinforcement learning', 'copilot', 'chatbot'
];

/**
 * 关键词匹配：英文按词边界匹配，中文按子串匹配，避免 "AI" 命中 "said" 之类误报。
 */
function matchesAiKeywords(text) {
  if (!text) return false;
  const haystack = String(text);
  const lower = haystack.toLowerCase();
  for (const kw of AI_KEYWORDS) {
    if (/^[\x00-\x7f]+$/.test(kw)) {
      // 纯 ASCII 关键词：要求词边界
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(lower)) return true;
    } else if (haystack.includes(kw)) {
      return true;
    }
  }
  return false;
}

function getSourceById(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

module.exports = { SOURCES, CATEGORIES, AI_KEYWORDS, matchesAiKeywords, getSourceById };
