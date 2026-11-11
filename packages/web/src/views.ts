/**
 * 服务端渲染的后台页面（PRD 16）。
 *
 * 单用户后台不需要 SPA —— 服务端渲染省掉构建链、省内存，
 * 且 CSP 可以完全禁掉脚本（default-src 'none'），攻击面最小。
 * 所有动态值一律转义：数据库里存的是来源方提供的不可信文本。
 */

import type { Alert, BackupStatus, DiskStatus, UnitStatus } from './ops.ts';
import { displayUrl } from './url-redact.ts';

export const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ago = (t: unknown): string => {
  if (!t) return '—';
  const m = Math.round((Date.now() - Date.parse(String(t))) / 60000);
  if (!Number.isFinite(m)) return '—';
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
};

const CSS = `
/* 侧栏 + 主内容。系统字体：后台 CSP 为 default-src 'none'，不加载任何外部字体。 */
:root{
  color-scheme:light;
  --page:#f4f6f9; --card:#fff; --line:#dde3eb; --line-soft:#edf1f5;
  --ink:#141a23; --body:#3a4452; --muted:#687384; --faint:#8a95a5;
  --accent:#1f5aa6; --accent-soft:#e6eef9;
  --ok:#137a4b; --ok-soft:#e3f3ea; --warn:#9a5b06; --warn-soft:#fbf0de; --bad:#b4271f; --bad-soft:#fbe7e5;
  --side:#eef2f7; --side-ink:#2b3442; --side-on:#fff;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media(prefers-color-scheme:dark){:root{
  color-scheme:dark;
  --page:#11151b; --card:#181d25; --line:#2a323d; --line-soft:#212832;
  --ink:#e9eef5; --body:#c3ccd7; --muted:#8a95a5; --faint:#6b7684;
  --accent:#86b3ee; --accent-soft:#1b2a40;
  --ok:#55c995; --ok-soft:#15302a; --warn:#e3a849; --warn-soft:#352812; --bad:#f2827a; --bad-soft:#3a1d1c;
  --side:#141920; --side-ink:#c3ccd7; --side-on:#202733;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--body);
  font:14.5px/1.65 -apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased}
.shell{display:grid;grid-template-columns:200px minmax(0,1fr);min-height:100vh}
.side{background:var(--side);border-right:1px solid var(--line);padding:18px 12px;display:flex;flex-direction:column;gap:2px;
  position:sticky;top:0;height:100vh;overflow-y:auto}
.side .brand{font-weight:700;color:var(--ink);font-size:15px;padding:2px 10px 16px}
.side a{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--side-ink);text-decoration:none;
  padding:7px 10px;border-radius:7px;font-size:14px}
.side a:hover{background:var(--side-on)}
.side a.on{background:var(--side-on);color:var(--ink);font-weight:600;box-shadow:0 0 0 1px var(--line)}
.side .grp{font-size:11px;letter-spacing:.1em;color:var(--muted);padding:16px 10px 4px}
.side form{margin-top:auto;padding:12px 10px 0}
.side form button{width:100%}
.cnt{font-size:11px;font-variant-numeric:tabular-nums;border-radius:9px;padding:0 7px;font-weight:600;line-height:18px}
.cnt.bad{background:var(--bad-soft);color:var(--bad)} .cnt.warn{background:var(--warn-soft);color:var(--warn)}

main{max-width:1180px;width:100%;padding:24px 28px 64px;display:block}
.page-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 18px}
.page-h h1{font-size:20px;color:var(--ink);margin:0;text-wrap:balance}
.page-h span{font-size:12.5px;color:var(--muted)}
h2{font-size:15px;color:var(--ink);font-weight:650;margin:30px 0 10px}
h2:first-child{margin-top:0}
.sub{font-size:13px;color:var(--muted);margin:-4px 0 12px}
.stack{display:grid;gap:10px}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:0 0 16px;flex-wrap:wrap}
.tabs a{padding:7px 13px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px;font-size:14px}
.tabs a:hover{color:var(--ink)}
.tabs a.on{color:var(--ink);border-color:var(--accent);font-weight:600}
.pill.idle{background:var(--line-soft);color:var(--muted)}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:0 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:13px 15px;display:grid;gap:3px;align-content:start}
.card .n{font-size:21px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums;line-height:1.3}
.card .l{font-size:12px;color:var(--muted)}
.card .d{font-size:12px;color:var(--muted);line-height:1.5}
.bar{height:5px;border-radius:3px;background:var(--line-soft);overflow:hidden;margin:2px 0}
.bar i{display:block;height:100%;background:var(--accent)} .bar i.warn{background:var(--warn)} .bar i.bad{background:var(--bad)}

.alerts{display:grid;gap:8px}
.alert{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 14px;border-radius:8px;
  border:1px solid var(--line);background:var(--card)}
.alert.bad{border-color:color-mix(in srgb,var(--bad) 35%,var(--line));background:var(--bad-soft)}
.alert.warn{border-color:color-mix(in srgb,var(--warn) 35%,var(--line));background:var(--warn-soft)}
.alert .sev{font-size:11px;font-weight:700;letter-spacing:.06em}
.alert.bad .sev{color:var(--bad)} .alert.warn .sev{color:var(--warn)} .alert.ok .sev{color:var(--ok)}
.alert .t{color:var(--ink);font-size:13.5px} .alert .t small{display:block;color:var(--muted);font-size:12.5px}
.alert a.act{font-size:12.5px;white-space:nowrap}

.day{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.slot{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:12px 14px;display:grid;gap:6px;align-content:start}
.slot .h{display:flex;justify-content:space-between;align-items:baseline}
.slot .h b{font-size:15px;color:var(--ink)} .slot .h span{font-family:var(--mono);font-size:12px;color:var(--muted)}
.slot .s{font-size:12.5px;color:var(--muted);line-height:1.55}

table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden}
th{font-weight:600;font-size:11.5px;color:var(--muted);padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 12px;font-size:13.5px;border-bottom:1px solid var(--line-soft);vertical-align:top;color:var(--body)}
tr:last-child td{border-bottom:none}
td b{color:var(--ink);font-weight:600}
td small{display:block;color:var(--muted);font-size:12px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td a{color:var(--accent);text-decoration:none} td a:hover{text-decoration:underline}
.tw{overflow-x:auto}

.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.muted{color:var(--muted);font-size:12.5px;line-height:1.55}
.pill{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:10px;font-size:11.5px;font-weight:600;
  background:var(--line-soft);color:var(--muted);white-space:nowrap}
.pill.accent{background:var(--accent-soft);color:var(--accent)}
.pill.ok,.pill.warn,.pill.bad,.pill.idle{gap:5px}
.pill.ok::before,.pill.warn::before,.pill.bad::before,.pill.idle::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.ok{background:var(--ok-soft);color:var(--ok)} .pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--bad-soft);color:var(--bad)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}
code,.mono{font-family:var(--mono);font-size:12.5px}
.feed{font-family:var(--mono);font-size:12px;width:100%}

button{font:inherit;font-size:13px;padding:5px 13px;border:1px solid var(--line);
  background:var(--card);color:var(--ink);border-radius:7px;cursor:pointer;transition:border-color .12s}
button:hover{border-color:var(--muted)}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--card);font-weight:600}
button.primary:hover{opacity:.9}
input,select,textarea{font:inherit;font-size:13px;padding:5px 9px;border:1px solid var(--line);
  border-radius:7px;background:var(--card);color:var(--ink)}
input::placeholder{color:var(--faint)}
form.inline{display:flex;gap:6px;align-items:center;margin:0;flex-wrap:wrap}
form.inline input[name=reason]{width:158px}
details{background:var(--card);border:1px solid var(--line);border-radius:9px;margin:10px 0;overflow:hidden}
summary{cursor:pointer;padding:10px 14px;font-weight:600;color:var(--ink)}
details>table{border-width:1px 0 0;border-radius:0}
details.vendor{margin:8px 12px 12px}

form.login{max-width:352px;margin:11vh auto;background:var(--card);border:1px solid var(--line);
  border-radius:12px;padding:30px 28px}
form.login h2{font-size:19px;color:var(--ink);margin:0 0 4px}
form.login .hint{font-size:13px;color:var(--muted);margin:0 0 20px}
form.login label{display:block;font-size:12px;color:var(--muted);margin:14px 0 5px;font-weight:500}
form.login input{width:100%;padding:10px 12px;font-size:14px}
form.login button{width:100%;padding:10px;margin-top:22px;font-size:14px}

.err,.note{padding:10px 14px;border-radius:8px;font-size:13.5px;line-height:1.6;margin:0 0 16px}
.err{background:var(--bad-soft);border:1px solid color-mix(in srgb,var(--bad) 32%,var(--line));color:var(--bad)}
.note{background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 24%,var(--line));color:var(--body)}
a{color:var(--accent)}
@media(max-width:860px){
  .shell{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;gap:4px;padding:10px 12px;border-right:none;border-bottom:1px solid var(--line)}
  .side .brand{width:100%;padding:2px 6px 6px}
  .side .grp{display:none}
  .side form{margin:0 0 0 auto;padding:0}
  main{padding:18px 16px 40px}
  .day{grid-template-columns:1fr}
  .alert{grid-template-columns:1fr}
  th,td{padding:8px 9px;font-size:13px}
}`;

