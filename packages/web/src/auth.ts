import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';

/**
 * 单用户认证原语（PRD 14.2 / 19.2）。
 *
 * 全部基于 node:crypto，不引入 argon2/otplib 等原生依赖 ——
 * 896 MB 机器上少一个编译依赖就少一份风险，且这里的安全需求
 * （单用户、后台只监听 127.0.0.1、前置 Caddy）用 scrypt + TOTP 足够。
 */

// ---------- 口令 ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const actual = scryptSync(pw.normalize('NFKC'), salt, expected.length,
    { N: +N, r: +r, p: +p });
  // 长度不同时 timingSafeEqual 会抛错，先比长度
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- TOTP（RFC 6238，SHA-1 / 6 位 / 30 秒） ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpAt(secret: string, counter: number): string {
  const key = b32decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1]! & 0x0f;
  const code = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * 校验 TOTP。window=1 允许前后各一个 30 秒步长，容忍时钟漂移。
 * 用常数时间比较，避免通过响应时间逐位猜码。
 */
export function verifyTotp(secret: string, token: string, window = 1, now = Date.now()): boolean {
  const t = String(token).replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return false;
  const counter = Math.floor(now / 1000 / 30);
  let hit = false;
  for (let i = -window; i <= window; i++) {
    const expect = totpAt(secret, counter + i);
    // 不提前 break —— 保持比较次数恒定
    if (timingSafeEqual(Buffer.from(expect), Buffer.from(t))) hit = true;
  }
  return hit;
}

export function totpUri(secret: string, account: string, issuer = '十六源简报'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
         `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------- 会话与 CSRF ----------

export type Session = { id: string; createdAt: number; lastSeen: number; csrf: string };

export class SessionStore {
  #s = new Map<string, Session>();
  #ttlMs: number;
  constructor(ttlHours = 12) { this.#ttlMs = ttlHours * 3600e3; }

  create(): Session {
    const s: Session = {
      id: randomBytes(32).toString('base64url'),
      csrf: randomBytes(32).toString('base64url'),
      createdAt: Date.now(), lastSeen: Date.now(),
    };
    this.#s.set(s.id, s);
    return s;
  }
  get(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.#s.get(id);
    if (!s) return null;
    if (Date.now() - s.lastSeen > this.#ttlMs) { this.#s.delete(id); return null; }
    s.lastSeen = Date.now();
    return s;
  }
  destroy(id: string | undefined): void { if (id) this.#s.delete(id); }
  get size(): number { return this.#s.size; }
  sweep(): void {
    const cut = Date.now() - this.#ttlMs;
    for (const [k, v] of this.#s) if (v.lastSeen < cut) this.#s.delete(k);
  }
}

/** 常数时间比较 CSRF token。 */
export function csrfOk(session: Session | null, token: unknown): boolean {
  if (!session || typeof token !== 'string' || token.length !== session.csrf.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf));
}

// ---------- 登录限流（PRD 19.2） ----------

export class LoginLimiter {
  #hits = new Map<string, number[]>();
  max: number;
  windowMs: number;
  constructor(max = 5, windowMs = 15 * 60e3) { this.max = max; this.windowMs = windowMs; }

  /** 用 IP 的哈希做键，避免把明文 IP 长期留在内存里。 */
  #key(ip: string) { return createHash('sha256').update(ip).digest('hex').slice(0, 16); }

  check(ip: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const k = this.#key(ip);
    const arr = (this.#hits.get(k) ?? []).filter(t => now - t < this.windowMs);
    this.#hits.set(k, arr);
    if (arr.length < this.max) return { allowed: true, retryAfterSec: 0 };
    return { allowed: false, retryAfterSec: Math.ceil((this.windowMs - (now - arr[0]!)) / 1000) };
  }
  fail(ip: string, now = Date.now()): void {
    const k = this.#key(ip);
    this.#hits.set(k, [...(this.#hits.get(k) ?? []).filter(t => now - t < this.windowMs), now]);
  }
  reset(ip: string): void { this.#hits.delete(this.#key(ip)); }
}
