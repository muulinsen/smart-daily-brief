/**
 * 简报邮件渲染（PRD 9.4 / 9.5 / 17.3）。
 *
 * 安全前提：所有来源文本都是不可信数据。标题、结论、摘要一律 HTML 转义；
 * 链接只允许 https 且由 URL 解析器重建，绝不把来源正文里的
 * script / style / 事件处理器 / iframe 带进邮件。
 *
 * 格式约束：全部 CSS 内联，无 JavaScript、无外部字体、无远程样式表、
 * 无追踪像素、无装饰性图片；最大内容宽度 760px。完整附录优先，
 * 不按邮件体积裁剪内容。
 */

export type BriefItem = {
  title: string;
  conclusion: string;
  summarySentences: string[];
  /** 渠道显示名，如「LINUX DO」「@GitHub」「即刻」—— 不是内部 id */
  sourceName: string;
  /** 渠道主页，渠道名点击后跳转到这里 */
  sourceSite?: string | null;
  /** 本条内容的原文链接 */
  sourceUrl: string | null;
  /** 补录条目需标注（PRD 6.3），不得写成当前窗口的新发布 */
  lateDiscovery?: { originWindow: string; publishedAt: string; firstSeenAt: string } | null;
  /** 实质更新的条目标「更新」（PRD 7.3） */
  isUpdate?: boolean;
  /** 其他渠道贡献（PRD 7.4）。字符串或 {显示名, 主页} */
  otherSources?: Array<string | { name: string; site?: string | null }>;
};

export type AuditEntry = { title: string; url?: string | null; reason: string };

export type BriefData = {
  date: string;              // YYYY-MM-DD
  windowLabel: string;       // 早报 / 午报 / 晚报
  windowRange: string;       // 人读的窗口区间
  highlights: string[];      // 核心要点 5–8 条
  sections: Array<{ id: string; title: string; items: BriefItem[] }>;
  /** 仅用于同一批数据的版式对照邮件。 */
  comparisonLabel?: '旧版' | '优化版' | '优化修正版';
  audit: {
    /** 强制保留候选未收录时必须逐条列出（PRD 9.3） */
    mandatoryMisses: AuditEntry[];
    /** 其余按类别计数 */
    counts: Array<{ label: string; count: number }>;
    /** 抓取失败与来源异常必须与「无更新」区分开 */
    sourceIssues: Array<{ source: string; site?: string | null; status: string; detail: string }>;
  };
  /**
   * 评估附录（影子运行期用）。逐条列出被过滤与待复核的条目，
   * 让人工能直接在邮件里判断有没有漏项 —— 这是 PRD 24.1 要求的
   * ≥98% 召回率在有黄金集之前唯一可行的核对方式。
   * 稳定运行后可通过 BRIEF_EVAL_APPENDIX=false 关闭。
   */
  evalAppendix?: {
    /** ref 是可引用编号（如 c123）—— 人工回复「保留 c123 c145」即可精确定位 */
    filtered: Array<{ ref: string; title: string; source: string; site?: string | null;
                     url: string | null; reason: string }>;
    pending: Array<{ ref: string; title: string; source: string; site?: string | null;
                    url: string | null; reason: string }>;
    /** 附录被截断时的说明 */
    truncatedNote?: string | null;
  } | null;
};

// ---------- 安全原语 ----------

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 只放行 https 链接，且经 URL 解析器重建。
 * javascript:、data:、http:、以及畸形 URL 一律返回 null。
 */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  return u.toString();
}

