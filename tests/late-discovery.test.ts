// 三窗口复查补录（PRD 6.2 / 23.2 / 24.1-P0）
// PRD 23.2 要求：「模拟一个条目先不在 feed、下一窗口才出现，验证补录与原窗口」
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, nowIso } from '../packages/db/src/index.ts';
import { windowFromKey, previousWindows } from '../packages/domain/src/normalize.ts';
import { findLateDiscoveries } from '../packages/db/src/queries.ts';

const dir = mkdtempSync(join(tmpdir(), 'brief-test-'));
const db = openDb(join(dir, 't.db'));
migrate(db, './migrations');

const now = nowIso();
db.prepare(`INSERT INTO sources (id,name,display_name,category,host_group,harvest_tier,
  config_json,source_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)`)
  .run('s1', 'S1', 'S1', 'forum', 'direct', 'standard', '{}', now, now);

const cur = windowFromKey('2026-08-23:daily');         // 台北前日 08:00 → 当日 08:00
const prev = previousWindows(cur, 3);
const originWin = prev[0]!;                            // 2026-08-22:daily

// 系统在原窗口结束前确实采集过该来源（迁移截止点的前提）
const watchedAt = new Date(originWin.end.getTime() - 3600e3).toISOString();
const hrId = Number(db.prepare(
  `INSERT INTO harvest_runs (started_at,status,tiers_json) VALUES (?,'succeeded','[]')`)
  .run(watchedAt).lastInsertRowid);
db.prepare(`INSERT INTO fetch_attempts (harvest_run_id,source_id,endpoint_priority,url,
  started_at,outcome) VALUES (?,?,1,?,?,'ok')`).run(hrId, 's1', 'https://x/', watchedAt);

let n = 0;
function addItem(key: string, publishedAt: string, firstSeenAt: string) {
  const id = Number(db.prepare(`INSERT INTO feed_items (source_id,source_item_key,key_kind,
    canonical_url,published_at,timestamp_confidence,first_seen_at,last_seen_at,created_at)
    VALUES (?,?,'topic_id',?,?,'exact',?,?,?)`)
    .run('s1', key, `https://x/${key}`, publishedAt, firstSeenAt, firstSeenAt, firstSeenAt).lastInsertRowid);
  const vid = Number(db.prepare(`INSERT INTO item_versions (item_id,content_hash,raw_hash,title,
    clean_text,is_excerpt,discovered_at,version_no) VALUES (?,?,?,?,?,0,?,1)`)
    .run(id, `h${++n}`, `r${n}`, `标题 ${key}`, '正文'.repeat(60), firstSeenAt).lastInsertRowid);
  db.prepare('UPDATE feed_items SET current_version_id=? WHERE id=?').run(vid, id);
  return { id, vid };
}

const inWin = new Date(originWin.start.getTime() + 3600e3).toISOString();  // 原窗口内发布

// 甲：原窗口内发布，原窗口结束「之后」才首次出现 → 应判为补录
addItem('late-1', inWin, new Date(originWin.end.getTime() + 1800e3).toISOString());
// 乙：原窗口内发布，原窗口结束「之前」就已见 → 正常，不是补录
addItem('normal-1', inWin, new Date(originWin.end.getTime() - 1800e3).toISOString());
// 丙：边界 —— 首见恰好等于窗口结束时刻（右开区间，应判为补录）
addItem('boundary', inWin, originWin.end.toISOString());
// 丁：已发送过的延迟条目 → 不得重复补录
const sent = addItem('already-sent', inWin, new Date(originWin.end.getTime() + 1800e3).toISOString());

let fail = 0;
const expect = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(46)} ${JSON.stringify(got)}${ok ? '' : ` 期望 ${JSON.stringify(want)}`}`);
};

console.log('三窗口复查补录（PRD 6.2 / 23.2）：\n');
let r = findLateDiscoveries(db, prev);
expect('补录条数', r.late.length, 3);
expect('甲 late-1 被识别', r.late.some(x => x.source_id === 's1' && x.title.includes('late-1')), true);
expect('乙 normal-1 未被误判', r.late.some(x => x.title.includes('normal-1')), false);
expect('丙 边界（首见=窗口结束）计入补录', r.late.some(x => x.title.includes('boundary')), true);
expect('原窗口归属正确', r.late.find(x => x.title.includes('late-1'))?.origin.key, originWin.key);

// 把「丁」标记为已发送，应从补录中排除（PRD 6.2 条件 4）
const cl = Number(db.prepare(`INSERT INTO story_clusters (cluster_key,canonical_title,
  current_version_hash,created_at,updated_at) VALUES ('c1','t','v',?,?)`).run(now, now).lastInsertRowid);
db.prepare(`INSERT INTO cluster_members (cluster_id,item_version_id,created_at) VALUES (?,?,?)`)
  .run(cl, sent.vid, now);
const runId = Number(db.prepare(`INSERT INTO runs (window_key,window_label,window_start_at,
  window_end_at,scheduled_at,status,trigger) VALUES ('2026-08-22:daily','日报',?,?,?,'succeeded','timer')`)
  .run(originWin.start.toISOString(), originWin.end.toISOString(), now).lastInsertRowid);
const bId = Number(db.prepare(`INSERT INTO briefs (run_id,version,subject,text_body,html_body,
  html_bytes,status,rule_version,created_at) VALUES (?,1,'s','t','h',1,'final',1,?)`).run(runId, now).lastInsertRowid);
db.prepare(`INSERT INTO brief_items (brief_id,story_cluster_id,version_hash,section,order_no,
  status,title,conclusion,summary_json,source_name,source_url)
  VALUES (?,?,'v','ai_tech',1,'included','t','c','[]','S1','https://x/')`).run(bId, cl);

console.log('\n已发送条目不得重复补录（PRD 6.2 条件 4）：\n');
r = findLateDiscoveries(db, prev);
expect('补录条数降为', r.late.length, 2);
expect('已发送的 already-sent 被排除', r.late.some(x => x.title.includes('already-sent')), false);

console.log('\n迁移截止点：窗口结束前未采集该来源则不算补录：\n');
db.prepare('DELETE FROM fetch_attempts').run();
r = findLateDiscoveries(db, prev);
expect('补录条数', r.late.length, 0);
expect('改计为上线前存量', r.backfill, 2);

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
