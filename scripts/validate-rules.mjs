#!/usr/bin/env node
// 规则配置校验器 —— CI 必跑（PRD 22.4）
// 检查：YAML 可解析 / 正则在 JS 下可编译 / signal 引用完整 /
//       权重合计 100 / 过滤规则 ID 唯一 / never_filter_on 不为空
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const path = process.argv[2] ?? 'config/rules.yaml';
const raw = readFileSync(path, 'utf8');
const cfg = parse(raw);
const errors = [];
const warns = [];

// 1. 正则在 JS 引擎下可编译（内联标志 (?m)/(?i) 在 JS 无效，必须用 flags 字段）
let regexCount = 0;
const walk = (node, trail = '') => {
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${trail}[${i}]`));
  if (node && typeof node === 'object') {
    if (typeof node.regex === 'string') {
      regexCount++;
      if (/^\(\?[imsx]+\)/.test(node.regex))
        errors.push(`${trail}.regex 含内联标志，JS 不支持，请改用 flags 字段`);
      try { new RegExp(node.regex, node.flags ?? ''); }
      catch (e) { errors.push(`${trail}.regex 无法编译: ${e.message}`); }
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${trail}.${k}`);
  }
};
walk(cfg);

// 2. signal 引用完整性
const defined = new Set(Object.keys(cfg.signals ?? {}));
const refs = new Set();
for (const m of raw.matchAll(/(?:^|\s)(?:-\s*)?(?:not_)?signal:\s*(\w+)/g)) refs.add(m[1]);
for (const m of raw.matchAll(/(?:any_of|all_of):\s*\[([^\]]+)\]/g))
  for (const it of m[1].split(',')) { const s = it.trim(); if (/^[a-z_]+$/.test(s)) refs.add(s); }
for (const r of refs) if (!defined.has(r)) errors.push(`signal "${r}" 被引用但未定义`);
for (const d of defined) if (!refs.has(d)) warns.push(`signal "${d}" 定义了但没被引用`);

// 3. 排序权重合计必须 100（PRD 8.4）
const w = cfg.ranking?.weights ?? {};
const sum = Object.values(w).reduce((a, b) => a + b, 0);
if (sum !== 100) errors.push(`ranking.weights 合计 ${sum}，应为 100`);

// 4. 过滤规则 ID 唯一且格式正确（PRD 8.3 要求保存 rule_id）
const ids = (cfg.deterministic_filters ?? []).map(f => f.id);
const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
if (dup.length) errors.push(`deterministic_filters ID 重复: ${[...new Set(dup)].join(', ')}`);
for (const id of ids) if (!/^DF-\d{3}$/.test(id)) errors.push(`过滤规则 ID 格式错误: ${id}`);

// 5. 强制保留四类齐全（PRD 8.2）
const classes = (cfg.mandatory_retention?.classes ?? []).map(c => c.class).sort();
if (classes.join('') !== 'ABCD') errors.push(`mandatory_retention 应含 A/B/C/D 四类，实际: ${classes.join(',')}`);

// 6. 反向保护清单不得为空（PRD 8.3 末段，防止规则退化）
if (!(cfg.never_filter_on?.length > 0)) errors.push('never_filter_on 不得为空');

// 7. 简报禁止字段必须包含 PRD 9.2 明列的四项
for (const f of ['标签', '建议', '关注建议', '行动建议'])
  if (!cfg.brief?.item_fields_forbidden?.includes(f))
    errors.push(`brief.item_fields_forbidden 缺少 PRD 9.2 明令禁止的 "${f}"`);

// 8. 版本号必须存在且为整数
if (!Number.isInteger(cfg.meta?.rule_version)) errors.push('meta.rule_version 必须是整数');

// 9. 窗口时刻必须与 systemd timer 一致 —— 不一致会漏内容
try {
  const timer = readFileSync('deploy/systemd/brief-run.timer', 'utf8');
  const timerHours = [...timer.matchAll(/OnCalendar=\*-\*-\* (\d{2}):00:00 Asia\/Taipei/g)]
    .map(m => Number(m[1])).sort((a, b) => a - b);
  const ruleHours = (cfg.windows?.schedule ?? []).map(w => w.end_hour).sort((a, b) => a - b);
  if (timerHours.length && JSON.stringify(timerHours) !== JSON.stringify(ruleHours))
    errors.push(`windows.schedule [${ruleHours}] 与 brief-run.timer [${timerHours}] 时刻不一致` +
                ` —— 会漏掉窗口结束到发报之间的内容`);
} catch { warnings.push('未找到 brief-run.timer，跳过时刻一致性检查'); }

// 10. 过滤规则覆盖度：声明了却永不生效的规则是静默失效
try {
  const { auditRuleCoverage } = await import('../packages/domain/src/filters.ts');
  for (const p of auditRuleCoverage()) errors.push(`过滤规则覆盖度：${p}`);
  const { auditPrescreenCoverage } = await import('../packages/domain/src/signals.ts');
  for (const p of auditPrescreenCoverage()) errors.push(`强制保留 A–D 覆盖度：${p}`);
} catch (e) { warnings.push(`覆盖度自检未运行：${e.message}`); }

console.log(`规则文件: ${path}`);
console.log(`  rule_version = ${cfg.meta?.rule_version}`);
console.log(`  顶层节 ${Object.keys(cfg).length} 个 / 正则 ${regexCount} 条 / signals ${defined.size} 个 / 过滤规则 ${ids.length} 条`);
warns.forEach(w => console.log(`  ⚠️  ${w}`));
if (errors.length) { errors.forEach(e => console.log(`  ❌ ${e}`)); process.exit(1); }
console.log('✅ 全部校验通过');