// ---------- 设计令牌 ----------
// 邮件客户端对 CSS 变量、媒体查询、外部字体的支持都不可靠，
// 因此全部写死内联值；深色模式靠 color-scheme + 中性色保证可读，
// 不依赖颜色单独表达含义（PRD 9.4）。
const C = {
  page: '#eef1f5',
  card: '#ffffff',
  line: '#e2e7ee',
  lineSoft: '#eef1f5',
  ink: '#161b22',
  body: '#39424e',
  muted: '#6b7684',
  faint: '#8b95a3',
  accent: '#1c5fa8',
  accentSoft: '#e7eef7',
  auditBg: '#f5f7f9',
  warn: '#8a5a00',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";

const wrap = (inner: string, title: string, preheader: string) => `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:28px 12px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
 style="max-width:760px;width:100%;font-family:${FONT};color:${C.body};font-size:15px;line-height:1.7;">
${inner}
</table></td></tr></table></body></html>`;

const badge = (text: string, tone: 'plain' | 'accent' = 'plain') => `<span style="display:inline-block;
 padding:2px 8px;margin:0 6px 6px 0;border-radius:11px;font-size:11px;line-height:1.6;letter-spacing:.02em;
 ${tone === 'accent'
   ? `background:${C.accentSoft};color:${C.accent};`
   : `background:${C.lineSoft};color:${C.muted};`}">${esc(text)}</span>`;

function renderItem(it: BriefItem, index: number): string {
  const url = safeUrl(it.sourceUrl);
  const site = safeUrl(it.sourceSite);
  // 补录条目与普通条目同样展示：不加徽章、不列原窗口。
  // PRD 6.3 要求标注补录，但读者视角里「这条是几点抓到的」不是信息 ——
  // 标注只制造噪声。补录仍然全程记录在 candidates.late_discovery
  // 与审计区计数里，可审计性不受影响。
  const badges = it.isUpdate ? badge('更新', 'accent') : '';
  const late = '';

  const others = it.otherSources?.length
    ? `<div style="margin:8px 0 0;font-size:12px;color:${C.faint};">
        另见 ${it.otherSources.map(o => {
          const u = safeUrl(typeof o === 'string' ? null : o.site);
          const n = esc(typeof o === 'string' ? o : o.name);
          return u ? `<a href="${esc(u)}" style="color:${C.faint};text-decoration:none;
                       border-bottom:1px dotted ${C.line};">${n}</a>` : n;
        }).join(' · ')}</div>` : '';

  return `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
   style="background:${C.card};border:1px solid ${C.line};border-radius:10px;">
  <tr><td style="padding:20px 22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="26" valign="top" style="width:26px;padding:2px 0 0;
        font-size:13px;font-weight:700;color:${C.faint};font-variant-numeric:tabular-nums;">${index}</td>
      <td valign="top">
        ${badges ? `<div style="margin:0 0 6px;">${badges}</div>` : ''}
        <div style="font-size:17px;font-weight:650;line-height:1.45;color:${C.ink};
          letter-spacing:-.01em;">${url ? `<a href="${esc(url)}" style="color:${C.ink};
          text-decoration:none;">${esc(it.title)}</a>` : esc(it.title)}</div>
        <div style="margin:10px 0 0;font-size:15px;line-height:1.7;color:${C.ink};
          font-weight:500;">${esc(it.conclusion)}</div>
        ${it.summarySentences.length ? `<div style="margin:9px 0 0;font-size:14.5px;line-height:1.75;color:${C.body};">
          ${it.summarySentences.map(esc).join(' ')}</div>` : ''}
        ${late}${others}
        <div style="margin:14px 0 0;padding:11px 0 0;border-top:1px solid ${C.lineSoft};font-size:13px;">
          <span style="color:${C.faint};">来源渠道：</span>${
            site ? `<a href="${esc(site)}" style="color:${C.muted};text-decoration:none;
                     border-bottom:1px dotted ${C.line};">${esc(it.sourceName)}</a>`
                 : `<span style="color:${C.faint};">${esc(it.sourceName)}</span>`}
          ${url ? `<span style="color:${C.line};"> &nbsp;·&nbsp; </span><a href="${esc(url)}"
              style="color:${C.accent};text-decoration:none;font-weight:500;">查看原文 &rsaquo;</a>`
                : `<span style="color:${C.line};"> &nbsp;·&nbsp; </span><span style="color:${C.faint};">原文链接不可用</span>`}
        </div>
      </td></tr></table>
  </td></tr></table></td></tr>`;
}

export function renderHtml(d: BriefData): string {
  const total = d.sections.reduce((n, s) => n + s.items.length, 0);
  const subject = subjectOf(d);
  const preheader = `本期收录 ${total} 条，全部完整展示`;
  const parts: string[] = [];

  // 页眉
  parts.push(`<tr><td style="padding:0 4px 20px;">
    <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:${C.faint};
      font-weight:600;">INTELLIGENCE BRIEF</div>
    <div style="margin:7px 0 0;font-size:25px;font-weight:700;color:${C.ink};letter-spacing:-.02em;">
      ${esc(d.date)} ${esc(d.windowLabel)}</div>
    <div style="margin:6px 0 0;font-size:13px;color:${C.muted};">
      窗口 ${esc(d.windowRange)} &nbsp;·&nbsp; 收录 ${total} 条</div>
  </td></tr>`);

  // 分区与条目
  let n = 0;
  for (const s of d.sections) {
    if (!s.items.length) continue;
    parts.push(`<tr><td style="padding:8px 4px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;
          color:${C.muted};font-weight:700;white-space:nowrap;padding:0 12px 0 0;">${esc(s.title)}</td>
        <td width="100%" style="border-bottom:1px solid ${C.line};font-size:0;line-height:0;">&nbsp;</td>
        <td style="padding:0 0 0 12px;font-size:12px;color:${C.faint};white-space:nowrap;">${s.items.length}</td>
      </tr></table></td></tr>`);
    parts.push(s.items.map(it => renderItem(it, ++n)).join(''));
  }

  if (!n) parts.push(`<tr><td style="padding:0 0 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
     style="background:${C.card};border:1px solid ${C.line};border-radius:10px;">
    <tr><td style="padding:24px 22px;text-align:center;color:${C.muted};font-size:14px;">
      本窗口没有达到收录标准的内容。<br>
      <span style="font-size:13px;color:${C.faint};">按既定规则，宁可少发也不用旧消息凑数。</span>
    </td></tr></table></td></tr>`);

  // 审计区
  const a = d.audit;
  const issues = a.sourceIssues.map(i => {
    const u = safeUrl(i.site);
    const name = u ? `<a href="${esc(u)}" style="color:${C.ink};font-weight:600;
      text-decoration:none;border-bottom:1px dotted ${C.line};">${esc(i.source)}</a>`
      : `<span style="color:${C.ink};font-weight:600;">${esc(i.source)}</span>`;
    return `<tr><td style="padding:0 0 6px;font-size:13px;line-height:1.65;color:${C.body};">
      ${name}<span style="color:${C.faint};"> · ${esc(i.status)}</span><br>
      <span style="color:${C.muted};font-size:12.5px;">${esc(i.detail)}</span></td></tr>`;
  }).join('');
  const misses = a.mandatoryMisses.map(m => {
    const u = safeUrl(m.url);
    return `<tr><td style="padding:0 0 6px;font-size:13px;line-height:1.65;">
      <span style="color:${C.ink};">${esc(m.title)}</span>
      ${u ? ` <a href="${esc(u)}" style="color:${C.accent};text-decoration:none;">原文</a>` : ''}<br>
      <span style="color:${C.muted};font-size:12.5px;">${esc(m.reason)}</span></td></tr>`;
  }).join('');
  const counts = a.counts.map(c =>
    `<span style="display:inline-block;margin:0 14px 4px 0;font-size:12.5px;color:${C.muted};">
      ${esc(c.label)} <span style="color:${C.ink};font-weight:600;">${c.count}</span></span>`).join('');

  const sub = (t: string) => `<div style="margin:14px 0 8px;font-size:11px;letter-spacing:.1em;
    text-transform:uppercase;color:${C.faint};font-weight:700;">${t}</div>`;

  parts.push(`<tr><td style="padding:14px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
     style="background:${C.auditBg};border:1px solid ${C.line};border-radius:10px;">
    <tr><td style="padding:18px 22px;">
      <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;
        color:${C.muted};font-weight:700;">来源状态与过滤审计</div>
      ${counts ? `<div style="margin:12px 0 0;">${counts}</div>` : ''}
      ${issues ? sub('抓取失败与来源异常') + `<table role="presentation" width="100%"
        cellpadding="0" cellspacing="0" border="0">${issues}</table>` : ''}
      ${misses ? sub('强制保留候选未收录') + `<table role="presentation" width="100%"
        cellpadding="0" cellspacing="0" border="0">${misses}</table>` : ''}
    </td></tr></table></td></tr>`);

  // 评估附录
  const ea = d.evalAppendix;
  if (ea && (ea.filtered.length || ea.pending.length)) {
    const list = (rows: typeof ea.filtered) => rows.map(x => {
      const u = safeUrl(x.url);
      return `<tr>
        <td valign="top" style="padding:0 8px 8px 0;font-size:12px;line-height:1.6;
          color:${C.accent};font-family:ui-monospace,Menlo,Consolas,monospace;
          white-space:nowrap;">${esc(x.ref)}</td>
        <td style="padding:0 0 8px;font-size:13px;line-height:1.6;">
        <span style="color:${C.ink};">${esc(x.title)}</span>
        ${u ? ` <a href="${esc(u)}" style="color:${C.accent};text-decoration:none;">原文</a>` : ''}
        <div style="color:${C.muted};font-size:12.5px;">${
          safeUrl(x.site) ? `<a href="${esc(safeUrl(x.site)!)}" style="color:${C.muted};
            text-decoration:none;border-bottom:1px dotted ${C.line};">${esc(x.source)}</a>`
            : esc(x.source)} · ${esc(x.reason)}</div>
      </td></tr>`;
    }).join('');
    const sub = (t: string, n: number) => `<div style="margin:14px 0 8px;font-size:11px;
      letter-spacing:.1em;text-transform:uppercase;color:${C.faint};font-weight:700;">${t}（${n}）</div>`;
    parts.push(`<tr><td style="padding:14px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:${C.card};border:1px dashed ${C.line};border-radius:10px;">
      <tr><td style="padding:18px 22px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;
          color:${C.muted};font-weight:700;">评估附录 · 影子运行期</div>
        <div style="margin:6px 0 0;font-size:12.5px;color:${C.faint};line-height:1.6;">
          以下条目未进入正文。若你认为其中有该收录的，回复左侧编号即可
          （例如「保留 c123 c145」），这些反馈会成为评估基线，用于校准筛选规则。</div>
        ${ea.truncatedNote ? `<div style="margin:6px 0 0;font-size:12.5px;color:${C.warn ?? C.muted};">
          ${esc(ea.truncatedNote)}</div>` : ''}
        ${ea.filtered.length ? sub('已过滤', ea.filtered.length) +
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${list(ea.filtered)}</table>` : ''}
        ${ea.pending.length ? sub('待复核（名额不足或需人工）', ea.pending.length) +
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${list(ea.pending)}</table>` : ''}
      </td></tr></table></td></tr>`);
  }

  parts.push(`<tr><td style="padding:20px 4px 0;text-align:center;font-size:11.5px;
    color:${C.faint};line-height:1.7;">
    智能资讯简报 · 每日 08:00 / 12:00 / 22:00（台北）<br>
    本邮件由服务器自动生成，内容以原文为准</td></tr>`);

  return wrap(parts.join('\n'), subject, preheader);
}

