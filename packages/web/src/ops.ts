/**
 * 后台的「运行状况」：定时任务、备份、磁盘，以及由它们推导出的待处理事项。
 *
 * 2026-10 的几起故障（Telegram 来源被自动停用 10 天、维护任务超时导致备份停摆、图片识别暂停、
 * 早报被完整性门禁拦下）后台都没有任何提示，只能翻日志。这里把这些信号集中算出来，
 * 今日页和侧栏计数都从同一份结果取。读取系统状态的函数只读、带超时，失败时返回空结果而不是抛错。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export type UnitStatus = {
  id: string; label: string; kind: 'oneshot' | 'daemon';
  active: string; result: string; startedAt: number | null; exitedAt: number | null; nextAt: number | null;
  /** 间隔型定时器（OnUnitActiveSec）没有绝对的下次时间，用说明文字代替 */
  every?: string;
};

const UNITS: Array<[string, string, UnitStatus['kind'], string?]> = [
  ['brief-run', '完整日报运行', 'oneshot'],
  ['brief-harvest', 'RSS 采集', 'oneshot'],
  ['brief-fulltext', '原帖全文抓取', 'oneshot'],
  ['brief-telegram-collector', 'Telegram 采集', 'daemon'],
  ['brief-telegram-summary', 'Telegram 总结与汇总', 'oneshot'],
  ['brief-telegram-vision', 'Telegram 图片识别', 'oneshot'],
  ['brief-maintain', '维护与备份', 'oneshot'],
  ['brief-subscriptions-sync', '订阅清单同步', 'oneshot', '每 5 分钟'],
  ['brief-requests', '后台操作（重新运行 / 重新发送）', 'oneshot', '有请求时执行'],
];

/** systemd 249 不支持 --timestamp=unix，用 --timestamp=utc：「Sat 2026-10-10 00:00:10 UTC」。 */
const ts = (v: string | undefined): number | null => {
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC/.exec(String(v ?? ''));
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : null;
};

