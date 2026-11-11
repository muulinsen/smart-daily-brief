// 认证原语（PRD 14.2 / 19.2）
import { hashPassword, verifyPassword, generateTotpSecret, totpAt, verifyTotp, totpUri,
         SessionStore, csrfOk, LoginLimiter } from '../packages/web/src/auth.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

console.log('口令散列：\n');
{
  const h = hashPassword('correct horse battery staple');
  ok('正确口令通过', verifyPassword('correct horse battery staple', h));
  ok('错误口令拒绝', !verifyPassword('wrong', h));
  ok('相同口令产生不同散列（随机盐）', hashPassword('x') !== hashPassword('x'));
  ok('散列中不含明文', !h.includes('correct'));
  ok('格式被篡改时安全失败', !verifyPassword('x', 'garbage'));
  ok('Unicode 正规化一致', verifyPassword('café', hashPassword('café')));
}

console.log('\nTOTP（RFC 6238）：\n');
{
  const s = generateTotpSecret();
  ok('密钥为 Base32', /^[A-Z2-7]+$/.test(s) && s.length >= 32, s.slice(0, 12) + '…');
  const now = Date.now();
  const code = totpAt(s, Math.floor(now / 1000 / 30));
  ok('当前码通过', verifyTotp(s, code, 1, now));
  ok('前一步长的码通过（容忍时钟漂移）',
     verifyTotp(s, totpAt(s, Math.floor(now/1000/30) - 1), 1, now));
  ok('超出窗口的码拒绝',
     !verifyTotp(s, totpAt(s, Math.floor(now/1000/30) - 5), 1, now));
  ok('错误码拒绝', !verifyTotp(s, '000000', 1, now) || code === '000000');
  ok('非 6 位数字拒绝', !verifyTotp(s, 'abcdef') && !verifyTotp(s, '12345'));
  ok('不同密钥产生不同码', totpAt(s, 1) !== totpAt(generateTotpSecret(), 1));
  ok('otpauth URI 可用于扫码', totpUri(s, 'me@x.com').startsWith('otpauth://totp/'));
}

console.log('\n会话与 CSRF：\n');
{
  const st = new SessionStore(12);
  const s = st.create();
  ok('会话 ID 与 CSRF token 相互独立', s.id !== s.csrf && s.id.length >= 40);
  ok('可按 ID 取回', st.get(s.id)?.id === s.id);
  ok('未知 ID 返回 null', st.get('nope') === null);
  ok('undefined 安全处理', st.get(undefined) === null);
  ok('CSRF 正确 token 通过', csrfOk(s, s.csrf));
  ok('CSRF 错误 token 拒绝', !csrfOk(s, 'x'.repeat(s.csrf.length)));
  ok('CSRF 缺失拒绝', !csrfOk(s, undefined) && !csrfOk(null, s.csrf));
  st.destroy(s.id);
  ok('登出后会话失效', st.get(s.id) === null);
}
{
  const st = new SessionStore(0);   // 立即过期
  const s = st.create();
  s.lastSeen = Date.now() - 1000;
  ok('过期会话被拒绝并清除', st.get(s.id) === null && st.size === 0);
}

console.log('\n登录限流（PRD 19.2）：\n');
{
  const l = new LoginLimiter(5, 15 * 60e3);
  const ip = '203.0.113.7';
  for (let i = 0; i < 5; i++) {
    ok(`第 ${i+1} 次尝试允许`, l.check(ip).allowed);
    l.fail(ip);
  }
  const blocked = l.check(ip);
  ok('第 6 次被锁定', !blocked.allowed);
  ok('给出重试等待秒数', blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 900,
     blocked.retryAfterSec + 's');
  ok('其他 IP 不受影响', l.check('198.51.100.1').allowed);
  l.reset(ip);
  ok('登录成功后重置', l.check(ip).allowed);
}
{
  const l = new LoginLimiter(2, 1000);
  const ip = '203.0.113.9';
  l.fail(ip, 0); l.fail(ip, 0);
  ok('窗口内锁定', !l.check(ip, 500).allowed);
  ok('窗口过后自动解锁', l.check(ip, 2000).allowed);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
