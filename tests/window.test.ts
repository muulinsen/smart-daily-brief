// 固定窗口边界（PRD 5.1 / 23.1 / 24.1-P0）
// 2026-10-22 起每日一期：前一天 08:00 → 当天 08:00（Asia/Taipei = 北京时间），严格左闭右开。
// 窗口时刻来自 rules.yaml windows.schedule —— 改配置后本测试必须同步更新。
import { windowOf, windowFromKey, previousWindows, windowToReport } from '../packages/domain/src/normalize.ts';
import { loadRules } from '../packages/domain/src/rules.ts';

const tp = (s: string) => new Date(`${s}+08:00`);
let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

const sch = loadRules().windows.schedule as Array<{ id: string; label: string; end_hour: number }>;
ok('只有一个每日窗口，08:00 截止', sch.length === 1 && sch[0]!.id === 'daily' && sch[0]!.end_hour === 8, JSON.stringify(sch));

const w = windowFromKey('2026-08-23:daily');
ok('窗口为前一天 08:00 → 当天 08:00', w.start.getTime() === tp('2026-08-22T08:00:00').getTime() && w.end.getTime() === tp('2026-08-23T08:00:00').getTime());
ok('窗口 24 小时', w.end.getTime() - w.start.getTime() === 24 * 3600e3);
ok('标签为日报', w.label === '日报');

ok('07:59:59 属于当天窗口', windowOf(tp('2026-08-23T07:59:59')).key === '2026-08-23:daily');
ok('08:00:00 属于次日窗口（左闭右开）', windowOf(tp('2026-08-23T08:00:00')).key === '2026-08-24:daily');
ok('UTC 输入一致', windowOf(new Date('2026-08-23T00:00:00Z')).key === '2026-08-24:daily');

ok('08:00 发报 → 刚结束的当天窗口', windowToReport(tp('2026-08-23T08:00:00')).key === '2026-08-23:daily');
ok('08:02 发报（随机延迟）仍为当天窗口', windowToReport(tp('2026-08-23T08:02:00')).key === '2026-08-23:daily');
ok('中途运行取上一个完整窗口', windowToReport(tp('2026-08-23T15:00:00')).key === '2026-08-23:daily');

const prev = previousWindows(windowFromKey('2026-08-23:daily'), 3);
ok('前三个窗口为前三天', prev.map(p => p.key).join(' ') === '2026-08-22:daily 2026-08-21:daily 2026-08-20:daily', prev.map(p => p.key).join(' '));
ok('相邻窗口首尾相接', prev[0]!.end.getTime() === windowFromKey('2026-08-23:daily').start.getTime());

ok('跨年：2026-01-01 窗口起点在 2025-12-31', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(windowFromKey('2026-01-01:daily').start) === '2025-12-31');
const bad = (k: string) => { try { windowFromKey(k); return false; } catch { return true; } };
ok('旧窗口 id（noon）被拒', bad('2026-08-23:noon'));
ok('非法日期被拒', bad('not-a-date:daily'));

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
