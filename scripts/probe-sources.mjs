#!/usr/bin/env node
// 按 sources.yaml 的 host_groups 限流规则实测所有端点。
// 既验证来源可用性，也验证令牌桶逻辑本身（实施方案 2.3）。
//   node scripts/probe-sources.mjs            仅 priority 1
//   node scripts/probe-sources.mjs --all      所有端点（含回退层）
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { fetchOnce, fetchViaCurl } from '../packages/connectors/src/fetch.ts';

const cfg = parse(readFileSync('config/sources.yaml', 'utf8'));
const ALL = process.argv.includes('--all');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 主机分组令牌桶：同组串行/限并发 + 最小间隔
class HostGroup {
  constructor(name, c) { this.name = name; this.cfg = c; this.active = 0; this.last = 0; this.q = []; }
  async run(fn) {
    await new Promise(res => { this.q.push(res); this.#pump(); });
    const gap = this.cfg.min_interval_ms - (Date.now() - this.last);
    if (gap > 0) await sleep(gap);
    this.last = Date.now();
    try { return await fn(); } finally { this.active--; this.#pump(); }
  }
  #pump() {
    while (this.q.length && this.active < this.cfg.concurrency) { this.active++; this.q.shift()(); }
  }
}
const groups = Object.fromEntries(
  Object.entries(cfg.host_groups).map(([k, v]) => [k, new HostGroup(k, v)]));
const hostToGroup = {};
for (const [k, v] of Object.entries(cfg.host_groups)) for (const h of v.hosts) hostToGroup[h] = k;

/** 与生产同一套通道：linux.do 走 curl，其余走 safeHttp（逐跳校验、固定连接地址）。输出注明通道。 */
async function probe(url, groupName) {
  const g = groups[groupName] ?? groups.direct;
  return g.run(async () => {
    const t0 = Date.now();
    const curl = new URL(url).hostname === 'linux.do';
    const r = await (curl ? fetchViaCurl : fetchOnce)(url, {
      timeoutMs: g.cfg.timeout_ms, userAgent: cfg.defaults.user_agent,
      maxBytes: cfg.defaults.max_body_bytes, maxRedirects: Number(cfg.defaults.follow_redirects ?? 3),
      accept: 'application/rss+xml, application/xml, text/html, */*' });
    const via = curl ? 'curl' : 'https';
    if (r.outcome !== 'ok' || !r.body)
      return { ok: false, status: r.httpCode ?? r.errorClass ?? r.outcome, err: r.errorMessage, ms: Date.now() - t0, via };
    const body = r.body;
    const items = (body.match(/<item[\s>]/g) ?? []).length
               || (body.match(/<entry[\s>]/g) ?? []).length
               || (body.match(/tgme_widget_message_wrap/g) ?? []).length;
    // 时间跨度
    const dates = [...body.matchAll(/<pubDate>(.*?)<\/pubDate>/g)]
      .map(m => new Date(m[1])).filter(d => !isNaN(d)).sort((a, b) => a - b);
    const span = dates.length > 1 ? ((dates.at(-1) - dates[0]) / 3.6e6).toFixed(1) : null;
    return { ok: true, status: r.httpCode, bytes: body.length, items, span, ms: Date.now() - t0, via };
  });
}

const t0 = Date.now();
const results = [];
await Promise.all(cfg.sources.map(async src => {
  const eps = (ALL ? src.endpoints : src.endpoints.filter(e => e.priority === 1))
    .sort((a, b) => a.priority - b.priority);
  for (const ep of eps) {
    const host = new URL(ep.url).hostname;
    const gname = ep.host_group ?? src.host_group ?? hostToGroup[host] ?? 'direct';
    const r = await probe(ep.url, gname);
    results.push({ src: src.id, prio: ep.priority, group: gname, parser: ep.parser, ...r,
                   expect: Array.isArray(src.probe) ? src.probe.find(p => p.endpoint === ep.priority) : src.probe });
    if (!ALL && r.ok) break;
  }
}));

results.sort((a, b) => a.src.localeCompare(b.src) || a.prio - b.prio);
console.log('源'.padEnd(18) + 'P 分组'.padEnd(14) + '状态'.padEnd(10) + '条数'.padEnd(7) + '跨度h'.padEnd(8) + '耗时'.padEnd(8) + '基线对比');
console.log('─'.repeat(92));
let ok = 0, bad = 0, drift = 0;
for (const r of results) {
  const st = r.ok ? String(r.status) : String(r.status);
  let cmp = '';
  if (r.expect) {
    const es = r.expect.status;
    if (r.ok && es === 200) cmp = '✓ 一致';
    else if (!r.ok && es !== 200) cmp = '✓ 一致(仍失效)';
    else { cmp = `⚠️ 漂移 基线=${es}`; drift++; }
  }
  console.log(
    r.src.padEnd(18) + String(r.prio).padEnd(2) + r.group.padEnd(12) +
    (r.ok ? '✅ ' : '❌ ') + st.padEnd(7) +
    String(r.items ?? '-').padEnd(7) + String(r.span ?? '-').padEnd(8) +
    ((r.ms / 1000).toFixed(1) + 's').padEnd(8) + `[${r.via}] ` + cmp);
  r.ok ? ok++ : bad++;
}
// 每个源至少有一条可用路径？
const bySrc = {};
for (const r of results) bySrc[r.src] ??= r.ok || (bySrc[r.src] || false), bySrc[r.src] ||= r.ok;
const dead = Object.entries(bySrc).filter(([, v]) => !v).map(([k]) => k);
console.log('─'.repeat(92));
console.log(`端点 ${ok} 通 / ${bad} 失败，基线漂移 ${drift} 处，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(dead.length ? `❌ 无可用路径的源: ${dead.join(', ')}` : `✅ 全部 ${Object.keys(bySrc).length} 个源均有可用路径`);
process.exit(dead.length ? 1 : 0);