/** multipart/alternative 的纯文本备用正文（PRD 9.4）。 */
export function renderText(d: BriefData): string {
  const L: string[] = [];
  L.push(`智能资讯简报 · ${d.windowLabel}`);
  L.push(`${d.date} · 窗口 ${d.windowRange}`);
  L.push('');
  for (const s of d.sections) {
    if (!s.items.length) continue;
    L.push(`【${s.title}】`);
    for (const it of s.items) {
      L.push(`${it.isUpdate ? '[更新]' : ''}${it.title}`);
      L.push(`  ${it.conclusion}`);
      L.push(`  ${it.summarySentences.join(' ')}`);
      const u = safeUrl(it.sourceUrl);
      const st = safeUrl(it.sourceSite);
      L.push(`  来源渠道：${it.sourceName}${st ? ` ${st}` : ''}`);
      L.push(`  原文：${u ?? '（链接不可用）'}`);
      L.push('');
    }
  }
  const ea = d.evalAppendix;
  if (ea && (ea.filtered.length || ea.pending.length)) {
    L.push('【评估附录 · 影子运行期】');
    L.push('以下条目未进入正文。若认为其中有该收录的，回复左侧编号即可（例如「保留 c123 c145」）。');
    if (ea.truncatedNote) L.push(ea.truncatedNote);
    if (ea.filtered.length) {
      L.push(`— 已过滤（${ea.filtered.length}）`);
      for (const x of ea.filtered) {
        L.push(`  [${x.ref}] ${x.title}`);
        L.push(`    ${x.source} · ${x.reason}${safeUrl(x.url) ? ' ' + safeUrl(x.url) : ''}`);
      }
    }
    if (ea.pending.length) {
      L.push(`— 待复核（${ea.pending.length}）`);
      for (const x of ea.pending) {
        L.push(`  [${x.ref}] ${x.title}`);
        L.push(`    ${x.source} · ${x.reason}${safeUrl(x.url) ? ' ' + safeUrl(x.url) : ''}`);
      }
    }
    L.push('');
  }
  L.push('【来源状态与过滤审计】');
  if (d.audit.counts.length)
    L.push(d.audit.counts.map(c => `${c.label} ${c.count}`).join(' · '));
  for (const i of d.audit.sourceIssues) L.push(`- ${i.source} — ${i.status}：${i.detail}`);
  if (d.audit.mandatoryMisses.length) {
    L.push('强制保留候选未收录：');
    for (const m of d.audit.mandatoryMisses) {
      const u = safeUrl(m.url);
      L.push(`- ${m.title}${u ? ` ${u}` : ''} — ${m.reason}`);
    }
  }
  return L.join('\n');
}

