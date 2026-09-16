'use strict';

/**
 * 设置 GitHub 仓库的简介（description）与主题标签（topics）。
 *
 * 为什么需要这个脚本：这两项只能通过 GitHub API 修改，而本机的 Node TLS
 * 无法直连 api.github.com（会被重置），因此改用已安装的 gh CLI ——
 * 它走 Windows 原生网络栈，且在认证后直连 GitHub 官方 API，不经过任何代理。
 *
 * 用法（token 从环境变量读取，不落盘、不写进命令行历史）：
 *   $env:GH_TOKEN = "github_pat_xxx"
 *   node scripts/set-repo-meta.mjs
 *
 * 需要的权限（细粒度 token）：Administration → Read and write
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const OWNER = 'erha2777';
const REPO = 'ai-radar';

/**
 * 简介与主题标签。
 *
 * 注意：简介里的数据源数量必须与 src/main/sources.js 一致。
 * 曾出现过简介写「13 个」而实际已增至 16 个的情况（新增 DeepSeek 专区后忘了同步），
 * 所以下面加了硬校验，不一致会直接报错。
 */
const DESCRIPTION =
  '实时聚合 16 个 AI 数据源的 Windows 桌面应用（论文 / 国内资讯 / 海外资讯 / 社区热议 / 开源项目 / DeepSeek 专区），支持系统通知、关键词关注、搜索与收藏';

const TOPICS = [
  'electron',
  'ai',
  'artificial-intelligence',
  'rss',
  'news-aggregator',
  'desktop-app',
  'windows',
  'llm',
  'huggingface',
  'deepseek',
  'javascript'
];

/** 定位 gh.exe：优先 PATH，其次默认安装目录。 */
function findGh() {
  const candidates = [
    'gh',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe')
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c === 'gh') return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return 'gh';
}

const gh = findGh();

/** 执行 gh 命令，参数以数组传入避免 shell 转义问题。 */
function runGh(args, { input } = {}) {
  const res = spawnSync(gh, args, {
    encoding: 'utf8',
    input,
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error ? res.error.message : ''
  };
}

function fail(msg) {
  console.error(`[x] ${msg}`);
  process.exit(1);
}

/* ---------------------------- 前置检查 ---------------------------- */

// 简介里的数据源数量必须与实际启用数一致，否则仓库页会显示过时信息。
// 这类数字很容易在新增数据源后忘记同步，所以做成硬校验。
try {
  // 本文件是 ESM，sources.js 是 CommonJS，需经 createRequire 载入
  const { createRequire } = await import('node:module');
  const requireCjs = createRequire(import.meta.url);
  const { SOURCES } = requireCjs(path.join(root, 'src/main/sources.js'));

  const enabledCount = SOURCES.filter((s) => s.enabled !== false).length;
  const match = /(\d+)\s*个\s*AI\s*数据源/.exec(DESCRIPTION);
  const claimed = match ? Number(match[1]) : null;

  if (claimed === null) {
    fail('简介中未找到「N 个 AI 数据源」的表述，请检查 DESCRIPTION 文案');
  }
  if (claimed !== enabledCount) {
    fail(
      '简介里的数据源数量与实际不一致：\n' +
        `    简介写的：${claimed} 个\n` +
        `    实际启用：${enabledCount} 个（共 ${SOURCES.length} 个，` +
        `${SOURCES.filter((s) => s.enabled === false).length} 个默认关闭）\n` +
        '    请更新本文件的 DESCRIPTION 后再运行。'
    );
  }
  console.log(`[0/5] 数据源数量校验通过：${enabledCount} 个（共 ${SOURCES.length} 个）`);
} catch (err) {
  // 读不到源定义时不阻断（例如把本脚本单独拿去别处用）
  console.log(`[0/5] 跳过数据源数量校验（${String(err.message).split('\n')[0]}）`);
}

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  fail(
    '未检测到凭据。请先设置环境变量后重试：\n' +
      '    $env:GH_TOKEN = "github_pat_xxx"\n' +
      '    node scripts/set-repo-meta.mjs'
  );
}

console.log(`[1/5] gh 可执行文件：${gh}`);
const ver = runGh(['--version']);
if (ver.status !== 0) {
  fail(`无法执行 gh：${ver.error || ver.stderr}\n    请确认已安装 GitHub CLI（winget install GitHub.cli）`);
}
console.log(`      ${ver.stdout.split('\n')[0]}`);

console.log('[2/5] 校验凭据与仓库权限…');
const whoami = runGh(['api', 'user', '--jq', '.login']);
if (whoami.status !== 0) {
  fail(
    `凭据校验失败：${whoami.stderr || whoami.error}\n` +
      '    可能原因：token 无效/过期，或网络不通（gh 需要能直连 api.github.com）'
  );
}
console.log(`      已认证为：${whoami.stdout}`);
if (whoami.stdout !== OWNER) {
  console.warn(`      [警告] 当前账号是 ${whoami.stdout}，与目标仓库所有者 ${OWNER} 不一致`);
}

/* ---------------------------- 写入简介 ---------------------------- */

console.log('[3/5] 更新仓库简介…');
const descRes = runGh([
  'api',
  '--method',
  'PATCH',
  `repos/${OWNER}/${REPO}`,
  '-f',
  `description=${DESCRIPTION}`,
  '--jq',
  '.description'
]);
if (descRes.status !== 0) {
  fail(`更新简介失败：${descRes.stderr || descRes.error}`);
}
console.log(`      已设置：${descRes.stdout}`);

/* ---------------------------- 写入 topics ---------------------------- */

console.log('[4/5] 更新主题标签…');
// topics 接口要求请求体是 {"names":[...]}，用 --input - 从 stdin 传 JSON，
// 避免 -f 把数组序列化成字符串。
const topicsRes = runGh(
  ['api', '--method', 'PUT', `repos/${OWNER}/${REPO}/topics`, '--input', '-', '--jq', '.names'],
  { input: JSON.stringify({ names: TOPICS }) }
);
if (topicsRes.status !== 0) {
  fail(
    `更新 topics 失败：${topicsRes.stderr || topicsRes.error}\n` +
      '    提示：细粒度 token 需要 Administration: Read and write 权限'
  );
}
console.log(`      已设置：${topicsRes.stdout}`);

/* ---------------------------- 校验 ---------------------------- */

console.log('[5/5] 回读校验…');
const check = runGh(['api', `repos/${OWNER}/${REPO}`, '--jq', '.description, (.topics | join(", "))']);
if (check.status !== 0) {
  fail(`回读失败：${check.stderr || check.error}`);
}
console.log('      ' + check.stdout.split('\n').join('\n      '));

console.log(`\n✔ 完成：https://github.com/${OWNER}/${REPO}`);
