#!/usr/bin/env node
/**
 * Generate the public subscription inventory and optionally publish it.
 *
 * The inventory deliberately contains only public feed URLs (Telegram names are
 * paused until a per-source publish switch exists).  It must never contain RSS
 * tokens, Telegram references, chat IDs, message text, or credentials.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const repo = resolve(process.env.PUBLIC_SUBSCRIPTIONS_REPO ?? process.cwd());
const output = resolve(repo, process.env.PUBLIC_SUBSCRIPTIONS_FILE ?? 'SUBSCRIPTIONS.md');
const briefingDbPath = process.env.DATABASE_PATH ?? '/var/lib/briefing/brief.db';
const publish = process.argv.includes('--publish');
const githubRepo = process.env.PUBLIC_SUBSCRIPTIONS_GITHUB_REPO ?? '';
const githubPath = process.env.PUBLIC_SUBSCRIPTIONS_GITHUB_PATH ?? 'SUBSCRIPTIONS.md';

function db(path) {
  if (!existsSync(path)) throw new Error(`数据库不存在：${path}`);
  return new Database(path, { readonly: true, fileMustExist: true });
}

function text(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cell(value) { return text(value).replaceAll('|', '\\|') || '—'; }

/** 查询参数名像认证信息：整条地址不公开（不是去掉参数后公开——路径里可能同时带令牌）。 */
const SENSITIVE_PARAM = /^(?:access_?token|api_?key|auth|authorization|key|password|secret|signature|sig|token)$/i;
/** 路径片段像令牌：32 位以上十六进制，或 24 位以上同时含字母与数字的随机串（如 /rss/briefs/<令牌>）。宁可少发布。 */
const tokenLikeSegment = (seg) => /^[a-f0-9]{32,}$/i.test(seg) || (/^[A-Za-z0-9_-]{24,}$/.test(seg) && /[A-Za-z]/.test(seg) && /\d/.test(seg));

function publicUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return null;
    if ([...url.searchParams.keys()].some((key) => SENSITIVE_PARAM.test(key))) return null;
    if (url.pathname.split('/').some((seg) => tokenLikeSegment(decodeURIComponent(seg)))) return null;
    // 只公开「协议://主机/路径」：其余查询参数与片段去掉（第二期再加逐个来源的「是否公开」开关）
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return null; }
}

function sourceRows() {
  const d = db(briefingDbPath);
  try {
    const sources = d.prepare(`SELECT id,name,display_name,category,source_group,enabled,site_url
      FROM sources WHERE enabled=1 AND archived_at IS NULL ORDER BY priority,id`).all();
    const endpoints = d.prepare(`SELECT source_id,priority,url FROM source_endpoints
      WHERE enabled=1 ORDER BY source_id,priority`).all();
    const byId = new Map();
    for (const endpoint of endpoints) {
      const url = publicUrl(endpoint.url);
      if (!url) continue;
      const list = byId.get(endpoint.source_id) ?? [];
      list.push({ priority: endpoint.priority, url });
      byId.set(endpoint.source_id, list);
    }
    return sources.map((source) => ({
      id: source.id,
      name: source.display_name || source.name,
      category: source.category,
      group: source.source_group,
      site: publicUrl(source.site_url),
      endpoints: byId.get(source.id) ?? [],
    })).filter((source) => source.endpoints.length > 0 || source.site);
  } finally { d.close(); }
}

function render() {
  const sources = sourceRows();
  const lines = [
    '# 日报订阅清单',
    '',
    '> 此文件由生产环境自动生成。仅列出日报 Feed 链接。',
    '> 不包含 RSS token、Telegram 私有链接、chat_id、消息内容或 API 凭据。',
    '> Feed 地址已去掉查询参数，仅作展示，部分地址可能不能直接订阅。',
    '',
    '## 日报订阅源',
    '',
    '| 来源 | 分类 | 分组 | 站点 | Feed / Atom |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const source of sources) {
    const site = source.site ? `<${source.site}>` : '—';
    const feeds = source.endpoints.map((endpoint) => `<${endpoint.url}>`).join('<br>') || '—';
    lines.push(`| ${cell(source.name)} | ${cell(source.category)} | ${cell(source.group)} | ${site} | ${feeds} |`);
  }
  // Telegram 部分暂停发布（用户 2026-11-10 决定）：库里缓存的用户名不能证明群当前仍公开，
  // 群改私密后名字会继续被发布；第二期逐个来源的「是否公开」开关上线后再恢复。不读取 Telegram 库。
  lines.push('', `共 ${sources.length} 个启用的日报来源。`, '');
  return lines.join('\n');
}

const content = render();
if (!publish) {
  const previous = existsSync(output) ? readFileSync(output, 'utf8') : null;
  if (previous === content) console.log('订阅清单无变化');
  else {
    writeFileSync(output, content, { encoding: 'utf8', mode: 0o644 });
    console.log(`已更新 ${output}`);
  }
  process.exit(0);
}

const gh = (args) => execFileSync('/usr/bin/gh', args,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let remote = null;
try {
  remote = JSON.parse(gh(['api', '--method', 'GET', `repos/${githubRepo}/contents/${githubPath}`, '-f', 'ref=main']));
} catch (error) {
  const message = String(error?.stderr ?? error);
  if (!/404|Not Found/i.test(message)) throw error;
}
const existing = remote?.content
  ? Buffer.from(String(remote.content).replace(/\s/g, ''), 'base64').toString('utf8')
  : null;
if (existing === content) {
  console.log('GitHub 订阅清单无变化');
  process.exit(0);
}
const args = ['api', '--method', 'PUT', `repos/${githubRepo}/contents/${githubPath}`,
  '-f', 'message=chore: sync public subscription inventory',
  '-f', `content=${Buffer.from(content).toString('base64')}`,
  '-f', 'branch=main'];
if (remote?.sha) args.push('-f', `sha=${remote.sha}`);
gh(args);
console.log('GitHub 订阅清单已更新');