/** 一次 systemctl show 读出所有服务与定时器；systemd 不可用时返回空数组。 */
export function readUnits(run: (args: string[]) => string = args =>
  execFileSync('systemctl', args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })): UnitStatus[] {
  const ids = UNITS.flatMap(([id, , kind]) => kind === 'oneshot' ? [`${id}.service`, `${id}.timer`] : [`${id}.service`]);
  let out: string;
  try {
    out = run(['show', '--timestamp=utc', '-p', 'Id,ActiveState,Result,ExecMainStartTimestamp,ExecMainExitTimestamp,ActiveEnterTimestamp,NextElapseUSecRealtime', ...ids]);
  } catch { return []; }
  const blocks = new Map<string, Record<string, string>>();
  for (const block of out.split(/\n\s*\n/)) {
    const kv = Object.fromEntries(block.split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    if (kv.Id) blocks.set(kv.Id, kv);
  }
  return UNITS.map(([id, label, kind, every]) => {
    const svc = blocks.get(`${id}.service`) ?? {}; const timer = blocks.get(`${id}.timer`) ?? {};
    return { id, label, kind, active: svc.ActiveState ?? 'unknown', result: svc.Result ?? 'unknown',
      startedAt: ts(kind === 'daemon' ? svc.ActiveEnterTimestamp : svc.ExecMainStartTimestamp),
      exitedAt: ts(svc.ExecMainExitTimestamp), nextAt: ts(timer.NextElapseUSecRealtime), ...(every ? { every } : {}) };
  });
}

export type DiskStatus = { totalBytes: number; usedBytes: number; freeBytes: number } | null;
export function readDisk(path = '/'): DiskStatus {
  try {
    const s = statfsSync(path);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { totalBytes: total, usedBytes: total - s.bfree * s.bsize, freeBytes: free };
  } catch { return null; }
}

export type BackupStatus = { name: string; label: string; file: string | null; bytes: number; mtime: number | null };
export function readBackups(dir: string): BackupStatus[] {
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { /* 目录不可读：按无备份处理 */ }
  return [['brief', '日报数据库'], ['telegram', 'Telegram 数据库']].map(([name, label]) => {
    const latest = files.filter(f => new RegExp(`^${name}-\\d{4}-\\d{2}-\\d{2}\\.db\\.gz$`).test(f)).sort().pop() ?? null;
    if (!latest) return { name: name!, label: label!, file: null, bytes: 0, mtime: null };
    try { const st = statSync(join(dir, latest)); return { name: name!, label: label!, file: latest, bytes: st.size, mtime: st.mtimeMs }; }
    catch { return { name: name!, label: label!, file: latest, bytes: 0, mtime: null }; }
  });
}

export type Alert = { level: 'bad' | 'warn'; area: 'today' | 'telegram' | 'system' | 'sources'; title: string; detail: string; href: string };

export type AlertInput = {
  now: number;
  units: UnitStatus[];
  runs: Array<{ window_key: string; window_label: string; scheduled_at: string; status: string; error: string | null; finished_at: string | null;
    /** 新流程推迟发布状态（迁移 018 之后才有） */
    next_attempt_at?: string | null; unresolved?: number | null; last_error_kind?: string | null; refused_count?: number | null }>;
  sources: Array<{ id: string; display_name: string; health: string; enabled: number; consecutive_failures: number; host_group?: string }>;
  telegram: {
    authorized: boolean; heartbeatAt: string | null;
    sources: Array<{ name: string; status: string; enabled: number; last_error: string | null; last_success_at: string | null }>;
    visionPaused: boolean; visionPauseReason: string | null; visionBacklog: number; visionDailyLimit: number;
    failedSummaries: number;
  };
  backups: BackupStatus[];
  /** 后台的备份开关；缺省视为全部开启 */
  backupSettings?: { local: boolean; gdrive: boolean };
  gdrive?: { state: 'OK' | 'FAIL' | 'SKIP' | 'UNKNOWN'; at: number | null; detail: string };
  disk: DiskStatus;
};

const H = 3600_000;
const hm = (ms: number) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * 合并时段卡片补出的告警（漏运行、已定稿未投递）。brief-run 在建运行记录前就失败时，
 * computeAlerts 会给出「日报运行失败」，时段卡片又会给出「没有运行」：同一次故障合成一条，保留失败详情。
 */
export function mergeSlotAlerts(alerts: Alert[], slot: Alert[]): Alert[] {
  if (!slot.length) return [...alerts];
  const i = alerts.findIndex(a => a.area === 'today' && a.title === '日报运行失败');
  if (i < 0) return [...alerts, ...slot];
  const unit = alerts[i]!;
  const merged = slot.map((a, k) => k === 0 ? { ...a, level: 'bad' as const, detail: `${a.detail}；日报任务${unit.detail}` } : a);
  return [...alerts.slice(0, i), ...alerts.slice(i + 1), ...merged];
}

/** 由运行状况推导待处理事项；纯函数，便于测试。故障（bad）排在留意（warn）之前。 */
export function computeAlerts(i: AlertInput): Alert[] {
  const out: Alert[] = [];
  // 日报：最近 24 小时内每个应运行的时段都必须成功；运行中的不算
  for (const r of i.runs) {
    const at = Date.parse(r.scheduled_at);
    if (i.now - at > 24 * H) continue;
    if (r.status === 'partial' || r.status === 'failed')
      out.push({ level: 'bad', area: 'today', title: `${r.window_label}未完成（${r.window_key.slice(5, 10)}）`,
        detail: (r.error ?? '运行未成功').slice(0, 160), href: '/runs?status=failed' });
    else if (r.status === 'waiting_ai')
      out.push({ level: 'warn', area: 'today', title: `${r.window_label}等待 AI 恢复后发布（${r.window_key.slice(5, 10)}）`,
        detail: `未判定 ${r.unresolved ?? '?'} 条，最后错误类型 ${r.last_error_kind ?? '未知'}${r.next_attempt_at ? `，下次重试 ${hm(Date.parse(r.next_attempt_at))}` : ''}`,
        href: '/runs?status=failed' });
    if (r.refused_count)
      out.push({ level: 'warn', area: 'today', title: `${r.window_label}有 ${r.refused_count} 条被模型拒绝处理、按排除计`,
        detail: '内容触发了模型的内容安全限制，已在运行详情中列出', href: '/runs' });
  }
  const run = i.units.find(u => u.id === 'brief-run');
  for (const u of i.units) {
    if (u.id === 'brief-run' || u.active === 'activating' || u.active === 'unknown') continue;
    if (u.kind === 'daemon' && u.active !== 'active')
      out.push({ level: 'bad', area: 'system', title: `${u.label}没有在运行`, detail: `服务状态：${u.active}`, href: '/system' });
    else if (u.kind === 'oneshot' && u.result !== 'success' && u.result !== 'unknown')
      out.push({ level: 'bad', area: 'system', title: `${u.label}上次运行失败`,
        detail: `结果：${u.result}${u.exitedAt ? ` · ${hm(u.exitedAt)}` : ''}`, href: '/system' });
  }
  if (run && run.result !== 'success' && run.result !== 'unknown' && run.active !== 'activating' &&
      !out.some(a => a.area === 'today'))
    out.push({ level: 'bad', area: 'today', title: '日报运行失败', detail: `结果：${run.result}`, href: '/runs?status=failed' });

  // Telegram
  const t = i.telegram;
  if (!t.authorized) out.push({ level: 'bad', area: 'telegram', title: 'Telegram 账号未登录', detail: '采集已停止，请在设置 → Telegram 重新登录', href: '/settings?tab=telegram' });
  // 采集器每轮同步完所有来源才写一次心跳，一轮约 15 分钟、轮间隔 5 分钟；
  // 所以活跃度取「心跳或任一来源同步」中最新的一个，30 分钟没有任何进展才算停摆。
  else if (!t.heartbeatAt || i.now - Date.parse(t.heartbeatAt) > 30 * 60_000)
    out.push({ level: 'bad', area: 'telegram', title: 'Telegram 采集器 30 分钟没有进展',
      detail: t.heartbeatAt ? `最后活动 ${hm(Date.parse(t.heartbeatAt))}` : '从未上报', href: '/settings?tab=telegram' });
  const broken = t.sources.filter(s => s.status === 'error');
  if (broken.length)
    out.push({ level: broken.length > 2 ? 'bad' : 'warn', area: 'telegram', title: `${broken.length} 个 Telegram 来源出错`,
      detail: broken.slice(0, 3).map(s => `${s.name}：${(s.last_error ?? '').slice(0, 40)}`).join('；'), href: '/subscriptions?tab=telegram' });
  const stale = t.sources.filter(s => s.enabled && s.status === 'active' &&
    (!s.last_success_at || i.now - Date.parse(s.last_success_at) > H));
  if (t.authorized && stale.length)
    out.push({ level: 'bad', area: 'telegram', title: `${stale.length} 个 Telegram 来源超过 1 小时没有同步`,
      detail: stale.slice(0, 4).map(s => s.name).join('、'), href: '/subscriptions?tab=telegram' });
  if (t.visionPaused)
    out.push({ level: 'bad', area: 'telegram', title: '图片识别已暂停', detail: t.visionPauseReason ?? '队列已暂停', href: '/system#vision' });
  else if (t.visionBacklog > t.visionDailyLimit)
    out.push({ level: 'warn', area: 'telegram', title: `图片识别积压 ${t.visionBacklog.toLocaleString('en-US')} 张`,
      detail: `每日上限 ${t.visionDailyLimit.toLocaleString('en-US')} 张，约 ${Math.ceil(t.visionBacklog / t.visionDailyLimit)} 天处理完`, href: '/system#vision' });
  if (t.failedSummaries)
    out.push({ level: 'warn', area: 'telegram', title: `${t.failedSummaries} 个频道总结生成失败`, detail: '已用完重试次数，在订阅源 → Telegram 的对应行查看', href: '/subscriptions?tab=telegram' });

  // RSS 与 X 来源分开告警，各自链接到订阅源的对应区域（X = host_group github_x_rss）
  const failing = i.sources.filter(s => s.enabled && s.health === 'failing');
  for (const [label, tab, xs] of [['RSS', 'rss', failing.filter(s => s.host_group !== 'github_x_rss')],
                                 ['X', 'x', failing.filter(s => s.host_group === 'github_x_rss')]] as const)
    if (xs.length) out.push({ level: 'warn', area: 'sources', title: `${xs.length} 个 ${label} 来源连续失败`,
      detail: xs.slice(0, 4).map(s => `${s.display_name}（${s.consecutive_failures} 次）`).join('、'), href: `/subscriptions?tab=${tab}` });

  // 备份与磁盘（关闭的备份不再报「没有新备份」，两个都关闭时提醒一次）
  const cfg = i.backupSettings ?? { local: true, gdrive: true };
  if (!cfg.local && !cfg.gdrive)
    out.push({ level: 'warn', area: 'system', title: '数据库备份已全部关闭', detail: '本机备份与 Google Drive 备份都已在后台关闭，出故障时将无法恢复数据', href: '/settings?tab=data' });
  if (cfg.gdrive && i.gdrive) {
    if (i.gdrive.state === 'FAIL')
      out.push({ level: 'bad', area: 'system', title: 'Google Drive 备份失败', detail: `${i.gdrive.at ? hm(i.gdrive.at) : ''} ${i.gdrive.detail}`.trim(), href: '/system#backups' });
    else if (i.gdrive.state === 'UNKNOWN' && !cfg.local)
      out.push({ level: 'warn', area: 'system', title: 'Google Drive 备份没有可核实的记录', detail: `本机备份已关闭，而 Google Drive 备份状态无法确认：${i.gdrive.detail}`, href: '/system#backups' });
    else if (i.gdrive.state !== 'UNKNOWN' && (!i.gdrive.at || i.now - i.gdrive.at > 36 * H))
      out.push({ level: 'warn', area: 'system', title: 'Google Drive 超过 36 小时没有成功备份', detail: i.gdrive.at ? `最近记录：${hm(i.gdrive.at)}（${i.gdrive.state}）` : '没有备份记录', href: '/system#backups' });
  }
  for (const b of cfg.local ? i.backups : []) {
    if (!b.mtime || i.now - b.mtime > 36 * H)
      out.push({ level: 'bad', area: 'system', title: `${b.label}超过 36 小时没有新备份`,
        detail: b.mtime ? `最近一份：${hm(b.mtime)}` : '备份目录里没有找到备份', href: '/system#backups' });
  }
  if (i.disk) {
    const pct = i.disk.usedBytes / i.disk.totalBytes;
    if (pct >= 0.85) out.push({ level: pct >= 0.95 ? 'bad' : 'warn', area: 'system', title: `磁盘已用 ${Math.round(pct * 100)}%`,
      detail: `剩余 ${(i.disk.freeBytes / 2 ** 30).toFixed(1)} GB`, href: '/system' });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}
