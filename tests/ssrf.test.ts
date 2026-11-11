// SSRF 防护（PRD 4.4 / 19.2）
import { checkUrlSafe, isBlockedAddress } from '../packages/connectors/src/ssrf.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

console.log('IP 范围判定：\n');
{
  const blocked = ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255',
                   '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1',
                   '::1', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1',
                   // 十六进制写法的映射地址、fe80::/10 整段、兼容 / NAT64 / 6to4 内嵌的 IPv4
                   '::ffff:7f00:1', '::ffff:a00:1', 'fe90::1', 'febf::1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '[::1]', 'fe80::1%eth0',
                   // 特殊用途：192.0.0.0/24、文档网段、IPv6 丢弃 / 本地翻译 / 文档前缀
                   '192.0.0.8', '192.0.2.1', '198.51.100.7', '203.0.113.9', '100::1', '64:ff9b:1::1', '2001:db8::1'];
  for (const ip of blocked) ok(`拒绝 ${ip}`, !!isBlockedAddress(ip), isBlockedAddress(ip) ?? '');
  const allowed = ['1.1.1.1', '8.8.8.8', '172.32.0.1', '192.0.78.24', '192.1.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2002:808:808::', '2606:4700::1111'];
  for (const ip of allowed) ok(`放行 ${ip}`, isBlockedAddress(ip) === null);
}

console.log('\n云元数据服务（最危险的目标）：\n');
{
  const r = await checkUrlSafe('https://169.254.169.254/latest/meta-data/iam/security-credentials/');
  ok('AWS/Azure 元数据地址被拒', !r.ok, r.ok ? '' : r.reason);
}

console.log('\n协议与凭证：\n');
{
  for (const [u, why] of [
    ['http://example.com', 'http 明文'],
    ['file:///etc/passwd', 'file 协议'],
    ['gopher://evil.com', 'gopher 协议'],
    ['ftp://example.com', 'ftp 协议'],
    ['not a url', '格式非法'],
    ['https://user:pass@example.com', '内嵌凭证'],
  ] as const) {
    const r = await checkUrlSafe(u);
    ok(`拒绝 ${why}`, !r.ok, r.ok ? '' : r.reason);
  }
}

console.log('\n主机名黑名单：\n');
{
  for (const h of ['https://localhost/x', 'https://metadata.google.internal/x',
                   'https://foo.local/x', 'https://bar.internal/x']) {
    const r = await checkUrlSafe(h);
    ok(`拒绝 ${h.slice(8, 34)}`, !r.ok, r.ok ? '' : r.reason);
  }
}

console.log('\n直写内网 IP：\n');
{
  for (const u of ['https://127.0.0.1:3000/api/v1/dashboard',
                   'https://192.168.1.1/admin',
                   'https://[::1]:3000/']) {
    const r = await checkUrlSafe(u);
    ok(`拒绝 ${u.slice(8, 32)}`, !r.ok, r.ok ? '' : r.reason);
  }
}

console.log('\n正常来源应放行：\n');
{
  // 注入公网解析结果：不依赖本机 DNS（开 fake-ip 代理的环境会解析到 198.18.x）
  for (const u of ['https://linux.do/latest.rss',
                   'https://elsewhere.news/feed.xml',
                   'https://api-docs.deepseek.com/zh-cn/updates/']) {
    const r = await checkUrlSafe(u, { lookup: async () => [{ address: '104.20.16.234' }, { address: '2606:4700::6810:10ea' }] });
    ok(`放行 ${u.slice(8, 40)}`, r.ok, r.ok ? r.addresses.join(',') : r.reason);
  }
}

console.log('\nDNS 指向内网的域名（只看名字拦不住）：\n');
{
  // 注入解析结果：不依赖本机 DNS（代理软件的 fake-ip 模式会把所有域名解析到 198.18.x）
  const to = (...ips: string[]) => async () => ips.map(address => ({ address }));
  const r = await checkUrlSafe('https://localtest.me/', { lookup: to('127.0.0.1') });
  ok('解析到 127.0.0.1 的域名被拒', !r.ok && r.kind === 'blocked', r.ok ? '⚠️ 未拦下' : r.reason);
  const mixed = await checkUrlSafe('https://mixed.example/', { lookup: to('8.8.8.8', '10.0.0.5') });
  ok('公网与内网混合解析也被拒', !mixed.ok && mixed.kind === 'blocked');
  const fine = await checkUrlSafe('https://wp.example/feed', { lookup: to('192.0.78.24') });
  ok('192.0.78.x（WordPress.com）放行', fine.ok);
  const fake = await checkUrlSafe('https://proxy.example/feed', { lookup: to('198.18.0.38') });
  ok('198.18.0.0/15 默认拦截', !fake.ok && fake.kind === 'blocked');
  process.env.SSRF_ALLOW_FAKE_IP = '1';
  const fakeOk = await checkUrlSafe('https://proxy.example/feed', { lookup: to('198.18.0.38') });
  delete process.env.SSRF_ALLOW_FAKE_IP;
  ok('SSRF_ALLOW_FAKE_IP=1 时放行（开 fake-ip 代理的开发机）', fakeOk.ok);
}

console.log('\n失败类型与截止时间：\n');
{
  const nx = await checkUrlSafe('https://nx.example/', { lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND nx.example 内部细节'), { code: 'ENOTFOUND' }); } });
  ok('DNS 失败 → dns 类，文案只含白名单错误码', !nx.ok && nx.kind === 'dns' && nx.reason === 'DNS 解析失败（ENOTFOUND）', nx.ok ? '' : nx.reason);
  const empty = await checkUrlSafe('https://e.example/', { lookup: async () => [] });
  ok('无地址 → dns 类', !empty.ok && empty.kind === 'dns');
  const t0 = Date.now();
  const slow = await checkUrlSafe('https://slow.example/', { deadline: Date.now() + 50, lookup: () => new Promise(r => setTimeout(() => r([{ address: '8.8.8.8' }]), 400)) });
  ok('DNS 慢于截止时间 → timeout，不等解析返回', !slow.ok && slow.kind === 'timeout' && Date.now() - t0 < 300, `${Date.now() - t0}ms`);
  const past = await checkUrlSafe('https://late.example/', { deadline: Date.now() - 1, lookup: async () => [{ address: '8.8.8.8' }] });
  ok('截止时间已过 → timeout，不解析', !past.ok && past.kind === 'timeout');
  const bl = await checkUrlSafe('http://example.com');
  ok('协议被拒 → blocked 类', !bl.ok && bl.kind === 'blocked');
  for (const h of ['foo.internal.', 'localhost.', 'x.local..'])
    { const r = await checkUrlSafe(`https://${h}/`); ok(`末尾带点不能绕过黑名单：${h}`, !r.ok && r.kind === 'blocked', r.ok ? '' : r.reason); }
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
