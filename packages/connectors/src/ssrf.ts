import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF 防护（PRD 4.4 / 19.2）。
 *
 * 后台的「测试抓取」让用户指定 URL 由服务器发起请求 —— 这是典型的
 * SSRF 攻击面：攻击者可用它探测内网、读取云厂商元数据服务
 * （169.254.169.254 上有实例凭证）、或访问只监听 127.0.0.1 的后台自身。
 *
 * 三层防护：
 *  1. 协议白名单：只允许 https（http 明文也拒绝）
 *  2. 主机名黑名单：localhost、.local、.internal 等
 *  3. DNS 解析后逐个 IP 校验 —— 这一层不可省：攻击者可以让
 *     evil.com 解析到 127.0.0.1，仅看主机名字符串完全拦不住。
 */

/** kind：blocked = 地址或协议被拒（不重试）；dns = 解析失败 / 无地址（临时故障）；timeout = 截止时间耗尽（临时故障）。 */
export type UrlCheck = { ok: true; url: string; addresses: string[] }
                    | { ok: false; reason: string; kind: 'blocked' | 'dns' | 'timeout' };
const blocked = (reason: string): UrlCheck => ({ ok: false, reason, kind: 'blocked' });

const BLOCKED_HOSTNAMES = [
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata', 'metadata.google.internal', 'instance-data',
];
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa', '.onion'];

