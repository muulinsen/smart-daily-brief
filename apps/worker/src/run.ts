#!/usr/bin/env node
import { candidateEligibleSql } from '../../../packages/db/src/eligibility.ts';
/**
 * 完整简报运行（PRD 12.1 端到端时序）。
 *
 *   node apps/worker/src/run.ts                自动窗口，按配置投递
 *   node apps/worker/src/run.ts --window K     指定窗口
 *   node apps/worker/src/run.ts --no-send      只生成不投递
 *   node apps/worker/src/run.ts --shadow       影子投递
 *   node apps/worker/src/run.ts --trigger timer  定时触发（systemd）；默认 manual
 *
 * 新流程（brief.semantic_dedup.enabled）：简报组装返回 75 表示有未判定条目、本期推迟发布。
 * 定时触发时按固定时刻表（基准 + 15、30…分钟）重试，基准 = max(窗口结束, 首次定时尝试)，
 * 两小时截止后停止调用、本期不发布并以退出码 3 结束（systemd 不再重启）。手动触发只尝试一次。
 *
 * 依次执行：候选构建 → L1 判定 → L2/L3 复核 → 简报组装与投递。
 * 每一步都是独立可重入的 CLI，这里只负责串联与失败处理 ——
 * 任一步失败不吞掉错误，运行进入 partial 并保留已完成的成果
 * （PRD 12.2：任一来源失败但仍可生成简报时状态为 partial）。
 */
import { spawn } from 'node:child_process';
import { openDb, nowIso, type DB } from '../../../packages/db/src/index.ts';
import { windowToReport, windowFromKey } from '../../../packages/domain/src/normalize.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import { firstTimerAttemptAt, getRetryState, hasRunStateTables, nextSlot, setRetryState } from '../../../packages/db/src/runstate.ts';

const EXIT_WAITING_AI = 75, EXIT_LEASE_BUSY = 76, EXIT_GAVE_UP = 3;
const RETRY_WINDOW_MS = 2 * 3600e3;

const argv = process.argv.slice(2);
const winArg = argv.includes('--window') ? argv[argv.indexOf('--window') + 1] : null;
const passThrough = argv.filter(a => ['--no-send', '--shadow', '--regenerate'].includes(a));
const triggerRaw = argv.includes('--trigger') ? argv[argv.indexOf('--trigger') + 1] : 'manual';
if (triggerRaw !== 'timer' && triggerRaw !== 'manual') throw new Error('--trigger 仅接受 timer 或 manual');
const TRIGGER: 'timer' | 'manual' = triggerRaw;

const win = winArg && winArg !== 'auto' ? windowFromKey(winArg) : windowToReport();
const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');

/** 跑一个子步骤，实时透传输出。返回退出码。 */
function step(name: string, script: string, args: string[]): Promise<number> {
  return new Promise(resolve => {
    console.log(`\n${'─'.repeat(58)}\n▶ ${name}\n${'─'.repeat(58)}`);
    const p = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    p.on('close', code => resolve(code ?? 1));
    p.on('error', e => { console.error(`  启动失败: ${e.message}`); resolve(1); });
  });
}

const t0 = Date.now();
console.log(`简报运行 ${win.key} ${win.label}  [${win.start.toISOString()} → ${win.end.toISOString()})`);

// 1. 候选构建（含三窗口复查补录）
let code = await step('候选构建', 'apps/worker/src/candidates.ts', ['--window', win.key]);
if (code !== 0) {
  console.error('\n❌ 候选构建失败，中止 —— 后续步骤没有输入');
  markRun('failed', '候选构建失败');
  db.close(); process.exit(1);
}

const runRow = db.prepare('SELECT id FROM runs WHERE window_key=?').get(win.key) as any;
if (!runRow) { console.error('未找到运行记录'); db.close(); process.exit(1); }
const runId = runRow.id;
const nCand = (db.prepare(`SELECT count(*) c FROM candidates c WHERE ${candidateEligibleSql()} AND run_id=?`).get(runId) as any).c;