export type NavKey = 'today' | 'subscriptions' | 'runs' | 'channels' | 'system' | 'settings';
export type NavBadges = Partial<Record<NavKey, { count: number; level: 'bad' | 'warn' }>>;
let navBadges: () => NavBadges = () => ({});
/** 服务端启动时注册：侧栏每个页面旁显示待处理数量。计算失败不影响页面渲染。 */
export function setNavBadges(fn: () => NavBadges): void { navBadges = fn; }

// 后台改造第一期（docs/admin-reorg-p1-design.md §1）：6 个导航
const NAV: Array<[NavKey, string, string] | string> = [
  ['today', '/', '今日'], ['subscriptions', '/subscriptions', '订阅源'], ['runs', '/runs', '日报'], ['channels', '/channels', '消息渠道'],
  '系统', ['system', '/system', '系统运行'], ['settings', '/settings', '设置'],
];
const NAV_BY_TITLE: Record<string, NavKey> = { '今日': 'today', '订阅源': 'subscriptions', '日报': 'runs', '消息渠道': 'channels',
  '系统运行': 'system', '设置': 'settings' };

/** 页面内的子类标签。 */
export const subTabs = (base: string, cur: string, items: Array<[string, string]>, label: string) =>
  `<nav class="tabs" aria-label="${esc(label)}">${items.map(([k, l]) =>
    `<a href="${base}?tab=${k}"${k === cur ? ' class="on" aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>`;

export function layout(title: string, body: string, csrf: string, active: NavKey | undefined = NAV_BY_TITLE[title]): string {
  let badges: NavBadges = {};
  try { badges = navBadges(); } catch { /* 侧栏计数失败不影响页面 */ }
  const links = NAV.map(item => {
    if (typeof item === 'string') return `<div class="grp">${esc(item)}</div>`;
    const [key, href, label] = item; const b = badges[key];
    return `<a href="${href}"${key === active ? ' class="on" aria-current="page"' : ''}>${esc(label)}${b && b.count ? `<span class="cnt ${b.level}">${b.count}</span>` : ''}</a>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 十六源日报后台</title><style>${CSS}</style></head><body>
<div class="shell"><nav class="side" aria-label="主导航"><span class="brand">十六源日报</span>${links}
  <form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>登出</button></form>
</nav><main>${body}</main></div></body></html>`;
}

export function renderLogin(o: { configured: boolean; needTotp: boolean; error?: string }): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 十六源简报后台</title><style>${CSS}</style></head><body>
<form class="login" method="post" action="/login">
  <h2>十六源简报</h2>
  <div class="hint">管理后台</div>
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
  ${o.configured ? '' : '<div class="note">尚未设置 ADMIN_PASSWORD_HASH，当前为只读演示模式，无法登录。</div>'}
  <label>口令</label>
  <input type="password" name="password" autocomplete="current-password" required>
  ${o.needTotp ? '<label>动态验证码</label><input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required>' : ''}
  <button type="submit" class="primary">登录</button>
</form></body></html>`;
}

const healthCls = (h: string) => h === 'healthy' ? 'ok' : h === 'degraded' ? 'warn' : h === 'failing' ? 'bad' : 'muted';
const healthTxt = (h: string) => ({ healthy: '正常', degraded: '降级', failing: '失败' }[h] ?? '未知');
/** 状态用圆点+文字双重编码，不靠颜色单独表达含义。 */
const healthDot = (h: string) =>
  `<span class="${healthCls(h)}"><span class="dot" style="background:currentColor"></span>${healthTxt(h)}</span>`;

type Src = { id: string; display_name: string; category: string; health: string;
  source_group: string;
  harvest_tier: string; consecutive_failures: number; last_success_at: string | null;
  last_http_code: number | null; last_error: string | null; latest_item_at: string | null; enabled: number;
  onboarding_status?: string; observation_until?: string | null; host_group?: string;
  endpoint_url?: string | null; endpoint_parser?: string | null };

/** 订阅源的三个区域（§2）：X 区 = host_group 'github_x_rss'，其余在 RSS 区；Telegram 区由 Telegram 模块渲染。 */
export type SubscriptionTab = 'rss' | 'telegram' | 'x';
export const SUBSCRIPTION_TABS: Array<[SubscriptionTab, string]> = [['rss', 'RSS 订阅源'], ['telegram', 'Telegram 频道与群组'], ['x', 'X 账号']];
export const isXSource = (s: { host_group?: string }) => s.host_group === 'github_x_rss';
const PENDING = ['HUMAN_REVIEW', 'AI_ANALYSIS_FAILED', 'REJECTED'];

const PARSERS = [['rss','RSS / Atom'],['telegram_web','Telegram 网页版 (t.me/s/…)'],
                 ['v2ex_json','V2EX 官方热门 JSON'],
                 ['deepseek_page','DeepSeek 更新日志页'],
                 ['openai_release_notes_page','OpenAI 产品更新页（Jina）']];
const CATS = [['ai','AI 与科技'],['developer','开发者与产品'],['tech','技术资讯'],
              ['article','优质文章'],['society','社会与生活'],['forum','论坛']];
const TIERS = [['standard','标准 60 分钟'],['ranking_feed','榜单型 20 分钟'],
               ['official_changelog','官方日志 120 分钟'],['slow','低频 240 分钟']];
const SOURCE_GROUPS = [['unclassified','未归类'],['openai','OpenAI'],['claude','Claude'],
                       ['google','Google'],['deepseek','DeepSeek'],['cloudflare','Cloudflare'],
                       ['github','GitHub'],['hermes','Hermes Agent'],['meituan','美团'],
                       ['zhihu','知乎热搜'],['weibo','微博热搜'],['baidu','百度热搜']];
const opts = (list: string[][], cur = '') =>
  list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');

export function renderSubscriptions(o: {
  csrf: string; tab: SubscriptionTab; sources: Array<Src & { managed_by?: string }>;
  tests?: Array<{ url: string; outcome: string; parsed_count: number | null; error: string | null; started_at: string }>;
  /** Telegram 区的内容（Telegram 模块渲染） */
  telegramHtml?: string; telegramCount?: number;
  form?: Record<string, string>; saved?: string; error?: string;
}): string {
  const f = o.form ?? {};
  const back = `/subscriptions?tab=${o.tab}`;
  const rssSources = o.sources.filter(s => !isXSource(s)), xSources = o.sources.filter(isXSource);
  const counts: Record<SubscriptionTab, number> = { rss: rssSources.length, x: xSources.length, telegram: o.telegramCount ?? 0 };
  const tabs = `<nav class="tabs" aria-label="订阅源类型">${SUBSCRIPTION_TABS.map(([k, l]) =>
    `<a href="/subscriptions?tab=${k}"${k === o.tab ? ' class="on" aria-current="page"' : ''}>${esc(l)}（${counts[k]}）</a>`).join('')}</nav>`;
  const head = `${o.saved ? `<div class="note">${esc(o.saved)}</div>` : ''}${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
  <div class="page-h"><h1>订阅源</h1><span>一览已订阅的内容，新增或删除来源</span></div>${tabs}`;
  if (o.tab === 'telegram') return layout('订阅源', head + (o.telegramHtml ?? ''), o.csrf, 'subscriptions');

  const list = o.tab === 'x' ? xSources : rssSources;
  const status = (s: Src) => PENDING.includes(String(s.onboarding_status))
    ? '<span class="pill warn">待确认</span>'
    : `${healthDot(s.health)}${s.enabled ? '' : '<span class="pill">已停用</span>'}${s.onboarding_status === 'OBSERVATION' ? '<span class="pill">观察期</span>' : ''}`;
  const manageRow = (s: Src & { managed_by?: string }) => `<tr>
    <td>${esc(s.display_name)}<div class="muted">${esc(s.id)}
      ${s.managed_by === 'admin' ? '<span class="pill accent">后台新增</span>' : ''}</div></td>
    <td style="min-width:300px">
      ${s.endpoint_url ? `<form method="post" action="/sources/${esc(s.id)}/url">
        <input type="hidden" name="csrf" value="${esc(o.csrf)}">
        <input type="hidden" name="redirect" value="${esc(back)}">
        <input name="url" type="url" value="${esc(s.endpoint_url)}" required
          style="width:100%;min-width:280px" aria-label="${esc(s.display_name)}订阅 URL">
        <div class="inline" style="display:flex;gap:6px;margin-top:6px">
          <input name="reason" placeholder="修改理由（必填）" required minlength="4" style="flex:1">
          <button>测试并保存</button>
        </div>
        <div class="muted">解析器：${esc(s.endpoint_parser ?? '—')}</div>
      </form>` : '<span class="muted">无主订阅地址</span>'}
    </td>
    <td>${status(s)}<div class="muted">${esc(ago(s.last_success_at))}</div>
      <form method="post" action="/sources/${esc(s.id)}/group" class="inline" style="margin-top:6px">
        <input type="hidden" name="csrf" value="${esc(o.csrf)}">
        <input type="hidden" name="redirect" value="${esc(back)}">
        <select name="source_group">${opts(SOURCE_GROUPS, s.source_group)}</select>
        <input name="reason" placeholder="调整理由（必填）" required minlength="4"><button>调整分组</button>
      </form></td>
    <td>
      <form method="post" action="/sources/${esc(s.id)}/toggle" class="inline">
        <input type="hidden" name="csrf" value="${esc(o.csrf)}">
        <input type="hidden" name="enabled" value="${s.enabled ? 'false' : 'true'}">
        <input type="hidden" name="redirect" value="${esc(back)}">
        <input name="reason" placeholder="理由（必填）" required minlength="4">
        <button>${s.enabled ? '停用' : PENDING.includes(String(s.onboarding_status)) ? '确认并启用' : '启用'}</button>
      </form>
      ${s.managed_by === 'admin' ? `<form method="post" action="/sources/${esc(s.id)}/delete" class="inline" style="margin-top:5px">
        <input type="hidden" name="csrf" value="${esc(o.csrf)}">
        <input type="hidden" name="redirect" value="${esc(back)}">
        <input name="reason" placeholder="删除理由（必填）" required minlength="4">
        <button>删除</button></form>` : ''}
    </td></tr>`;
  const manageTable = (sources: Array<Src & { managed_by?: string }>) => sources.length
    ? `<table><tr><th>来源</th><th>订阅 URL</th><th>状态 / 分组</th><th>操作</th></tr>${sources.map(manageRow).join('')}</table>`
    : '<p class="muted" style="padding:0 14px 12px">暂无来源。</p>';
  // 不在已知分组里的来源（例如手工改过库）归到「其他分组」，不能从列表里消失
  const known = new Set(SOURCE_GROUPS.map(([key]) => key as string));
  const groupsWith = [...(SOURCE_GROUPS as unknown as Array<[string, string]>).filter(([key]) => list.some(s => s.source_group === key)),
    ...(list.some(s => !known.has(String(s.source_group))) ? [['__other', '其他分组'] as [string, string]] : [])];
  const attention = list.filter(s => s.enabled && (s.health === 'failing' || s.health === 'degraded'));
  const grouped = `${attention.length ? `<h2>需要关注 · ${attention.length} 个</h2><p class="sub">连续失败或降级的来源。</p>${manageTable(attention)}<h2>全部</h2>`
      : `<div class="alerts"><div class="alert ok"><span class="sev">正常</span><div class="t">所有启用的${o.tab === 'x' ? ' X 账号' : '来源'}都在正常采集</div><span></span></div></div><h2>全部</h2>`}
    ${groupsWith.map(([key, label]) => {
      const rows = list.filter(s => key === '__other' ? !known.has(String(s.source_group)) : s.source_group === key);
      return `<details open class="vendor"><summary>${esc(label)}（${rows.length}）</summary>${manageTable(rows)}</details>`;
    }).join('') || '<p class="muted">还没有来源。</p>'}`;

  const testRows = (o.tests ?? []).map(t => `<tr>
    <td class="${t.outcome === 'ok' ? 'ok' : 'bad'}"><span class="dot" style="background:currentColor"></span>${esc(t.outcome)}</td>
    <td style="word-break:break-all">${esc(displayUrl(t.url).slice(0, 70))}</td>
    <td>${t.parsed_count ?? '—'}</td>
    <td class="muted">${esc(String(t.error ?? '').slice(0, 70))}</td>
    <td class="muted">${esc(ago(t.started_at))}</td></tr>`).join('');

  const kindName = o.tab === 'x' ? 'X 账号' : 'RSS 订阅源';
  const body = `${head}
  <p class="sub">共 ${list.length} 个 ${esc(kindName)}。分组仅用于后台整理，不改变日报筛选。</p>
  ${grouped}

  <h2>新增 ${esc(kindName)}</h2>
  <p class="sub">${o.tab === 'x' ? '填写该 X 账号的 RSS 地址（例如 RSSHub 等转换服务生成的地址）。' : ''}系统会先做安全检查并试抓一次，测试通过后直接启用；新来源有 3 天观察期标记（期间照常采集并参与日报）。</p>
  <form method="post" action="/sources/add">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <input type="hidden" name="kind" value="${o.tab === 'x' ? 'x' : 'rss'}">
    <table><tr><th>字段</th><th>值</th><th>说明</th></tr>
      <tr><td>ID</td><td><input name="id" value="${esc(f.id ?? '')}" placeholder="如 hacker_news" required style="width:200px"></td>
          <td class="muted">小写字母/数字/下划线，2–32 位，创建后不可改</td></tr>
      <tr><td>名称</td><td><input name="name" value="${esc(f.name ?? '')}" placeholder="如 Hacker News 首页" required style="width:260px"></td>
          <td class="muted">显示在日报与后台里</td></tr>
      <tr><td>URL</td><td><input name="url" value="${esc(f.url ?? '')}" placeholder="https://…" required style="width:100%;min-width:280px"></td>
          <td class="muted">RSS/Atom 地址或页面地址</td></tr>
      <tr><td>解析器</td><td><select name="parser">${opts(PARSERS, f.parser ?? 'rss')}</select></td>
          <td class="muted">多数订阅源选 RSS / Atom</td></tr>
      <tr><td>分类</td><td><select name="category">${opts(CATS, f.category ?? 'tech')}</select></td>
          <td class="muted">决定进日报的哪个分区</td></tr>
      <tr><td>来源分组</td><td><select name="source_group">${opts(SOURCE_GROUPS, f.source_group ?? 'unclassified')}</select></td>
          <td class="muted">用于后台归类展示，默认未归类</td></tr>
      <tr><td>采集频率</td><td><select name="tier">${opts(TIERS, f.tier ?? 'standard')}</select></td>
          <td class="muted">榜单型条目轮转快，需更密</td></tr>
      <tr><td>优先级</td><td><input name="priority" type="number" min="1" max="9" value="${esc(f.priority ?? '5')}" style="width:70px"></td>
          <td class="muted">1 最高，影响多来源同事件时选谁为主</td></tr>
    </table>
    <p><button class="primary">测试并添加</button></p>
  </form>

  <h2>仅测试（不添加）</h2>
  <form method="post" action="/sources/test" class="inline" style="margin-bottom:6px">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <input type="hidden" name="redirect" value="${esc(back)}">
    <input name="url" placeholder="https://…" required style="width:340px">
    <select name="parser">${opts(PARSERS, 'rss')}</select>
    <button>测试抓取</button>
  </form>

  ${testRows ? `<h2>最近测试记录</h2>
    <table><tr><th>结果</th><th>URL</th><th>条数</th><th>错误</th><th>时间</th></tr>${testRows}</table>` : ''}`;
  return layout('订阅源', body, o.csrf, 'subscriptions');
}

const PROVIDERS = [
  ['mock', 'mock（本地假响应，不花钱）'],
  ['deepseek', 'DeepSeek'],
  ['openai', 'OpenAI'],
  ['openai_compatible', 'OpenAI 兼容格式（自定义 Base URL）'],
  ['qwen', 'Qwen（DashScope 兼容模式）'],
  ['anthropic', 'Anthropic'],
  ['gemini', 'Gemini'],
];
const BASE_URL_DEFAULTS = [
  ['OpenAI', 'https://api.openai.com/v1'],
  ['DeepSeek', 'https://api.deepseek.com/v1'],
  ['Qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['Anthropic', 'https://api.anthropic.com'],
  ['Gemini', 'https://generativelanguage.googleapis.com/v1beta'],
];
const KEY_LABEL: Record<string, string> = {
  OPENAI_API_KEY: 'OpenAI', OPENAI_COMPAT_API_KEY: 'OpenAI 兼容格式', DEEPSEEK_API_KEY: 'DeepSeek', DASHSCOPE_API_KEY: 'Qwen / DashScope',
  ANTHROPIC_API_KEY: 'Anthropic', GEMINI_API_KEY: 'Gemini',
  TELEGRAM_API_ID: 'Telegram API ID', TELEGRAM_API_HASH: 'Telegram API Hash', TELEGRAM_PHONE: 'Telegram 登录手机号',
  EMBEDDING_API_KEY: '向量模型（语义去重）',
};

function renderEmbeddingSettings(csrf: string, vaultOk: boolean, e: NonNullable<Parameters<typeof renderSettings>[0]['embedding']>, managed = false): string {
  const c = e.config;
  const ov = (env: string) => e.envOverridden.includes(env) ? ' <span class="muted">（被环境变量覆盖）</span>' : '';
  if (managed) return `
  <h2 id="embedding">向量模型（语义去重）</h2>
  <p class="sub">是否启用、供应商与模型由「模型分配」中的「向量模型」管理；这里只设置维度与阈值。</p>
  <form method="post" action="/settings/embedding">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <table>
      <tr><td>维度</td><td><input name="dimensions" value="${c.dimensions ? esc(String(c.dimensions)) : ''}" placeholder="留空 = 模型默认" style="width:120px"></td></tr>
      <tr><td>直接合并阈值</td><td><input name="sim_high" value="${esc(String(c.simHigh))}" style="width:80px"></td></tr>
      <tr><td>待确认阈值</td><td><input name="sim_low" value="${esc(String(c.simLow))}" style="width:80px">
        <div class="muted">需满足 0 &lt; 待确认阈值 &lt; 直接合并阈值 ≤ 1。</div></td></tr>
    </table>
    <p><button class="primary" ${vaultOk ? '' : 'disabled'}>保存维度与阈值</button></p>
  </form>`;
  const status = !c.enabled ? '<span class="muted">未启用：本期只合并网址完全相同的条目</span>'
    : e.errors.length ? `<span class="bad">已启用但配置无效：${e.errors.map(esc).join('；')}</span>` : '<span class="ok">已启用，配置有效</span>';
  return `
  <h2 id="embedding">向量模型（语义去重）</h2>
  <p class="sub">新版日报用它判断两条消息是否在说同一件事：AI 先写结构化摘要，再转成向量比较相似度。相似度达到「直接合并」阈值且关键事实不冲突时直接合并，介于两个阈值之间的交给 L2 确认。接口需兼容 OpenAI <code>/embeddings</code>。未启用或不可用时只合并网址完全相同的条目，不影响日报发布。</p>
  <p>当前状态：${status}</p>
  <form method="post" action="/settings/embedding">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <table>
      <tr><td>启用${ov('EMBEDDING_ENABLED')}</td><td><label><input type="checkbox" name="enabled" value="on"${c.enabled ? ' checked' : ''}> 使用向量合并</label></td></tr>
      <tr><td>Base URL${ov('EMBEDDING_BASE_URL')}</td><td><input name="base_url" value="${esc(c.baseUrl)}" placeholder="https://api.openai.com/v1" style="width:320px">
        <div class="muted">必须是 https；http 只允许本机地址。不要把密钥写进地址。</div></td></tr>
      <tr><td>模型 ID${ov('EMBEDDING_MODEL')}</td><td><input name="model" value="${esc(c.model)}" placeholder="text-embedding-3-small" style="width:240px"></td></tr>
      <tr><td>维度${ov('EMBEDDING_DIMENSIONS')}</td><td><input name="dimensions" value="${c.dimensions ? esc(String(c.dimensions)) : ''}" placeholder="留空 = 模型默认" style="width:120px">
        <div class="muted">只有支持 dimensions 参数的模型才填写。更换模型或维度后会重新计算向量。</div></td></tr>
      <tr><td>直接合并阈值${ov('DEDUP_SIM_HIGH')}</td><td><input name="sim_high" value="${esc(String(c.simHigh))}" style="width:80px"></td></tr>
      <tr><td>待确认阈值${ov('DEDUP_SIM_LOW')}</td><td><input name="sim_low" value="${esc(String(c.simLow))}" style="width:80px">
        <div class="muted">需满足 0 &lt; 待确认阈值 &lt; 直接合并阈值 ≤ 1。阈值与模型强相关，换模型后建议用 preview 对比几期再调整。</div></td></tr>
      <tr><td>API Key${ov('EMBEDDING_API_KEY')}</td><td>${e.keySet ? '<span class="ok">已设置</span>' : '<span class="muted">未设置</span>'} <span class="muted">在下方「API Key」表中设置 EMBEDDING_API_KEY</span></td></tr>
    </table>
    <p><button class="primary" ${vaultOk ? '' : 'disabled'}>保存向量模型设置</button></p>
  </form>
  <form method="post" action="/settings/embedding/test">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <p><button>测试连通性</button> <span class="muted">用当前生效的配置请求一次固定文本，显示返回维度与耗时</span></p>
  </form>`;
}

export type SettingsTab = 'models' | 'telegram' | 'keys' | 'data';
export const SETTINGS_TABS: Array<[SettingsTab, string]> = [['models', '模型'], ['telegram', 'Telegram'], ['keys', 'API Key'], ['data', '数据保留与备份']];

export function renderSettings(o: {
  csrf: string; tab?: SettingsTab;
  /** 设置 → Telegram：账号登录、总结与图片识别设置（Telegram 模块渲染） */
  telegramLogin?: string;
  /** 设置 → 数据保留与备份：Telegram 数据保留表单（Telegram 模块渲染）与备份开关 */
  retention?: string; backups?: string;
  vaultOk: boolean; vaultReason?: string;
  secrets: Array<{ name: string; set: boolean; hint: string }>;
  settings: Record<string, string | undefined>;
  envOverrides: string[];
  /** 设置 → Telegram：总结时段、提示词、图片识别每日上限（Telegram 模块渲染） */
  telegram?: string;
  /** 向量模型的当前生效配置（resolveEmbeddingConfig），不含密钥值 */
  embedding?: { config: { enabled: boolean; baseUrl: string; model: string; dimensions: number; simHigh: number; simLow: number }; errors: string[]; envOverridden: string[]; keySet: boolean };
  /** 「模型供应商」「模型分配」两节（model-views.ts 渲染） */
  models?: string;
  /** 全局模型供应商已启用：隐藏各处分散的供应商 / 模型 / 地址 / 密钥输入 */
  managed?: boolean;
  saved?: string; error?: string;
}): string {
  const cur = o.settings.l1Provider ?? o.settings.aiProvider ?? 'mock';
  const providerOpts = (selected: string) => PROVIDERS.map(([v, label]) =>
    `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');

  const tab: SettingsTab = o.tab ?? 'models';
  const keyRow = (k: { name: string; set: boolean; hint: string }) => `<tr>
    <td>${esc(KEY_LABEL[k.name] ?? k.name)}<div class="muted">${esc(k.name)}</div></td>
    <td>${k.set ? `<span class="ok">已设置</span> <span class="muted">${esc(k.hint)}</span>` : '<span class="muted">未设置</span>'}</td>
    <td><form method="post" action="/settings/secret" class="inline">
      <input type="hidden" name="csrf" value="${esc(o.csrf)}">
      <input type="hidden" name="name" value="${esc(k.name)}">
      <input type="password" name="value" placeholder="粘贴新值（留空则清除）" autocomplete="off" style="width:230px">
      <button class="primary">保存</button>
    </form></td></tr>`;
  const tgKeys = o.secrets.filter(k => k.name.startsWith('TELEGRAM_'));
  const otherKeys = o.secrets.filter(k => !k.name.startsWith('TELEGRAM_'));

  const models = `${o.models ?? ''}
  ${o.managed ? '' : `<h2 id="ai">日报 AI 模型与 API 地址（旧配置）</h2>
  <p class="sub">全局模型供应商未启用时使用这里的配置。每个层级的 Base URL 都可以直接编辑。留空使用所选厂商的官方默认地址；“OpenAI 兼容格式”没有默认地址，必须填写 API 根地址（通常以 /v1 结尾）。</p>
  <form method="post" action="/settings/ai">
    <input type="hidden" name="csrf" value="${esc(o.csrf)}">
    <datalist id="base-url-defaults">${BASE_URL_DEFAULTS.map(([, url]) => `<option value="${esc(url)}">`).join('')}</datalist>
    <table><tr><th>层级</th><th>用途</th><th>供应商</th><th>模型 ID</th><th>Base URL（可直接编辑）</th></tr>
      <tr><td>L1</td><td class="muted">批量判定，单期约 80 条 —— 花钱大头</td>
        <td><select name="l1_provider">${providerOpts(cur)}</select></td>
        <td><input name="l1_model" value="${esc(o.settings.l1Model ?? '')}" placeholder="模型 ID" style="width:180px"></td>
        <td><input name="l1_base_url" list="base-url-defaults" value="${esc(o.settings.l1BaseUrl ?? '')}" placeholder="留空 = 厂商默认地址" style="width:300px"></td></tr>
      <tr><td>L2</td><td class="muted">复判：L1 失败、低置信度、被拦截的条目，以及「是否同一件事」的确认</td>
        <td><select name="l2_provider"><option value="">同 L1</option>${providerOpts(o.settings.l2Provider ?? '')}</select></td>
        <td><input name="l2_model" value="${esc(o.settings.l2Model ?? '')}" placeholder="留空则同 L1" style="width:180px"></td>
        <td><input name="l2_base_url" list="base-url-defaults" value="${esc(o.settings.l2BaseUrl ?? '')}" placeholder="留空 = 厂商默认地址" style="width:300px"></td></tr>
      <tr><td>L3</td><td class="muted">仅旧版格式（legacy）使用；新版日报不再有 L3 与人工复核</td>
        <td><select name="l3_provider"><option value="">同 L1</option>${providerOpts(o.settings.l3Provider ?? '')}</select></td>
        <td><input name="l3_model" value="${esc(o.settings.l3Model ?? '')}" placeholder="留空则同 L1" style="width:180px"></td>
        <td><input name="l3_base_url" list="base-url-defaults" value="${esc(o.settings.l3BaseUrl ?? '')}" placeholder="留空 = 厂商默认地址" style="width:300px"></td></tr>
    </table>
    <p class="muted">默认地址：${BASE_URL_DEFAULTS.map(([name, url]) => `${esc(name)} = ${esc(url)}`).join(' ｜ ')}</p>
    <p><button class="primary" ${o.vaultOk ? '' : 'disabled'}>保存供应商设置</button></p>
  </form>`}
  ${o.embedding ? renderEmbeddingSettings(o.csrf, o.vaultOk, o.embedding, !!o.managed) : ''}`;

  const telegram = `${o.telegramLogin ?? ''}
  <h2 id="telegram-keys">Telegram API 凭据</h2>
  <p class="sub">API ID、API Hash 与手机号加密保存在保管库。采集器只在启动时读取它们：保存后需要在服务器上重启 brief-telegram-collector 才会生效。</p>
  <table><tr><th>项目</th><th>状态</th><th>设置</th></tr>${tgKeys.map(keyRow).join('')}</table>
  ${o.telegram ?? ''}`;

  const keys = `<h2 id="keys">API Key</h2>
  <p class="muted">加密存于保管库（0600），主密钥在 root 控制的 /etc/briefing/env 中。页面只显示末四位，任何情况下不回显明文。
    全局模型供应商启用后，模型密钥在「模型」子类的供应商里设置，这里的按厂商密钥只用于旧配置。</p>
  <table><tr><th>厂商</th><th>状态</th><th>设置</th></tr>${otherKeys.map(keyRow).join('')}</table>`;

  const data = `${o.retention ?? ''}
  <h2 id="backups">数据库备份</h2>
  ${o.backups ?? ''}`;

  const body = `
  ${o.saved ? `<div class="note">${esc(o.saved)}</div>` : ''}
  ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
  ${o.vaultOk ? '' : `<div class="err">密钥保管库不可用：${esc(o.vaultReason ?? '')}<br>
    需在 /etc/briefing/env 设置 APP_ENCRYPTION_KEY 并重启 brief-web。</div>`}
  ${o.envOverrides.length ? `<div class="note">以下项被环境变量覆盖，页面上的设置对它们无效：
    ${o.envOverrides.map(esc).join('、')}</div>` : ''}
  <div class="page-h"><h1>设置</h1><span></span></div>
  ${subTabs('/settings', tab, SETTINGS_TABS, '设置分组')}
  ${tab === 'telegram' ? telegram : tab === 'keys' ? keys : tab === 'data' ? data : models}`;
  return layout('设置', body, o.csrf, 'settings');
}

// ---------------- 今日 / 系统运行（后台改版第一期） ----------------

const fmtTime = (ms: number | null | undefined, withDate = false): string => ms == null || !Number.isFinite(ms) ? '—'
  : new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit',
      ...(withDate ? { month: '2-digit', day: '2-digit' } : {}) });
const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分` : s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
};
const until = (ms: number, now: number): string => {
  const m = Math.round((ms - now) / 60000);
  return m < 60 ? `${m} 分钟后` : m < 1440 ? `${Math.round(m / 60)} 小时后` : `${Math.round(m / 1440)} 天后`;
};
const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;
const mb = (b: number) => b >= 2 ** 30 ? gb(b) : `${Math.round(b / 2 ** 20)} MB`;
const num = (n: number) => Number(n ?? 0).toLocaleString('en-US');


export type TodaySlot = { key: string; label: string; clock: string; scheduledAt: number;
  run?: { id?: number; status: string; error: string | null; started_at: string | null; finished_at: string | null } | null;
  items?: number | null; delivery?: { status: string; sent_at: string | null; error: string | null } | null;
  /** 投递方式为「只发 RSS」：定稿即发布，没有邮件投递记录也不算未投递 */
  rssOnly?: boolean };

/** 时段卡片的判定（卡片与今日告警共用，不另立规则）。 */
function slotKind(s: TodaySlot, now: number): 'future' | 'starting' | 'missing' | 'sent' | 'rss' | 'undelivered' | 'failed' | 'running' {
  const r = s.run;
  if (!r) return s.scheduledAt > now ? 'future' : now - s.scheduledAt < 15 * 60_000 ? 'starting' : 'missing';
  if (r.status === 'succeeded') {
    if (s.delivery?.status === 'sent') return 'sent';
    return !s.delivery && s.rssOnly && s.items != null ? 'rss' : 'undelivered';
  }
  return r.status === 'partial' || r.status === 'failed' ? 'failed' : 'running';
}

/**
 * 今日告警只从时段卡片补两类 computeAlerts 没有的：漏运行、已定稿未投递（§11）。
 * 失败 / 部分失败 / 推迟由 computeAlerts 按运行记录给出；这两类都没有失败记录，按窗口不会重复。
 */
export function slotAlerts(slots: TodaySlot[], now: number): Alert[] {
  const out: Alert[] = [];
  for (const s of slots) {
    const k = slotKind(s, now);
    if (k === 'missing') out.push({ level: 'bad', area: 'today', title: `${s.label}没有运行`,
      detail: `${s.clock} 到点后没有找到运行记录`, href: '/system' });
    else if (k === 'undelivered') out.push({ level: 'warn', area: 'today', title: `${s.label}已生成但未投递`,
      detail: (s.delivery?.error ?? s.delivery?.status ?? '没有投递记录').slice(0, 120), href: s.run?.id ? `/runs/${s.run.id}` : '/runs' });
  }
  return out;
}

function slotCard(s: TodaySlot, now: number): string {
  const r = s.run;
  let pill: string, detail: string;
  const kind = slotKind(s, now);
  if (!r) {
    if (kind === 'future') { pill = '<span class="pill idle">未开始</span>'; detail = `${until(s.scheduledAt, now)}开始`; }
    else if (kind === 'starting') { pill = '<span class="pill idle">等待启动</span>'; detail = '定时任务即将开始'; }
    else { pill = '<span class="pill bad">没有运行</span>'; detail = '到点后没有找到运行记录，请检查系统运行页'; }
  } else if (r.status === 'succeeded') {
    const sent = kind === 'sent';
    const rss = kind === 'rss';
    pill = sent ? '<span class="pill ok">已投递</span>' : rss ? '<span class="pill ok">已发布（RSS）</span>' : `<span class="pill warn">${esc(s.delivery?.status ?? '未投递')}</span>`;
    const took = r.started_at && r.finished_at ? `用时 ${fmtDur(Date.parse(r.finished_at) - Date.parse(r.started_at))}` : '';
    detail = [took, s.items != null ? `${s.items} 条` : '', sent ? `${fmtTime(Date.parse(s.delivery!.sent_at!))} 送达` : rss ? '' : esc(s.delivery?.error ?? '')]
      .filter(Boolean).join(' · ');
  } else if (r.status === 'partial' || r.status === 'failed') {
    pill = '<span class="pill bad">未发送</span>'; detail = esc((r.error ?? '运行未成功').slice(0, 120));
  } else {
    pill = '<span class="pill warn">进行中</span>';
    detail = r.started_at ? `已运行 ${fmtDur(now - Date.parse(r.started_at))}` : esc(r.status);
  }
  return `<div class="slot"><div class="h"><b>${r?.id ? `<a href="/runs/${r.id}">${esc(s.label)}</a>` : esc(s.label)}</b><span>${esc(s.clock)}</span></div>${pill}<div class="s">${detail}</div></div>`;
}

/** 今日：只有「待处理」（§3）。告警来自现有判断（computeAlerts + 模型配置 + 时段卡片的漏运行 / 未投递）。 */
export function renderToday(o: { csrf: string; now: number; dateLabel: string; alerts: Alert[] }): string {
  const alerts = o.alerts.length
    ? `<div class="alerts">${o.alerts.map(a => `<div class="alert ${a.level}"><span class="sev">${a.level === 'bad' ? '故障' : '留意'}</span>
        <div class="t">${esc(a.title)}<small>${esc(a.detail)}</small></div><a class="act" href="${esc(a.href)}">去处理</a></div>`).join('')}</div>`
    : `<div class="alerts"><div class="alert ok"><span class="sev">正常</span><div class="t">截至 ${fmtTime(o.now)} 没有待处理事项</div><span></span></div></div>`;
  const body = `
  <div class="page-h"><h1>今日 · ${esc(o.dateLabel)}</h1><span>台北时间 ${fmtTime(o.now)} 更新</span></div>
  <h2>待处理</h2>${alerts}
  <p class="sub" style="margin-top:18px">今天各时段的日报、来源与 Telegram 概况、图片识别队列都在 <a href="/system">系统运行</a>。</p>`;
  return layout('今日', body, o.csrf, 'today');
}

/** 系统运行顶部：今天各时段的日报与运行概况（原今日页的内容，判断逻辑不变）。 */
export function renderTodayOverview(o: {
  now: number; dateLabel: string; slots: TodaySlot[];
  rss: { healthy: number; enabled: number; lastHarvestAt: string | null; lastHarvestNew: number | null };
  telegram: { active: number; enabled: number; messages24h: number; authorized: boolean; heartbeatAt?: string | null };
  ai: { calls: number };
  disk: DiskStatus;
}): string {
  const pct = o.disk ? o.disk.usedBytes / o.disk.totalBytes : 0;
  return `
  <h2>今天的日报 · ${esc(o.dateLabel)}</h2><div class="day">${o.slots.map(s => slotCard(s, o.now)).join('')}</div>
  <h2>运行概况</h2>
  <div class="cards">
    <div class="card"><span class="l">RSS / X 来源</span><span class="n">${o.rss.healthy} / ${o.rss.enabled}</span>
      <span class="d">${o.rss.enabled - o.rss.healthy ? `${o.rss.enabled - o.rss.healthy} 个降级或失败` : '全部正常'} · 最近采集 ${esc(ago(o.rss.lastHarvestAt))}${o.rss.lastHarvestNew != null ? `，新增 ${o.rss.lastHarvestNew} 条` : ''}</span></div>
    <div class="card"><span class="l">Telegram</span><span class="n">${o.telegram.active} / ${o.telegram.enabled}</span>
      <span class="d">${o.telegram.authorized ? '账号已登录' : '<span class="bad">账号未登录</span>'} · 24 小时消息 ${num(o.telegram.messages24h)}${o.telegram.heartbeatAt !== undefined ? ` · 最近同步 ${esc(ago(o.telegram.heartbeatAt))}` : ''}</span></div>
    <div class="card"><span class="l">AI 判定（今天）</span><span class="n">${num(o.ai.calls)} 次</span>
      <span class="d">日报候选的初筛、复核与组装</span></div>
    <div class="card"><span class="l">磁盘</span><span class="n">${o.disk ? `${Math.round(pct * 100)}%` : '—'}</span>
      ${o.disk ? `<div class="bar"><i class="${pct >= .95 ? 'bad' : pct >= .85 ? 'warn' : ''}" style="width:${Math.round(pct * 100)}%"></i></div><span class="d">剩余 ${gb(o.disk.freeBytes)}</span>` : '<span class="d">无法读取</span>'}</div>
  </div>`;
}

const STAGE_LABEL: Record<string, string> = { luna: 'L1 初筛', terra: 'L2 复核', sol: 'L3 复核', compose: '简报组装', digest: '新版日报（各版块 AI 判定与文案）' };

const GDRIVE_STATE: Record<string, string> = { OK: '<span class="ok">成功</span>', FAIL: '<span class="bad">失败</span>', SKIP: '<span class="muted">已跳过（开关关闭）</span>', UNKNOWN: '<span class="muted">没有记录</span>' };

export function renderBackupSwitches(csrf: string, s: { local: boolean; gdrive: boolean; updatedAt: string | null; error?: string },
  g?: { state: string; at: number | null; detail: string }): string {
  // desc 为纯文本（会转义）；extraHtml 为本函数内拼好的可信标记（状态标签）
  const sw = (name: string, on: boolean, label: string, desc: string, extraHtml = '') =>
    `<label style="display:block;margin:6px 0"><input type="checkbox" name="${name}" value="on"${on ? ' checked' : ''}> <b>${esc(label)}</b> <span class="muted">${esc(desc)}</span>${extraHtml}</label>`;
  return `<form method="post" action="/system/backups">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    ${sw('local', s.local, '本机每日备份', '每天维护时把日报库和 Telegram 库压缩保存到 /var/lib/briefing/backups（占用本机磁盘）')}
    ${sw('gdrive', s.gdrive, 'Google Drive 备份', '每天 04:10（台北时间）把两个库和可阅读的聊天文本上传到 Google Drive；最近一次：',
      `${GDRIVE_STATE[g?.state ?? 'UNKNOWN'] ?? ''}${g?.at ? ` <span class="muted">· ${esc(fmtTime(g.at, true))}</span>` : ''}`)}
    ${!s.local && !s.gdrive ? '<p class="bad">两个备份都已关闭：出故障时将无法恢复数据。</p>' : ''}
    ${s.error ? `<p class="warn">${esc(s.error)}</p>` : ''}
    <p class="muted">关闭只会停止之后的新备份，已有备份不会被删除。${s.updatedAt ? `最近修改：${esc(fmtTime(Date.parse(s.updatedAt), true))}` : ''}</p>
    <p><button class="primary">保存备份设置</button></p>
  </form>`;
}

export function renderSystem(o: { csrf: string; now: number; units: UnitStatus[]; backups: BackupStatus[]; disk: DiskStatus;
  /** 原今日页的时段卡片与运行概况（renderTodayOverview） */
  overview?: string;
  /** 图片识别（Telegram 模块渲染） */
  vision?: string;
  ai24h: { calls: number; byStage: Array<{ stage: string; model: string; calls: number }> };
  /** 备份开关与 Google Drive 备份状态（缺省视为全部开启、状态未知） */
  backupSettings?: { local: boolean; gdrive: boolean; updatedAt: string | null; error?: string };
  gdrive?: { state: 'OK' | 'FAIL' | 'SKIP' | 'UNKNOWN'; at: number | null; detail: string };
  notice?: string }): string {
  const unitRow = (u: UnitStatus) => {
    const running = u.active === 'activating' || (u.kind === 'daemon' && u.active === 'active');
    const pill = u.kind === 'daemon'
      ? (u.active === 'active' ? '<span class="pill ok">运行中</span>' : `<span class="pill bad">${esc(u.active)}</span>`)
      : running ? '<span class="pill warn">正在运行</span>'
      : u.result === 'success' ? '<span class="pill ok">成功</span>'
      : u.result === 'unknown' ? '<span class="pill idle">未知</span>' : `<span class="pill bad">${esc(u.result)}</span>`;
    const last = u.kind === 'daemon' ? (u.startedAt ? `${fmtTime(u.startedAt, true)} 启动` : '—')
      : u.startedAt ? `${fmtTime(u.startedAt, true)}${u.exitedAt && u.exitedAt >= u.startedAt ? ` · ${fmtDur(u.exitedAt - u.startedAt)}` : ''}` : '—';
    const next = u.kind === 'daemon' ? '常驻' : u.nextAt ? `${fmtTime(u.nextAt, u.nextAt - o.now > 20 * 3600_000)}（${until(u.nextAt, o.now)}）` : esc(u.every ?? '—');
    return `<tr><td><b>${esc(u.label)}</b><small>${esc(u.id)}</small></td><td>${pill}</td><td>${last}</td><td>${next}</td></tr>`;
  };
  const pct = o.disk ? o.disk.usedBytes / o.disk.totalBytes : 0;
  const body = `
  <div class="page-h"><h1>系统运行</h1><span>定时任务状态读取自 systemd · ${fmtTime(o.now)} 更新</span></div>
  ${o.overview ?? ''}
  <h2>定时任务</h2>
  ${o.units.length ? `<div class="tw"><table><tr><th>任务</th><th>上次结果</th><th>上次运行</th><th>下次运行</th></tr>${o.units.map(unitRow).join('')}</table></div>`
    : '<div class="err">无法读取 systemd 状态，请在服务器上执行 systemctl status brief-* 查看。</div>'}
  <h2 id="backups">备份与存储</h2>
  ${o.notice ? `<div class="note">${esc(o.notice)}</div>` : ''}
  ${(() => { const b = o.backupSettings ?? { local: true, gdrive: true, updatedAt: null };
    return `<p>本机每日备份：${b.local ? '<span class="ok">开启</span>' : '<span class="bad">关闭</span>'} · Google Drive 备份：${b.gdrive ? '<span class="ok">开启</span>' : '<span class="bad">关闭</span>'}
      ${GDRIVE_STATE[o.gdrive?.state ?? 'UNKNOWN'] ? `（最近一次：${GDRIVE_STATE[o.gdrive?.state ?? 'UNKNOWN']}${o.gdrive?.at ? ` · ${esc(fmtTime(o.gdrive.at, true))}` : ''}）` : ''}
      · <a href="/settings?tab=data#backups">去设置修改</a></p>`; })()}
  <div class="cards">
    ${o.backups.map(b => `<div class="card"><span class="l">${esc(b.label)}备份</span><span class="n">${b.file ? mb(b.bytes) : '—'}</span>
      <span class="d">${b.mtime ? `${fmtTime(b.mtime, true)} · 最新一份` : '<span class="bad">没有找到备份</span>'}</span></div>`).join('')}
    <div class="card"><span class="l">磁盘</span><span class="n">${o.disk ? `${gb(o.disk.usedBytes)} / ${gb(o.disk.totalBytes)}` : '—'}</span>
      ${o.disk ? `<div class="bar"><i class="${pct >= .95 ? 'bad' : pct >= .85 ? 'warn' : ''}" style="width:${Math.round(pct * 100)}%"></i></div><span class="d">剩余 ${gb(o.disk.freeBytes)}</span>` : ''}</div>
  </div>
  <h2>AI 判定（最近 24 小时）</h2>
  <p class="sub">日报共调用 ${num(o.ai24h.calls)} 次。Telegram 总结与图片识别的调用不在此表内。</p>
  ${o.ai24h.byStage.length ? `<div class="tw"><table><tr><th>环节</th><th>模型</th><th class="n">次数</th></tr>${o.ai24h.byStage.map(t =>
    `<tr><td>${esc(STAGE_LABEL[t.stage] ?? t.stage)}</td><td><code>${esc(t.model)}</code></td><td class="n">${num(t.calls)}</td></tr>`).join('')}</table></div>` : '<p class="muted">最近 24 小时没有调用。</p>'}
  ${o.vision ? `<h2 id="vision">Telegram 图片识别</h2>${o.vision}` : ''}`;
  return layout('系统运行', body, o.csrf, 'system');
}

// ---------------- 日报记录（后台改版第二期） ----------------

export type RunRow = { id: number; window_key: string; window_label: string; scheduled_at: string; started_at: string | null;
  finished_at: string | null; status: string; stage: string | null; trigger: string; error: string | null;
  cands: number; items: number | null; brief_id: number | null; delivery_status: string | null; sent_at: string | null; resends: number;
  /** 投递方式为「只发 RSS」：有定稿即已发布 */
  rss_only?: boolean };

const runPill = (r: Pick<RunRow, 'status' | 'delivery_status'> & Partial<Pick<RunRow, 'rss_only' | 'brief_id'>>, queued = false) =>
  queued ? '<span class="pill warn">排队中</span>'
  : r.status === 'succeeded' ? (r.delivery_status === 'sent' ? '<span class="pill ok">已投递</span>'
    : !r.delivery_status && r.rss_only && r.brief_id ? '<span class="pill ok">已发布（RSS）</span>'
    : `<span class="pill warn">${esc(r.delivery_status ?? '未投递')}</span>`)
  : r.status === 'partial' || r.status === 'failed' ? '<span class="pill bad">未发送</span>'
  : '<span class="pill warn">进行中</span>';
const runTitle = (r: Pick<RunRow, 'window_key' | 'window_label'>) => `${r.window_key.slice(5, 10)} ${r.window_label}`;
const runDur = (r: Pick<RunRow, 'started_at' | 'finished_at'>) =>
  r.started_at && r.finished_at ? fmtDur(Date.parse(r.finished_at) - Date.parse(r.started_at)) : '—';

export function renderRuns(o: { csrf: string; runs: RunRow[]; filter: 'all' | 'failed'; queued: string[]; notice?: string;
  /** 日报 → Telegram 要点（Telegram 模块渲染）；给出时显示该标签的内容 */
  telegramHtml?: string; error?: string }): string {
  const top = `<nav class="tabs" aria-label="日报类型"><a href="/runs"${o.telegramHtml === undefined ? ' class="on" aria-current="page"' : ''}>日报记录</a><a href="/runs?tab=telegram"${o.telegramHtml !== undefined ? ' class="on" aria-current="page"' : ''}>Telegram 要点</a></nav>`;
  if (o.telegramHtml !== undefined) return layout('日报', `${o.notice ? `<div class="note">${esc(o.notice)}</div>` : ''}${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
    <div class="page-h"><h1>日报</h1><span>Telegram 跨频道要点</span></div>${top}${o.telegramHtml}`, o.csrf, 'runs');
  const rows = o.runs.map(r => `<tr>
    <td><a href="/runs/${r.id}"><b>${esc(runTitle(r))}</b></a><small>${r.started_at ? `${fmtTime(Date.parse(r.started_at))} 开始` : '未开始'}</small></td>
    <td>${runPill(r, o.queued.includes(r.window_key))}</td>
    <td class="n">${num(r.cands)}</td><td class="n">${r.items ?? '—'}</td><td class="n">${runDur(r)}</td>
    <td>${r.status === 'succeeded' ? (r.sent_at ? `${fmtTime(Date.parse(r.sent_at), true)} 送达${r.resends ? ` · 补发 ${r.resends} 次` : ''}` : '') : `<span class="bad">${esc((r.error ?? '').slice(0, 80))}</span>`}</td>
    <td><a href="/runs/${r.id}">详情</a></td></tr>`).join('');
  const tab = (key: 'all' | 'failed', label: string) => `<a href="/runs${key === 'failed' ? '?status=failed' : ''}"${o.filter === key ? ' class="on" aria-current="page"' : ''}>${label}</a>`;
  const body = `
  ${o.notice ? `<div class="note">${esc(o.notice)}</div>` : ''}
  <div class="page-h"><h1>日报</h1><span>最近 ${o.runs.length} 次运行</span></div>${top}
  <nav class="tabs" aria-label="筛选">${tab('all', '全部')}${tab('failed', '仅未发送')}</nav>
  <div class="tw"><table><tr><th>时段</th><th>状态</th><th class="n">候选</th><th class="n">入选</th><th class="n">用时</th><th>说明</th><th></th></tr>
  ${rows || '<tr><td colspan="7">没有符合条件的运行记录</td></tr>'}</table></div>`;
  return layout('日报', body, o.csrf, 'runs');
}

const DECISION: Record<string, [string, string]> = {
  retain: ['必选保留', 'ok'], normal: ['入选', 'ok'], escalate: ['待复核', 'warn'], filter: ['过滤', 'idle'] };
const STAGE: Record<string, string> = { luna: 'L1', terra: 'L2', sol: 'L3', compose: '组装' };

function renderRetry(t: NonNullable<Parameters<typeof renderRunDetail>[0]['retry']>): string {
  const time = (s: string | null) => s ? new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', hour12: false }) : '—';
  const OUT: Record<string, string> = { published: '已发布', waiting_ai: '有未判定，推迟发布' };
  return `<h2>AI 判定与推迟发布</h2>
  <p class="muted">截止时间 ${esc(time(t.deadline_at))} · 下次重试 ${esc(time(t.next_attempt_at))} · 未判定 ${t.unresolved} 条${t.last_error_kind ? ` · 最后错误类型 ${esc(t.last_error_kind)}` : ''}</p>
  ${t.attempts.length ? `<div class="tw"><table><tr><th>触发</th><th>开始</th><th>结束</th><th>结果</th><th>未判定</th><th>错误类型</th></tr>${t.attempts.map(a =>
    `<tr><td>${a.trigger === 'timer' ? '定时' : '手动'}</td><td>${esc(time(a.started_at))}</td><td>${esc(time(a.finished_at))}</td><td>${esc(OUT[a.outcome ?? ''] ?? a.outcome ?? '进行中或中断')}</td><td>${a.unresolved ?? '—'}</td><td>${esc(a.error_kind ?? '')}</td></tr>`).join('')}</table></div>` : ''}
  ${t.refused.length ? `<h3>模型拒绝处理、按排除计 · ${t.refused.length} 条</h3><ul>${t.refused.map(x => `<li>${esc(x.task)}：${esc(x.label)}</li>`).join('')}</ul>` : ''}`;
}

export function renderRunDetail(o: { csrf: string; run: RunRow; queued: boolean; notice?: string;
  deliveries: Array<{ delivery_type: string; resend_sequence: number; status: string; sent_at: string | null; created_at: string; error: string | null }>;
  candidates: Array<{ id: number; title: string; source_id: string; canonical_url: string | null; decision: string; mandatory_class: string | null;
    section: string | null; filter_reason: string | null; stage: string | null; confidence: number | null; ai_reason: string | null; overridden: number }>;
  /** 新流程：推迟发布状态、构建尝试与模型拒绝处理的条目 */
  retry?: { deadline_at: string | null; next_attempt_at: string | null; unresolved: number; last_error_kind: string | null;
    refused: Array<{ task: string; label: string }>; attempts: Array<{ trigger: string; started_at: string; finished_at: string | null; outcome: string | null; unresolved: number | null; error_kind: string | null }> } }): string {
  const r = o.run;
  const csrf = `<input type="hidden" name="csrf" value="${esc(o.csrf)}">`;
  const actions = [
    r.status !== 'succeeded' && r.finished_at ? `<form class="inline" method="post" action="/runs/${r.id}/rerun">${csrf}<button class="primary"${o.queued ? ' disabled' : ''}>${o.queued ? '已排队，等待运行' : '重新运行此时段'}</button></form>` : '',
    r.brief_id ? `<form class="inline" method="post" action="/runs/${r.id}/resend">${csrf}<button>重新发送邮件</button></form>` : '',
  ].filter(Boolean).join('');
  const groups = ['retain', 'normal', 'escalate', 'filter'].map(d => [d, o.candidates.filter(c => c.decision === d)] as const)
    .concat([['other', o.candidates.filter(c => !DECISION[c.decision])] as const]).filter(([, xs]) => xs.length);
  const cRow = (c: typeof o.candidates[number]) => {
    const [label, cls] = DECISION[c.decision] ?? [c.decision, 'idle'];
    return `<tr><td>${c.canonical_url ? `<a href="${esc(c.canonical_url)}" rel="noreferrer noopener" target="_blank">${esc(c.title)}</a>` : esc(c.title)}
      <small>${esc(c.source_id)}${c.section ? ` · ${esc(c.section)}` : ''}${c.mandatory_class && c.mandatory_class !== 'none' ? ` · ${esc(c.mandatory_class)} 类` : ''}${c.overridden ? ' · <b>已人工处理</b>' : ''}</small></td>
      <td><span class="pill ${cls}">${esc(label)}</span>${c.stage ? `<small>${esc(STAGE[c.stage] ?? c.stage)}${c.confidence != null ? ` · 置信 ${Math.round(c.confidence * 100)}%` : ''}</small>` : ''}</td>
      <td class="muted">${esc((c.filter_reason ?? c.ai_reason ?? '').slice(0, 140))}</td>
      <td><form class="inline" method="post" action="/candidates/${c.id}/override">${csrf}<input type="hidden" name="redirect" value="/runs/${r.id}">
        <select name="action" aria-label="处理方式"><option value="include">改为入选</option><option value="retain">必选保留</option><option value="filter">过滤掉</option><option value="lock">锁定当前判定</option></select>
        <input name="reason" required placeholder="原因" aria-label="原因" style="width:120px"><button>保存</button></form></td></tr>`;
  };
  const body = `
  ${o.notice ? `<div class="note">${esc(o.notice)}</div>` : ''}
  <div class="page-h"><h1>${esc(runTitle(r))}</h1><span><a href="/runs">← 日报</a></span></div>
  <div class="cards">
    <div class="card"><span class="l">状态</span><span>${runPill(r, o.queued)}</span><span class="d">${esc(r.stage ?? '')}</span></div>
    <div class="card"><span class="l">候选 / 入选</span><span class="n">${num(r.cands)} / ${r.items ?? '—'}</span></div>
    <div class="card"><span class="l">用时</span><span class="n">${runDur(r)}</span><span class="d">${r.started_at ? `${fmtTime(Date.parse(r.started_at), true)} 开始` : '未开始'}</span></div>
    <div class="card"><span class="l">投递</span><span class="n">${r.sent_at ? fmtTime(Date.parse(r.sent_at), true) : '—'}</span><span class="d">${r.sent_at ? `邮件已送达${r.resends ? `，补发 ${r.resends} 次` : ''}` : '尚未送达'}</span></div>
  </div>
  ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}
  ${actions ? `<div class="stack" style="grid-auto-flow:column;justify-content:start">${actions}</div>
  <p class="sub">${r.status !== 'succeeded' ? '重新运行会走完整流程：已完成的 AI 判定会复用，只补做未完成的部分。' : ''}${r.brief_id ? '重新发送会把这一期再发一次到收件邮箱。' : ''}</p>` : ''}
  ${o.retry ? renderRetry(o.retry) : ''}
  ${o.deliveries.length ? `<h2>投递记录</h2><div class="tw"><table><tr><th>类型</th><th>状态</th><th>时间</th><th>错误</th></tr>${o.deliveries.map(d =>
    `<tr><td>${d.delivery_type === 'primary' ? '首次投递' : d.delivery_type === 'resend' ? `补发 #${d.resend_sequence}` : esc(d.delivery_type)}</td>
     <td>${d.status === 'sent' ? '<span class="pill ok">已送达</span>' : `<span class="pill bad">${esc(d.status)}</span>`}</td>
     <td>${fmtTime(Date.parse(d.sent_at ?? d.created_at), true)}</td><td class="muted">${esc(d.error ?? '')}</td></tr>`).join('')}</table></div>` : ''}
  <h2>候选内容</h2>
  <p class="sub">人工处理在下一次运行或重新运行时生效；选择“锁定当前判定”可防止 AI 重新判定时改变结果。</p>
  ${groups.map(([d, xs]) => {
    const label = d === 'other' ? '其他' : DECISION[d]![0];
    const table = `<div class="tw"><table><tr><th>标题</th><th>判定</th><th>理由</th><th>人工处理</th></tr>${xs.map(cRow).join('')}</table></div>`;
    return d === 'filter' ? `<details><summary>${esc(label)} · ${xs.length} 条</summary>${table}</details>` : `<h2>${esc(label)} · ${xs.length} 条</h2>${table}`;
  }).join('') || '<p class="muted">这次运行没有候选内容。</p>'}`;
  return layout('日报', body, o.csrf, 'runs');
}

// ---------------- 订阅输出（后台改版第二期） ----------------

export type FeedRow = { group: string; name: string; note: string; url: string | null; lastAt: string | null;
  action: string; csrfExtra?: string; empty?: string };

export type ChannelTab = 'rss' | 'email';
export const CHANNEL_TABS: Array<[ChannelTab, string]> = [['rss', 'RSS 订阅链接'], ['email', '邮件']];

/** 消息渠道（§1）：RSS（原订阅输出）、邮件（只读状态）。Telegram Bot 在第三期。 */
export function renderChannels(o: { csrf: string; now: number; tab: ChannelTab; feeds: FeedRow[];
  email: { mode: string; configured: boolean; transport: string; to: string | null } }): string {
  const head = `<div class="page-h"><h1>消息渠道</h1><span>日报以哪些方式发出去</span></div>${subTabs('/channels', o.tab, CHANNEL_TABS, '消息渠道')}`;
  if (o.tab === 'email') {
    const e = o.email;
    return layout('消息渠道', `${head}
    <table><tr><td>投递方式</td><td>${e.mode === 'rss_only' ? '只发 RSS（不发邮件）' : esc(e.mode)}</td></tr>
      <tr><td>邮件通道</td><td>${e.configured ? `已配置（${esc(e.transport)}）` : `<span class="bad">不会发送邮件</span>${e.transport ? ` <span class="muted">${esc(e.transport)}</span>` : ''}`}</td></tr>
      <tr><td>收件地址</td><td>${e.to ? esc(e.to) : '<span class="muted">未设置</span>'}</td></tr></table>
    <p class="sub">本期只读显示。投递方式在 config/rules.yaml 的 delivery 中设置，邮件通道在服务器环境变量中配置；后台编辑与 Telegram Bot 渠道在后续版本提供。每一期的实际投递结果见 <a href="/runs">日报</a>。</p>`, o.csrf, 'channels');
  }
  const csrf = `<input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="redirect" value="/channels?tab=rss">`;
  const groups = [...new Set(o.feeds.map(f => f.group))];
  const row = (f: FeedRow) => `<tr><td><b>${esc(f.name)}</b><small>${esc(f.note)}</small></td>
    <td>${f.lastAt ? esc(ago(f.lastAt)) : `<span class="muted">${esc(f.empty ?? '尚无内容')}</span>`}</td>
    <td style="min-width:260px">${f.url ? `<input class="feed" readonly value="${esc(f.url)}" aria-label="${esc(f.name)} 订阅地址">` : '<span class="muted">令牌已撤销</span>'}</td>
    <td><form class="inline" method="post" action="${esc(f.action)}">${csrf}<button name="action" value="reset">${f.url ? '重置' : '生成'}</button>${f.url ? '<button name="action" value="revoke">撤销</button>' : ''}</form></td></tr>`;
  return layout('消息渠道', `${head}
  <p class="sub">地址里包含访问令牌，知道地址的人都能读取内容，请勿公开。重置后旧地址立即失效，需要在阅读器里换成新地址。「跨频道要点」与「全部频道」共用一个令牌，重置其中一个两者都会变。</p>
  ${groups.map(g => `<h2>${esc(g)}</h2><div class="tw"><table><tr><th>订阅</th><th>最近更新</th><th>地址</th><th></th></tr>${o.feeds.filter(f => f.group === g).map(row).join('')}</table></div>`).join('')}`, o.csrf, 'channels');
}