export const subjectOf = (d: BriefData & { comparisonLabel?: string }) => {
  const total = d.sections.reduce((n, s) => n + s.items.length, 0);
  return `智能资讯简报｜${d.date}｜${d.windowLabel}｜${total}条` +
    (d.comparisonLabel ? `｜${d.comparisonLabel}` : '');
};

/** 渲染后的硬性校验（PRD 9.4 / 17.3）。任一项失败都不得发送。 */
export function checkEmail(html: string, text: string): string[] {
  const errs: string[] = [];
  if (/<script/i.test(html)) errs.push('HTML 含 <script>');
  if (/<iframe/i.test(html)) errs.push('HTML 含 <iframe>');
  // 只在真实标签内部查事件处理器。被转义的正文里出现 "onerror=" 属于
  // 纯文本、无害，若在全文范围匹配会把安全内容误判为危险。
  for (const t of html.matchAll(/<[a-z][^>]*>/gi))
    if (/\son[a-z]+\s*=/i.test(t[0])) { errs.push('HTML 含事件处理器属性'); break; }
  if (/<link[^>]+stylesheet/i.test(html)) errs.push('HTML 含远程样式表');
  if (/@import|url\(\s*https?:/i.test(html)) errs.push('CSS 含远程资源引用');
  if (/<img/i.test(html)) errs.push('HTML 含图片（禁止装饰性图片与追踪像素）');
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const h = m[1] ?? '';
    if (!/^https:\/\//.test(h.replace(/&amp;/g, '&')))
      errs.push(`存在非 HTTPS 链接: ${h.slice(0, 60)}`);
  }
  if (!text.trim()) errs.push('纯文本备用正文为空');
  return errs;
}