if (!nCand) {
  console.log('\n本窗口没有候选，不生成简报。');
  markRun('succeeded', null, 'composing');
  db.close(); process.exit(0);
}

const failures: string[] = [];
// 新版日报（digest_v2）直接读取来源条目，不使用 L1/L2/L3 判定结果；跳过以免 24 小时窗口的
// 大批候选拖慢运行（改回 legacy 自动恢复）。
const DIGEST_V2 = (loadRules() as any).brief?.format === 'digest_v2';
if (DIGEST_V2) console.log('\nbrief.format=digest_v2：跳过 L1 判定与 L2/L3 复核');
// 2. L1 判定
if (!DIGEST_V2) {
code = await step('L1 判定', 'apps/worker/src/triage.ts', ['--run', String(runId)]);
if (code !== 0) failures.push('L1 判定');

// 3. L2/L3 复核。单轮额度是保护供应商的“批次上限”，不是允许遗漏的
// 发布上限；若仍有 escalate，自动续跑下一批。连续无进展时停止，交给
// 完整性门禁阻断发送，避免无限循环和残缺简报。
const unresolvedCount = () => Number((db.prepare(`SELECT count(*) c FROM candidates c
  WHERE ${candidateEligibleSql()} AND run_id=? AND (decision IS NULL OR decision='escalate')`).get(runId) as any).c);
const maxReviewPasses = 8;
let previousUnresolved = unresolvedCount();
for (let pass = 1; previousUnresolved > 0 && pass <= maxReviewPasses; pass++) {
  code = await step(`L2/L3 复核${pass > 1 ? `（续跑 ${pass}）` : ''}`,
    'apps/worker/src/review.ts', ['--run', String(runId)]);
  if (code !== 0) { failures.push('L2/L3 复核'); break; }
  const remaining = unresolvedCount();
  console.log(`复核进度：${previousUnresolved} → ${remaining} 条待处理`);
  if (remaining === 0) break;
  if (remaining >= previousUnresolved) {
    console.error(`复核无进展（仍有 ${remaining} 条），停止自动续跑并由完整性门禁阻断发送`);
    failures.push('L2/L3 复核无进展');
    break;
  }
  previousUnresolved = remaining;
}
if (unresolvedCount() > 0 && !failures.some(x => x.startsWith('L2/L3')))
  failures.push('L2/L3 复核未完成');
}

// 4. 简报组装与投递
if (DIGEST_V2 && (loadRules() as any).brief?.semantic_dedup?.enabled) {
  const exit = await semanticLoop();
  db.close(); process.exit(exit);
}
code = await step('简报组装与投递', 'apps/worker/src/brief.ts', ['--run', String(runId), ...passThrough]);
if (code !== 0) failures.push('简报组装');

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n${'═'.repeat(58)}`);
if (failures.length) {
  console.log(`⚠️  运行完成但有失败步骤：${failures.join('、')}  （耗时 ${secs}s）`);
  markRun('partial', failures.join('、'));
} else {
  console.log(`✅ 运行完成  （耗时 ${secs}s）`);
  markRun('succeeded', null);
}

function markRun(status: string, error: string | null, stage = 'sending') {
  db.prepare(`UPDATE runs SET status=?, stage=?, finished_at=?, error=? WHERE window_key=?`)
    .run(status, stage, nowIso(), error, win.key);
  db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at)
    VALUES ('run',?,?,?,?)`)
    .run(win.key, `run_${status}`, JSON.stringify({ error, seconds: Number(secsSafe()) }), nowIso());
}
function secsSafe() { return ((Date.now() - t0) / 1000).toFixed(0); }