/** 把 IPv6 地址展开成 8 个 16 位整数（支持 :: 缩写、末尾点分 IPv4、% 区域标识）。格式不对返回 null。 */
export function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[2]!.split('.').map(Number);
    if (p.some(x => x > 255)) return null;
    s = `${dotted[1]}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x: string) => x ? x.split(':') : [];
  const head = part(halves[0]!), tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (all.length !== 8 || all.some(x => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map(x => parseInt(x, 16));
}

/** 判断一个 IP 是否属于必须拒绝的范围。 */
export function isBlockedAddress(ip: string): string | null {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    const [a, b] = [p[0]!, p[1]!];
    if (a === 0) return '「本网络」保留地址';
    if (a === 10) return '私有网段 10.0.0.0/8';
    if (a === 127) return '环回地址 127.0.0.0/8';
    if (a === 100 && b >= 64 && b <= 127) return '运营商级 NAT 100.64.0.0/10';
    if (a === 169 && b === 254) return '链路本地/云元数据 169.254.0.0/16';
    if (a === 172 && b >= 16 && b <= 31) return '私有网段 172.16.0.0/12';
    if (a === 192 && b === 168) return '私有网段 192.168.0.0/16';
    const c = p[2]!;
    if (a === 192 && b === 0 && c === 0) return '保留网段 192.0.0.0/24';
    if (a === 192 && b === 0 && c === 2) return '文档网段 192.0.2.0/24';
    // 198.18.0.0/15（基准测试）默认拦截；开 fake-ip 代理的开发机显式设置 SSRF_ALLOW_FAKE_IP=1 才放行（生产不设置）
    if (a === 198 && (b === 18 || b === 19) && process.env.SSRF_ALLOW_FAKE_IP !== '1') return '基准测试网段 198.18.0.0/15';
    if (a === 198 && b === 51 && c === 100) return '文档网段 198.51.100.0/24';
    if (a === 203 && b === 0 && c === 113) return '文档网段 203.0.113.0/24';
    if (a >= 224) return '组播/保留地址';
    return null;
  }
  if (v === 6) {
    // 按 16 位分段展开后按前缀判断（字符串前缀判断会漏掉 fe90::、::ffff:7f00:1 这类写法）
    const w = expandIPv6(ip);
    if (!w) return '无法识别的 IP 格式';
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    if (w.every(x => x === 0)) return 'IPv6 未指定地址';
    if (w.slice(0, 7).every(x => x === 0) && w[7] === 1) return 'IPv6 环回地址';
    if ((w[0]! & 0xffc0) === 0xfe80) return 'IPv6 链路本地 fe80::/10';
    if ((w[0]! & 0xffc0) === 0xfec0) return 'IPv6 站点本地 fec0::/10';
    if ((w[0]! & 0xfe00) === 0xfc00) return 'IPv6 唯一本地地址 fc00::/7';
    if ((w[0]! & 0xff00) === 0xff00) return 'IPv6 组播';
    if (w[0] === 0x100 && w.slice(1, 4).every(x => x === 0)) return 'IPv6 丢弃前缀 100::/64';
    if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return 'IPv6 本地翻译前缀 64:ff9b:1::/48';
    if (w[0] === 0x2001 && w[1] === 0xdb8) return 'IPv6 文档前缀 2001:db8::/32';
    // 内嵌 IPv4 的形式都要解开再判：映射 ::ffff:0:0/96、兼容 ::/96、NAT64 64:ff9b::/96、6to4 2002::/16
    if (w.slice(0, 5).every(x => x === 0) && (w[5] === 0xffff || w[5] === 0)) return isBlockedAddress(v4(w[6]!, w[7]!));
    if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every(x => x === 0)) return isBlockedAddress(v4(w[6]!, w[7]!));
    if (w[0] === 0x2002) return isBlockedAddress(v4(w[1]!, w[2]!));
    return null;
  }
  return '无法识别的 IP 格式';
}

/**
 * 校验 URL 是否可安全抓取。会真正做 DNS 解析。
 *
 * 注意：这里存在理论上的 TOCTOU（校验后 DNS 可能变化）。
 * 完全防御需要在建立连接时锁定 IP，代价较大；对本系统
 * （单用户、后台只监听本机、来源由所有者自己添加）这层足够。
 * 真正的定时抓取只走 sources.yaml 里已固化的端点，不受此影响。
 */
export type LookupFn = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: LookupFn = host => lookup(host, { all: true });
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED']);

/**
 * opts.deadline：整次请求的截止时刻（ms 时间戳）。DNS 解析不支持取消，超过截止时间就丢弃结果按 dns 失败返回，调用方不再出站。
 * opts.lookup：测试注入。
 */
export async function checkUrlSafe(raw: string, opts: { deadline?: number; lookup?: LookupFn } = {}): Promise<UrlCheck> {
  let u: URL;
  try { u = new URL(String(raw).trim()); }
  catch { return blocked('URL 格式非法'); }

  if (u.protocol !== 'https:')
    return blocked(`只允许 https，实际为 ${u.protocol.replace(':', '') || '（空）'}`);
  if (u.username || u.password)
    return blocked('URL 不得内嵌用户名或口令');

  // 末尾的点（foo.internal.）与不带点等价，比对黑名单前去掉
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (BLOCKED_HOSTNAMES.includes(host))
    return blocked(`主机名 ${host} 在黑名单中`);
  if (BLOCKED_SUFFIXES.some(sfx => host.endsWith(sfx)))
    return blocked(`主机名后缀不允许（${host}）`);

  // 直接写 IP 的情况
  if (isIP(host)) {
    const bad = isBlockedAddress(host);
    if (bad) return blocked(`目标地址不允许：${bad}`);
    return { ok: true, url: u.toString(), addresses: [host] };
  }

  // 域名：必须解析后逐个 IP 校验 —— 只看名字拦不住 DNS 指向内网
  let addrs: Array<{ address: string }>;
  const left = opts.deadline === undefined ? Infinity : opts.deadline - Date.now();
  if (left <= 0) return { ok: false, reason: '请求超时', kind: 'timeout' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const q = (opts.lookup ?? defaultLookup)(host);
    addrs = Number.isFinite(left)
      ? await Promise.race([q, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { deadline: true })), left); })])
      : await q;
  } catch (e: any) {
    if (e?.deadline) return { ok: false, reason: '请求超时', kind: 'timeout' };
    const code = typeof e?.code === 'string' && DNS_CODES.has(e.code) ? e.code : 'other';
    return { ok: false, reason: `DNS 解析失败（${code}）`, kind: 'dns' };
  } finally { clearTimeout(timer); }
  if (opts.deadline !== undefined && Date.now() >= opts.deadline) return { ok: false, reason: '请求超时', kind: 'timeout' };
  if (!addrs.length) return { ok: false, reason: 'DNS 未返回任何地址', kind: 'dns' };

  for (const a of addrs) {
    const bad = isBlockedAddress(a.address);
    if (bad) return blocked(`${host} 解析到 ${a.address}（${bad}）`);
  }
  return { ok: true, url: u.toString(), addresses: addrs.map(a => a.address) };
}
