#!/usr/bin/env node
// 冒烟测试：把 rules.yaml 的 signals 跑在真实抓取内容上，
// 看强制保留预判(A–D)是否真的能命中。
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { XMLParser } from 'fast-xml-parser';

const cfg = parse(readFileSync('config/rules.yaml', 'utf8'));
const S = cfg.signals;

const stripHtml = h => String(h ?? '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
  .replace(/[ \t]+/g, ' ').trim();

const urlsIn = t => [...String(t).matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map(m => m[0]);
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ''; } };
const flat = o => Array.isArray(o) ? o.flatMap(flat) : (o && typeof o === 'object' ? Object.values(o).flatMap(flat) : [o]);
const OFFICIAL = new Set(flat(cfg.official_domains));

// 单个 signal 求值
function has(name, text, html) {
  const d = S[name]; if (!d) return false;
  const urls = urlsIn(html + ' ' + text);
  const hosts = urls.map(hostOf);
  const anyHost = list => hosts.some(h => list.some(x => h === x || h.endsWith('.' + x)));

  switch (name) {
    case 'repo_url':      return anyHost(d.url_host_any);
    case 'demo_link':     return anyHost(d.url_host_any) || urls.some(u => new RegExp(d.or_path_regex).test(u));
    case 'official_link': return hosts.some(h => OFFICIAL.has(h) || [...OFFICIAL].some(x => h.endsWith('.' + x)));
    case 'external_link': return urls.length >= (d.min_count ?? 1);
    case 'aff_link': {
      if (anyHost(d.any_of.find(x => x.url_host_any)?.url_host_any ?? [])) return true;
      const params = d.any_of.find(x => x.url_query_param_any)?.url_query_param_any ?? [];
      if (urls.some(u => { try { const q = new URL(u).searchParams; return params.some(p => q.has(p)); } catch { return false; } })) return true;
      const re = d.any_of.find(x => x.regex)?.regex;
      return re ? new RegExp(re).test(text) : false;
    }
    case 'step_markers': {
      const n = d.min_count ?? 1;
      return d.any_of.some(r => (text.match(new RegExp(r.regex, (r.flags ?? '') + 'g')) ?? []).length >= n);
    }
    default: {
      if (d.regex) return new RegExp(d.regex, d.flags ?? '').test(text);
      if (d.any_of) return d.any_of.some(r => r.regex && new RegExp(r.regex, r.flags ?? '').test(text));
      return false;
    }
  }
}

// A–D 预判
function prescreen(text, html) {
  const sig = Object.fromEntries(Object.keys(S).map(k => [k, has(k, text, html)]));
  const hit = [];
  if (sig.repo_url || sig.demo_link || (sig.code_block && sig.install_hint)) hit.push('A');
  if (sig.code_block || sig.command_line || sig.config_block || (sig.step_markers && sig.external_link)) hit.push('B');
  if (sig.official_link && (sig.price_mention || sig.policy_mention)) hit.push('C');
  if (sig.step_markers && sig.external_link && !sig.aff_link && !sig.invite_code) hit.push('D');
  return { sig, hit };
}

const xml = new XMLParser({ ignoreAttributes: false, cdataPropName: '__cdata' });
for (const [label, file] of [['LINUX DO', 'tests/fixtures/linuxdo-top.xml'], ['V2EX', 'tests/fixtures/v2ex-hot.xml']]) {
  const doc = xml.parse(readFileSync(file, 'utf8'));
  const items = [].concat(doc?.rss?.channel?.item ?? doc?.feed?.entry ?? []);
  console.log(`\n================ ${label} （${items.length} 条）================`);
  const tally = { A:0, B:0, C:0, D:0, none:0 };
  const sigTally = {};
  for (const it of items) {
    const html = String(it.description?.__cdata ?? it.description ?? it.content?.__cdata ?? it.content ?? '');
    const title = String(it.title?.__cdata ?? it.title ?? '');
    const text = stripHtml(html);
    const { sig, hit } = prescreen(title + '\n' + text, html);
    for (const [k,v] of Object.entries(sig)) if (v) sigTally[k] = (sigTally[k]??0)+1;
    if (hit.length) hit.forEach(h => tally[h]++); else tally.none++;
    if (hit.length) console.log(`  [${hit.join('')}] ${title.slice(0,52)}  (${text.length}字)`);
  }
  console.log(`  ---- 预判统计: A=${tally.A} B=${tally.B} C=${tally.C} D=${tally.D} 未命中=${tally.none} / 共${items.length}`);
  console.log(`  ---- 信号命中: ${Object.entries(sigTally).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join('  ') || '无'}`);
}
