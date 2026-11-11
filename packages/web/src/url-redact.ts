/**
 * 后台页面上回填与展示网址时的脱敏（第一期第 5 轮审查）。库里保存的仍是原值；统一的网址脱敏另立任务。
 * 路径片段按解码后的值判断；解析或解码失败一律当作敏感（不回填、只显示占位）。
 */
const SENSITIVE_PARAM = /^(?:access_?token|api_?key|auth|authorization|key|password|secret|signature|sig|token)$/i;

/** 像令牌的路径片段：32 位以上十六进制，或 24 位以上同时含字母与数字的随机串。 */
export const tokenLikeSegment = (seg: string): boolean =>
  /^[a-f0-9]{32,}$/i.test(seg) || (/^[A-Za-z0-9_-]{24,}$/.test(seg) && /[A-Za-z]/.test(seg) && /\d/.test(seg));

const decoded = (seg: string): string | null => { try { return decodeURIComponent(seg); } catch { return null; } };
const secretSegment = (seg: string): boolean => { const d = decoded(seg); return d === null || tokenLikeSegment(d); };

/** 表单回填用：带用户名口令、认证参数、像令牌的路径片段，或无法解析的地址 → 空串。 */
export function safeFormUrl(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  let u: URL;
  try { u = new URL(v); } catch { return ''; }
  if (u.username || u.password || [...u.searchParams.keys()].some(k => SENSITIVE_PARAM.test(k))) return '';
  if (u.pathname.split('/').some(secretSegment)) return '';
  return v.slice(0, 500);
}

/** 页面展示用：只留协议、主机、路径；像令牌的片段显示为 …，有查询参数显示 ?…；无法解析显示占位。 */
export function displayUrl(raw: unknown): string {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { return '（无法解析的地址）'; }
  const path = u.pathname.split('/').map(seg => secretSegment(seg) ? '…' : seg).join('/');
  return `${u.protocol}//${u.host}${path}${u.search ? '?…' : ''}`;
}
