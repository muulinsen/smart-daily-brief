// systemd unit 配置约束
// 这些不是代码逻辑，但配置错了会让整个系统静默失效 ——
// 今天的早报就是被 Conflicts= 杀掉的，日志里只有一行 SIGTERM。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadRules } from '../packages/domain/src/rules.ts';

const DIR = 'deploy/systemd';
let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const units = readdirSync(DIR);
const services = units.filter(f => f.endsWith('.service'));
const timers = units.filter(f => f.endsWith('.timer'));

console.log('长任务不得使用 Conflicts=（会被短任务杀掉）：\n');
{
  // brief-run 要跑几分钟；采集器每 20 分钟一轮。两者若互斥，
  // 采集器一启动就会 SIGTERM 掉简报运行 —— 实测每次开跑 8 秒即被杀。
  for (const f of services) {
    const s = read(f);
    const has = /^Conflicts=/m.test(s);
    ok(`${f.replace('.service', '')} 无 Conflicts`, !has,
       has ? s.match(/^Conflicts=.*/m)![0] : '');
  }
}

console.log('\n内存限额须容得下实际可能的并发组合：\n');
{
  const SYS_RESERVE = 200;      // 系统 + sshd + journald 约 200 MB
  const TOTAL = 896;            // 本机物理内存

  const high: Record<string, number> = {};
  for (const f of services) {
    const s = read(f);
    const h = s.match(/^MemoryHigh=(\d+)M/m), m = s.match(/^MemoryMax=(\d+)M/m);
    const name = f.replace('.service', '');
    ok(`${name} 声明了内存限额`, !!h && !!m, h && m ? `High=${h[1]} Max=${m[1]}` : '缺失');
    if (h) high[name] = Number(h[1]);
    if (h && m) ok(`  ${name} High < Max（前者限流、后者才杀）`, Number(h[1]) < Number(m[1]));
  }

  // 简单相加过于悲观：maintain 在凌晨 3:30、run 在 8/13/21，
  // 不可能全部同时达峰。真正的约束是「最大可能并发组合」——
  // 常驻的 web，加上同一时刻最多两个定时任务。
  const resident = high['brief-web'] ?? 0;
  const periodic = Object.entries(high).filter(([k]) => k !== 'brief-web')
    .map(([, v]) => v).sort((a, b) => b - a);
  const worst = resident + (periodic[0] ?? 0) + (periodic[1] ?? 0);
  ok('常驻 + 最大两个定时任务 + 系统开销 ≤ 物理内存',
     worst + SYS_RESERVE <= TOTAL,
     `${resident}(web) + ${periodic[0]} + ${periodic[1]} + ${SYS_RESERVE} = ${worst + SYS_RESERVE} / ${TOTAL}`);
}

console.log('\n发报时刻须与窗口配置一致：\n');
{
  const t = read('brief-run.timer');
  const hours = [...t.matchAll(/OnCalendar=\*-\*-\* (\d{2}):00:00 Asia\/Taipei/g)]
    .map(m => Number(m[1])).sort((a, b) => a - b);
  const rule = (loadRules().windows.schedule as Array<{ end_hour: number }>)
    .map(w => w.end_hour).sort((a, b) => a - b);
  ok('timer 时刻 = rules.yaml 的窗口结束时刻',
     JSON.stringify(hours) === JSON.stringify(rule), `timer[${hours}] rules[${rule}]`);
  ok('每日一个发报时刻（08:00）', hours.length === 1 && hours[0] === 8, String(hours));
}

console.log('\n沙箱与运行账户：\n');
{
  for (const f of services) {
    const s = read(f);
    const publisher = f === 'brief-subscriptions-sync.service';
    ok(`${f.replace('.service', '')} 使用预期账户`,
       publisher ? /^User=root$/m.test(s) : /^User=brief$/m.test(s));
    ok(`${f.replace('.service', '')} 启用 ProtectSystem=strict`, /^ProtectSystem=strict$/m.test(s));
    ok(`${f.replace('.service', '')} 写路径符合最小权限`, publisher
      ? !/^ReadWritePaths=/m.test(s)
      : /^ReadWritePaths=\/var\/lib\/briefing$/m.test(s));
    if (publisher) {
      ok('订阅发布器仅更新固定 GitHub 路径',
         /^Environment=PUBLIC_SUBSCRIPTIONS_GITHUB_PATH=SUBSCRIPTIONS\.md$/m.test(s));
      ok('订阅发布器不允许写本地文件系统', !/^ReadWritePaths=/m.test(s));
    }
  }
}

console.log('\n定时器完整性：\n');
{
  for (const f of timers) {
    const s = read(f);
    ok(`${f.replace('.timer', '')} 指定了 Unit=`, /^Unit=brief-/m.test(s));
    ok(`${f.replace('.timer', '')} 有 WantedBy=timers.target`, /WantedBy=timers\.target/.test(s));
  }
  const longRun = read('brief-run.service');
  ok('brief-run 超时足够长（真实模型调用慢）',
     Number(longRun.match(/^TimeoutStartSec=(\d+)/m)?.[1] ?? 0) >= 900,
     longRun.match(/^TimeoutStartSec=.*/m)?.[0] ?? '未设置');
  ok('brief-run 失败后自动重试', /^Restart=on-failure$/m.test(longRun));
  ok('brief-run 以定时触发身份运行（推迟发布的两小时截止只对定时运行生效）', /^ExecStart=\/usr\/bin\/node apps\/worker\/src\/run\.ts --trigger timer$/m.test(longRun));
  ok('brief-run 放弃发布（退出码 3）后不再重启', /^RestartPreventExitStatus=3$/m.test(longRun));
  ok('brief-run 超时覆盖两小时重试窗口', Number(longRun.match(/^TimeoutStartSec=(\d+)/m)?.[1] ?? 0) >= 9000);
  ok('brief-run 重试间隔不少于 5 分钟',
     /^RestartSec=(?:5min|300s)$/m.test(longRun),
     longRun.match(/^RestartSec=.*/m)?.[0] ?? '未设置');
  ok('brief-run 最多重试 3 次（首次 + 3 次）',
     /^StartLimitBurst=4$/m.test(longRun),
     longRun.match(/^StartLimitBurst=.*/m)?.[0] ?? '未设置');
  ok('brief-run 重试计数窗口覆盖最坏运行时长（每次最长 3 小时 × 4 次）',
     /^StartLimitIntervalSec=12h$/m.test(longRun),
     longRun.match(/^StartLimitIntervalSec=.*/m)?.[0] ?? '未设置');
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
