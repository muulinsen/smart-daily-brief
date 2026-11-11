import { esc } from '../../web/src/views.ts';

/**
 * Telegram 的各个部分（后台改造第一期，docs/admin-reorg-p1-design.md §2）：
 * 来源 → 订阅源 · Telegram 区；要点汇总 → 日报 · Telegram 要点；图片识别 → 系统运行；
 * 登录与总结设置 → 设置 · Telegram；数据保留 → 设置 · 数据保留与备份。
 */

type Digest = { window_end: string; status: string; fallback: number; source_ids: string; rendered_html: string | null;
  error: string | null; attempts: number; next_attempt_at: string | null; response_model: string | null };

const ago = (t: string | null | undefined) => {
  if (!t) return '—';
  const m = Math.round((Date.now() - Date.parse(t)) / 60000);
  return m < 60 ? `${Math.max(m, 0)} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};
const local = (t: string, tz: string) => new Date(t).toLocaleString('zh-CN', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const hidden = (csrf: string, redirect: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="redirect" value="${esc(redirect)}">`;

/** 订阅源 · Telegram 区。 */
export function telegramSourcesSection(o: { csrf: string; sources: any[]; worker: any; baseUrl: string; timezone: string;
  /** 添加失败时回填的表单（都是非敏感字段） */
  form?: { display_name?: string; reference?: string; source_type?: string } }): string {
  const f = o.form ?? {};
  const back = '/subscriptions?tab=telegram';
  const csrf = hidden(o.csrf, back);
  const pill = (s: any) => s.status === 'error' ? '<span class="pill bad">出错</span>'
    : s.status === 'pending' ? '<span class="pill warn">验证中</span>'
    : !s.enabled ? '<span class="pill idle">已停用</span>' : '<span class="pill ok">采集中</span>';
  /** 每行的 RSS：url 类型不提供；令牌撤销显示「已撤销 · 生成」；停用来源仍可管理令牌（停用 ≠ 撤销）。 */
  const rss = (s: any) => s.source_type === 'url' ? '<span class="muted">—</span>'
    : s.rss_token ? `<input class="feed" readonly value="${esc(`${o.baseUrl}/rss/telegram/source/${s.rss_token}`)}" aria-label="${esc(s.display_name || s.title || s.reference)} RSS" style="width:200px">
      <form class="inline" method="post" action="/telegram/sources/${s.id}/token">${csrf}<button name="action" value="reset">重置</button><button name="action" value="revoke">撤销</button></form>`
    : `<span class="muted">已撤销</span> <form class="inline" method="post" action="/telegram/sources/${s.id}/token">${csrf}<button name="action" value="reset">生成</button></form>`;
  const failures = (s: any) => Number(s.summary_failures ?? 0)
    ? `<small class="bad">近 2 天有 ${Number(s.summary_failures)} 个时段总结失败（最近 ${esc(local(s.summary_failed_window, o.timezone))}），已用完自动重试、不会再自动重做，要点里会缺这个频道；需要在服务器上重置这些任务才会重做</small>` : '';
  const rows = o.sources.map(s => {
    const unnamed = !s.display_name && !s.title;
    return `<tr><td><form class="inline" method="post" action="/telegram/sources/${s.id}/name">${csrf}<input name="display_name" value="${esc(s.display_name || '')}" placeholder="${esc(s.title || s.reference)}" aria-label="显示名" style="width:190px"><button>保存</button></form>
      <small>${esc(s.reference)} · ${s.telegram_kind === 'group' ? '群组' : s.telegram_kind === 'channel' ? '频道' : '未解析'}${s.source_type === 'url' ? ' · 仅提取 URL' : ''}${s.retain_all_history ? ' · 保留全部历史' : ''}${unnamed ? ' · <span class="warn">未设置显示名</span>' : ''}</small></td>
    <td>${pill(s)}${s.last_error ? `<small class="bad">${esc(s.last_error)}</small>` : ''}${failures(s)}</td>
    <td>${esc(ago(s.last_message_at))}<small>同步 ${esc(ago(s.last_success_at))}</small></td>
    <td class="n">${Number(s.messages_24h ?? 0).toLocaleString('en-US')}</td>
    <td>${rss(s)}</td>
    <td><form class="inline" method="post" action="/telegram/sources/${s.id}/${s.status === 'error' ? 'retry' : 'toggle'}">${csrf}${s.status === 'error' ? '<button>重试验证</button>' : `<input type="hidden" name="enabled" value="${s.enabled ? 'false' : 'true'}"><button>${s.enabled ? '停用' : '启用'}</button>`}</form></td></tr>`;
  }).join('');
  return `<p class="sub">${o.worker?.authorized ? '账号已登录' : '<span class="bad">账号未登录</span>（在 <a href="/settings?tab=telegram">设置 → Telegram</a> 登录）'} · 上一轮同步完成于 ${esc(ago(o.worker?.heartbeat_at))}</p>
  <div class="tw"><table><tr><th>显示名 / 地址</th><th>状态</th><th>最近消息</th><th class="n">24 小时</th><th>RSS</th><th></th></tr>${rows || '<tr><td colspan="6">暂无来源</td></tr>'}</table></div>
  <p class="sub" style="margin-top:8px">显示名会用在 RSS 标题和要点汇总的来源标注里；留空则使用 Telegram 上的频道标题。汇总 RSS 地址在 <a href="/channels?tab=rss">消息渠道 → RSS</a>。</p>
  <h2>新增 Telegram 频道或群组</h2><p class="sub">支持 @username、t.me/username、t.me/s/username、已加入私群的邀请链接及 t.me/c/… 消息链接。系统不会自动加入群组。</p>
  <form class="inline" method="post" action="/telegram/sources">${csrf}<input name="display_name" value="${esc(f.display_name ?? '')}" placeholder="显示名（可选）" aria-label="显示名"><input name="reference" value="${esc(f.reference ?? '')}" required placeholder="@username 或 t.me/…" aria-label="地址" style="width:280px"><select name="source_type" aria-label="类型"><option value="normal">普通总结</option><option value="url"${f.source_type === 'url' ? ' selected' : ''}>仅提取 URL</option></select><button class="primary">添加并验证</button></form>`;
}

/** 日报 · Telegram 要点。 */
export function telegramDigestsSection(o: { csrf: string; digests: Digest[]; settings: any; lookbackFrom: string }): string {
  const tz = o.settings.timezone;
  const csrf = hidden(o.csrf, '/runs?tab=telegram');
  const rows = o.digests.map((d, i) => {
    const n = (() => { try { return JSON.parse(d.source_ids).length; } catch { return 0; } })();
    const canRegen = d.window_end >= o.lookbackFrom;
    const state = d.status === 'completed' ? (d.fallback ? '<span class="pill warn">AI 失败，按频道列出</span>' : '<span class="pill ok">已生成</span>')
      : '<span class="pill bad">生成失败</span>';
    return `<details${i === 0 ? ' open' : ''}><summary>${esc(local(d.window_end, tz))} · ${n} 个频道 · ${state}</summary>
      <div style="padding:4px 16px 14px">${d.status !== 'completed' ? `<p class="bad">${esc(d.error ?? '')}${d.next_attempt_at ? ` · ${esc(local(d.next_attempt_at, tz))} 自动重试` : ''}</p>` : ''}
      ${d.rendered_html ?? ''}
      ${canRegen ? `<form class="inline" method="post" action="/telegram/digests/regenerate">${csrf}<input type="hidden" name="window_end" value="${esc(d.window_end)}"><button>重新生成</button></form>` : ''}</div></details>`;
  }).join('');
  return `<p class="sub">每个时段所有频道的总结完成后，AI 把它们合并成一份要点清单，也就是“跨频道要点”RSS 的内容。重新生成会在 1 分钟内按当前的频道总结重做该时段，只支持最近 ${esc(Number(o.settings.raw_retention_days) + 1)} 天。</p>
    ${rows || '<p class="muted">还没有生成过要点汇总。</p>'}`;
}

/** 系统运行 · 图片识别。完成数按台北日期；新图片额度按 UTC 日期、重试不占额度（口径分开显示）。 */
export function telegramVisionSection(o: { csrf: string; settings: any; model: string;
  vision: { pending: number; failed: number; completedToday: number; quotaUsed: number; oldestMinutes: number | null; held?: number; evicted?: number } }): string {
  const s = o.settings; const v = o.vision; const limit = Number(s.vision_daily_limit) || 1;
  const csrf = hidden(o.csrf, '/system#vision');
  return `${s.vision_paused ? `<div class="err">识别已暂停：${esc(s.vision_pause_reason ?? '')}</div>
    <form class="inline" method="post" action="/telegram/vision/resume" style="margin-bottom:14px">${csrf}<button class="primary">凭证修复后恢复队列</button></form>` : ''}
  <div class="cards">
    <div class="card"><span class="l">状态</span><span class="n">${s.vision_paused ? '<span class="bad">已暂停</span>' : '运行中'}</span><span class="d">每分钟识别 1 张</span></div>
    <div class="card"><span class="l">待识别</span><span class="n">${v.pending.toLocaleString('en-US')} 张</span><span class="d">${v.pending ? `约 ${Math.max(1, Math.ceil(v.pending / Math.min(limit, 1440)))} 天处理完` : '没有积压'}</span></div>
    <div class="card"><span class="l">今日完成</span><span class="n">${v.completedToday.toLocaleString('en-US')} 张</span><span class="d">按台北日期统计</span></div>
    <div class="card"><span class="l">新图片额度</span><span class="n">${v.quotaUsed.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')}</span><span class="d">按 UTC 日期统计，重试不占额度 · <a href="/settings?tab=telegram#vision">调整每日上限</a></span></div>
    <div class="card"><span class="l">保留中</span><span class="n">${(v.held ?? 0).toLocaleString('en-US')} 张</span><span class="d">识别失败后保留 7 天，每 12 小时或换模型配置后自动重试</span></div>
    <div class="card"><span class="l">识别失败</span><span class="n">${v.failed.toLocaleString('en-US')} 张</span><span class="d">已放弃，图片已删除${v.evicted ? `（其中 ${v.evicted.toLocaleString('en-US')} 张因图片目录超过 1 GB 提前删除）` : ''}</span></div>
  </div>
  <p class="sub" style="margin-top:12px">模型 <code>${esc(o.model)}</code> · 最近运行 ${esc(ago(s.vision_last_run_at))}，结果 ${esc(s.vision_last_result || '—')}。识别完成后只保留文字结果，图片随即删除。</p>`;
}

/** 设置 · Telegram · 账号登录。 */
export function telegramLoginSection(o: { csrf: string; worker: any }): string {
  const w = o.worker ?? {};
  const csrf = hidden(o.csrf, '/settings?tab=telegram');
  return `<h2 id="login">Telegram 账号登录</h2>
  <p>状态：${esc(w.login_state)} · ${w.authorized ? '已授权' : '未授权'} ${w.account_hint ? `· ${esc(w.account_hint)}` : ''} · 上一轮同步完成于 ${esc(ago(w.heartbeat_at))}</p>
  <p class="sub">验证码和两步验证密码只通过本机 Unix Socket 传给采集器，不写入数据库或日志。</p>
  <div class="stack">
  <form class="inline" method="post" action="/telegram/login/start">${csrf}<button>开始登录 / 检查会话</button></form>
  <form class="inline" method="post" action="/telegram/login/code">${csrf}<input type="password" name="value" inputmode="numeric" autocomplete="one-time-code" placeholder="登录验证码" aria-label="登录验证码" required><button>提交验证码</button></form>
  <form class="inline" method="post" action="/telegram/login/password">${csrf}<input type="password" name="value" autocomplete="current-password" placeholder="两步验证密码" aria-label="两步验证密码" required><button>提交密码</button></form>
  </div>`;
}

/**
 * 设置 · Telegram：总结时段、提示词、图片识别每日上限。
 * 全局模型供应商开关打开时不显示模型字段（在「模型分配」里选）；关着时（新安装默认）仍可编辑旧的模型字段（§6）。
 * 表单带 model_mode：保存时与当前开关状态不一致（另一个窗口切换了开关）→ 409，不写入。
 */
export function renderTelegramSettings(o: { csrf: string; settings: any; managed?: boolean }): string {
  const s = o.settings;
  const csrf = `<input type="hidden" name="csrf" value="${esc(o.csrf)}">`;
  return `
  <h2 id="telegram">Telegram 总结</h2>
  <form method="post" action="/telegram/settings">${csrf}<input type="hidden" name="model_mode" value="${o.managed ? 'managed' : 'legacy'}"><table>
    <tr><td>业务时区</td><td><input name="timezone" value="${esc(s.timezone)}" aria-label="业务时区"></td></tr>
    <tr><td>总结时刻</td><td><input name="schedule" value="${esc(JSON.parse(s.schedule_json).join(', '))}" aria-label="总结时刻"><div class="muted">逗号分隔的 HH:MM，每个时刻生成一次各频道总结和跨频道要点</div></td></tr>
    ${o.managed ? '<tr><td>模型</td><td class="muted">在「设置 → 模型 → 模型分配」中选择</td></tr>' : `<tr><td>模型（旧配置）</td><td class="muted">全局模型供应商未启用时使用下面的设置；启用后在「设置 → 模型」中统一选择。</td></tr>
    <tr><td>供应商</td><td><select name="provider" aria-label="供应商">${['mock', 'openai', 'openai_compatible', 'deepseek', 'qwen', 'anthropic', 'gemini'].map(x => `<option${x === s.provider ? ' selected' : ''}>${x}</option>`).join('')}</select></td></tr>
    <tr><td>模型 / Base URL</td><td><input name="model" value="${esc(s.model)}" placeholder="模型 ID" aria-label="模型"> <input name="base_url" value="${esc(s.base_url || '')}" placeholder="Base URL" aria-label="Base URL" style="width:300px"></td></tr>
    <tr><td>密钥</td><td><select name="credential_ref" aria-label="密钥">${['OPENAI_COMPAT_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'].map(x => `<option${x === s.credential_ref ? ' selected' : ''}>${x}</option>`).join('')}</select></td></tr>`}
    <tr><td>额外关注点</td><td><textarea name="prompt_rules" rows="5" style="width:100%" aria-label="额外关注点">${esc(s.prompt_rules)}</textarea><div class="muted">只能补充关注点和输出要求；“只依据消息内容”“写出具体内容”“忽略群管理消息”等固定规则不可修改。</div></td></tr>
  </table><p><button class="primary">保存总结设置</button></p></form>

  <h2 id="vision">图片识别</h2>
  <form method="post" action="/telegram/vision/limit">${csrf}<table>
    <tr><td>模型</td><td>${o.managed ? '<span class="muted">在「设置 → 模型 → 模型分配」中选择</span>' : `<code>${esc(s.vision_model)}</code>`}</td></tr>
    <tr><td>每日上限</td><td><input name="limit" type="number" min="1" max="1440" value="${esc(s.vision_daily_limit)}" aria-label="每日上限" style="width:100px"> 张
      <div class="muted">识别器每分钟处理 1 张，所以每天最多 1,440 张。上限只限制新图片，积压的图片会顺延到第二天。</div></td></tr>
  </table><p><button class="primary">保存上限</button></p></form>`;
}

/** 设置 · 数据保留与备份：Telegram 数据保留。 */
export function renderTelegramRetention(o: { csrf: string; settings: any }): string {
  const s = o.settings;
  const csrf = `<input type="hidden" name="csrf" value="${esc(o.csrf)}">`;
  return `<h2 id="retention">Telegram 数据保留</h2>
  <form method="post" action="/telegram/retention">${csrf}<table>
    <tr><td>Telegram 消息</td><td><label><input type="checkbox" name="keep_forever" value="1"${s.keep_messages_forever ? ' checked' : ''}> 永久保留所有消息</label>
      <div class="muted">不勾选时，普通频道只保留最近 <input name="raw_retention_days" type="number" min="1" max="365" value="${esc(s.raw_retention_days)}" aria-label="消息保留天数" style="width:70px"> 天；标记“保留全部历史”的频道不受影响。</div></td></tr>
    <tr><td>总结与要点</td><td>保留 <input name="summary_retention_days" type="number" min="1" max="365" value="${esc(s.summary_retention_days)}" aria-label="总结保留天数" style="width:70px"> 天<div class="muted">到期后从 RSS 中移除</div></td></tr>
  </table><p><button class="primary">保存保留设置</button></p></form>`;
}