/** 新流程：推迟发布的重试循环。状态（waiting_ai / failed）由简报步骤与这里写入，不经过通用 markRun。 */
async function semanticLoop(): Promise<number> {
  if (!hasRunStateTables(db)) { console.error('❌ 缺少迁移 018 的运行状态表，请先运行 npm run migrate'); return 1; }
  const hasFinal = () => !!db.prepare(`SELECT 1 FROM briefs WHERE run_id=? AND status='final'`).get(runId);
  const timer = TRIGGER === 'timer';
  const first = firstTimerAttemptAt(db, runId);
  const base = Math.max(win.end.getTime(), first ? Date.parse(first) : Date.now());
  const deadline = base + RETRY_WINDOW_MS;
  if (timer) setRetryState(db, runId, { deadline_at: new Date(deadline).toISOString() });
  for (;;) {
    if (hasFinal() && !passThrough.includes('--regenerate')) {
      // 可能由另一尝试（手动重跑）发布；只补投递，不改状态
      return await step('简报组装与投递', 'apps/worker/src/brief.ts', ['--run', String(runId), ...passThrough, '--trigger', TRIGGER]);
    }
    if (timer && Date.now() >= deadline) return giveUp();
    const args = ['--run', String(runId), ...passThrough, '--trigger', TRIGGER, ...(timer ? ['--deadline', new Date(deadline).toISOString()] : [])];
    const c = await step('简报组装与投递', 'apps/worker/src/brief.ts', args);
    if (c === 0) return 0;
    if (c === EXIT_LEASE_BUSY && !timer) { console.log('定时尝试正在进行，手动重跑未执行'); return 0; }
    // 定时尝试撞上手动重跑：结果未知，按时刻表继续检查（已发布则在循环顶部结束）
    if (c !== EXIT_WAITING_AI && c !== EXIT_LEASE_BUSY) {
      if (!hasFinal()) markRun('partial', '简报组装失败');
      return 2;
    }
    if (!timer) {
      db.prepare(`UPDATE runs SET status='failed', finished_at=? WHERE id=?`).run(nowIso(), runId);
      console.log('手动重跑仍有未判定条目，本期未发布（手动重跑只尝试一次）');
      return EXIT_GAVE_UP;
    }
    const next = nextSlot(base, Date.now());
    if (next >= deadline) {
      setRetryState(db, runId, { next_attempt_at: null });
      await new Promise(r => setTimeout(r, Math.max(0, deadline - Date.now())));
      return giveUp();
    }
    setRetryState(db, runId, { next_attempt_at: new Date(next).toISOString() });
    console.log(`⏸ 等待 AI 恢复：${new Date(next).toISOString()} 重试（截止 ${new Date(deadline).toISOString()}）`);
    await new Promise(r => setTimeout(r, Math.max(0, next - Date.now())));
  }

  function giveUp(): number {
    // 等待期间可能已由手动重跑发布：不得把已发布的期次改成失败
    if (hasFinal()) { console.log('本期已由另一尝试发布，不再标记失败'); return 0; }
    const st = getRetryState(db, runId);
    const msg = `AI 判定连续失败超过 2 小时，本期未发布：未判定 ${st?.unresolved ?? '?'} 条，最后错误类型 ${st?.last_error_kind ?? '未知'}`;
    const changed = db.prepare(`UPDATE runs SET status='failed', stage='composing', finished_at=?, error=? WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM briefs WHERE run_id=? AND status='final')`).run(nowIso(), msg, runId, runId).changes;
    if (!changed) { console.log('本期已由另一尝试发布，不再标记失败'); return 0; }
    setRetryState(db, runId, { next_attempt_at: null });
    db.prepare(`INSERT INTO audit_events (run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,'run',?,'run_ai_gave_up',?,?)`)
      .run(runId, win.key, JSON.stringify({ unresolved: st?.unresolved ?? null, errorKind: st?.last_error_kind ?? null }), nowIso());
    console.error(`❌ ${msg}`);
    return EXIT_GAVE_UP;
  }
}

db.close();
process.exit(failures.length ? 2 : 0);
