/**
 * 后台发起的耗时操作（重新运行某个时段、重新发送某期日报）不在 Web 进程里执行：
 * Web 进程内存上限 200M，且没有权限启动 systemd 服务。这里只把请求写成文件，
 * brief-requests.path 监听到目录非空后，以 brief 身份启动 brief-requests.service 逐个执行。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { windowFromKey } from '../../domain/src/normalize.ts';

export type AdminRequest =
  | { type: 'rerun'; window: string; requestedAt: string }
  | { type: 'resend'; briefId: number; requestedAt: string };

const WINDOW_KEY = /^\d{4}-\d{2}-\d{2}:[a-z_]{1,20}$/;
/** 窗口键按当前 rules.yaml 的窗口配置校验（生产现为 daily；旧版为 morning/noon/evening）。 */
function validWindow(key: string): boolean {
  if (!WINDOW_KEY.test(key)) return false;
  try { return windowFromKey(key).key === key; } catch { return false; }
}

/** 严格校验：请求文件来自同一用户可写的目录，执行前仍按白名单格式检查。 */
export function parseRequest(raw: unknown): AdminRequest | null {
  const r = raw as any;
  if (r?.type === 'rerun' && typeof r.window === 'string' && validWindow(r.window))
    return { type: 'rerun', window: r.window, requestedAt: String(r.requestedAt ?? '') };
  if (r?.type === 'resend' && Number.isInteger(r.briefId) && r.briefId > 0)
    return { type: 'resend', briefId: r.briefId, requestedAt: String(r.requestedAt ?? '') };
  return null;
}

export function queueRequest(dir: string, req: { type: 'rerun'; window: string } | { type: 'resend'; briefId: number }): AdminRequest {
  const full = parseRequest({ ...req, requestedAt: new Date().toISOString() });
  if (!full) throw new Error('请求格式无效');
  // 同一操作已在排队时不重复写入
  if (pendingRequests(dir).some(p => p.type === full.type &&
      (p.type === 'rerun' ? p.window === (full as any).window : p.briefId === (full as any).briefId))) return full;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${full.type}-${randomBytes(4).toString('hex')}.json`;
  // 先写临时名再改名：路径监听只会看到完整文件
  writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify(full), { mode: 0o600 });
  renameSync(join(dir, `.${name}.tmp`), join(dir, name));
  return full;
}

export function pendingRequests(dir: string): AdminRequest[] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
  return files.flatMap(f => {
    try { const r = parseRequest(JSON.parse(readFileSync(join(dir, f), 'utf8'))); return r ? [r] : []; } catch { return []; }
  });
}

/** 取出最早的一个请求（读取后即删除）；格式无效的文件直接丢弃。 */
export function takeRequest(dir: string): AdminRequest | 'invalid' | null {
  let files: string[] = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return null; }
  const f = files[0];
  if (!f) return null;
  let req: AdminRequest | null = null;
  try { req = parseRequest(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { /* 损坏的文件按无效处理 */ }
  unlinkSync(join(dir, f));
  return req ?? 'invalid';
}
