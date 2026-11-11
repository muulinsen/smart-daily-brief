// 加密密钥保管库（PRD 19.2）
import { rmSync, mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVault, saveVault, setSecret, setSettings, maskedSecrets,
         resolveSecret, resolveSettings, hydrateEnv, vaultHealthy, VaultLockedError }
  from '../packages/web/src/secrets.ts';

const dir = mkdtempSync(join(tmpdir(), 'brief-s-'));
const P = join(dir, 'secrets.enc');
let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };
const threw = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };

console.log('主密钥缺失时不可用（不静默降级）：\n');
{
  delete process.env.APP_ENCRYPTION_KEY;
  ok('无主密钥时 loadVault 抛错', threw(() => loadVault(P)));
  ok('抛的是 VaultLockedError', (() => { try { loadVault(P); } catch (e) { return e instanceof VaultLockedError; } return false; })());
  ok('健康检查报告未设置主密钥', !vaultHealthy(P).ok);
}

process.env.APP_ENCRYPTION_KEY = 'test-master-key-abcdefghijklmnop';

console.log('\n加解密往返：\n');
{
  ok('空保管库可读', JSON.stringify(loadVault(P)) === '{"secrets":{},"settings":{}}');
  setSecret('DEEPSEEK_API_KEY', 'sk-deepseek-abcdef123456', P);
  ok('写入后可读回', loadVault(P).secrets.DEEPSEEK_API_KEY === 'sk-deepseek-abcdef123456');
  setSecret('OPENAI_API_KEY', '  sk-openai-xyz789  ', P);
  ok('自动去除首尾空白', loadVault(P).secrets.OPENAI_API_KEY === 'sk-openai-xyz789');
  setSecret('OPENAI_API_KEY', '', P);
  ok('置空即删除', !('OPENAI_API_KEY' in loadVault(P).secrets));
  ok('其他密钥不受影响', loadVault(P).secrets.DEEPSEEK_API_KEY === 'sk-deepseek-abcdef123456');
}

console.log('\n落盘安全：\n');
{
  const raw = readFileSync(P, 'utf8');
  ok('文件中不含明文密钥', !raw.includes('sk-deepseek'), raw.slice(0, 40) + '…');
  ok('文件为 JSON 密文信封（v/iv/tag/ct）',
     ['v','iv','tag','ct'].every(k => k in JSON.parse(raw)));
  ok('文件权限 0600', (statSync(P).mode & 0o777) === 0o600,
     '0' + (statSync(P).mode & 0o777).toString(8));
}

console.log('\n完整性与错误主密钥：\n');
{
  process.env.APP_ENCRYPTION_KEY = 'wrong-master-key';
  ok('主密钥不对时解密失败而非返回空保管库', threw(() => loadVault(P)));
  ok('健康检查如实报告失败', !vaultHealthy(P).ok, vaultHealthy(P).reason?.slice(0, 30));
  process.env.APP_ENCRYPTION_KEY = 'test-master-key-abcdefghijklmnop';
  ok('主密钥恢复后可正常解开', loadVault(P).secrets.DEEPSEEK_API_KEY === 'sk-deepseek-abcdef123456');

  const blob = JSON.parse(readFileSync(P, 'utf8'));
  const bad = Buffer.from(blob.ct, 'base64'); bad[0] ^= 0xff;
  writeFileSync(P + '.bad', JSON.stringify({ ...blob, ct: bad.toString('base64') }));
  ok('密文被篡改时 GCM 校验拦下', threw(() => loadVault(P + '.bad')));
}

console.log('\n展示脱敏（PRD 16.2）：\n');
{
  const m = maskedSecrets(P);
  const ds = m.find(x => x.name === 'DEEPSEEK_API_KEY')!;
  ok('已设置的标记为 set', ds.set);
  ok('只露末四位', ds.hint.endsWith('3456') && !ds.hint.includes('sk-deepseek'), ds.hint);
  ok('未设置的不给提示', m.find(x => x.name === 'GEMINI_API_KEY')!.hint === '');
}

console.log('\n环境变量优先于保管库：\n');
{
  ok('保管库值生效', resolveSecret('DEEPSEEK_API_KEY', P) === 'sk-deepseek-abcdef123456');
  process.env.DEEPSEEK_API_KEY = 'sk-from-env';
  ok('env 覆盖保管库', resolveSecret('DEEPSEEK_API_KEY', P) === 'sk-from-env');
  delete process.env.DEEPSEEK_API_KEY;

  setSettings({ aiProvider: 'deepseek', l1Model: 'cheap-1',
    l1BaseUrl: 'https://custom.example/v1', l2BaseUrl: '' }, P);
  ok('设置项可读回', resolveSettings(P).aiProvider === 'deepseek');
  ok('自定义 Base URL 可保存并读回', resolveSettings(P).l1BaseUrl === 'https://custom.example/v1');
  ok('Base URL 留空会清除覆盖并回到厂商默认', resolveSettings(P).l2BaseUrl === undefined);
  process.env.AI_PROVIDER = 'openai';
  ok('env 同样覆盖设置项', resolveSettings(P).aiProvider === 'openai');
  delete process.env.AI_PROVIDER;
}

console.log('\n注入 process.env：\n');
{
  delete process.env.DEEPSEEK_API_KEY; delete process.env.AI_PROVIDER;
  const r = hydrateEnv(P);
  ok('密钥与设置均已注入', process.env.DEEPSEEK_API_KEY === 'sk-deepseek-abcdef123456'
     && process.env.AI_PROVIDER === 'deepseek', r.loaded.join(','));
  process.env.AI_L1_MODEL = 'preset';
  hydrateEnv(P);
  ok('不覆盖已存在的 env', process.env.AI_L1_MODEL === 'preset');

  process.env.APP_ENCRYPTION_KEY = 'wrong';
  const bad = hydrateEnv(P);
  ok('保管库不可用时返回错误而非崩溃', bad.loaded.length === 0 && !!bad.error);
  process.env.APP_ENCRYPTION_KEY = 'test-master-key-abcdefghijklmnop';
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
