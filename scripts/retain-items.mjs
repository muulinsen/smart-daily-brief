#!/usr/bin/env node
/**
 * 将指定版本作为某次运行的人工保留候选，供漏选补发使用。
 *
 *   node scripts/retain-items.mjs --run 7 v587 v609
 *   node scripts/retain-items.mjs --run 7 v587 --section ai_tech
 *
 * 已有候选只覆盖为 retain；尚未建候选的版本会按真实首见时间判断是否
 * late_discovery，并留下候选创建与人工覆盖两类审计记录。
 */
import { openDb, nowIso } from '../packages/db/src/index.ts';
import { overrideCandidate } from '../packages/web/src/actions.ts';

const argv = process.argv.slice(2);
const runAt = argv.indexOf('--run');
const runId = runAt >= 0 ? Number(argv[runAt + 1]) : NaN;
const versions = argv.filter(v => /^v\d+$/.test(v)).map(v => Number(v.slice(1)));
const sectionAt = argv.indexOf('--section');
const section = sectionAt >= 0 ? argv[sectionAt + 1] : 'ai_tech';
const sections = ['ai_tech', 'developer_product', 'quality_article', 'society_life'];
if (!sections.includes(section)) throw new Error(`分区必须是 ${sections.join(' / ')}`);
if (!Number.isInteger(runId) || !versions.length) {
  console.error('用法：retain-items.mjs --run <run-id> v<version-id> [...]');
  process.exit(1);
}

const db = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
if (!run) throw new Error(`运行 #${runId} 不存在`);

const findCandidate = db.prepare(
  'SELECT id FROM candidates WHERE run_id=? AND item_version_id=?');
const versionInfo = db.prepare(`SELECT v.id, f.origin_window_key, f.first_seen_at
  FROM item_versions v JOIN feed_items f ON f.id=v.item_id WHERE v.id=?`);
const insertCandidate = db.prepare(`INSERT INTO candidates
  (run_id,item_version_id,origin_window_key,late_discovery,late_reason,
   decision,mandatory_class,section,created_at)
  VALUES (?,?,?,?,?,'normal','none',?,?)`);
const insertAudit = db.prepare(`INSERT INTO audit_events
  (run_id,entity_type,entity_id,action,payload_json,created_at)
  VALUES (?,?,?,?,?,?)`);

const ids = [];
for (const versionId of versions) {
  let candidate = findCandidate.get(runId, versionId);
  if (!candidate) {
    const info = versionInfo.get(versionId);
    if (!info) throw new Error(`版本 v${versionId} 不存在`);
    const late = Date.parse(info.first_seen_at) >= Date.parse(run.window_end_at);
    const now = nowIso();
    const id = Number(db.transaction(() => {
      const newId = Number(insertCandidate.run(
        runId, versionId, info.origin_window_key, late ? 1 : 0,
        late ? '人工补录：原窗口运行结束后发现' : null, section, now).lastInsertRowid);
      insertAudit.run(runId, 'candidate', String(newId), 'candidate_manual_added',
        JSON.stringify({
          reason: '用户指定为本期正例并要求补发', itemVersionId: versionId,
          lateDiscovery: late, actor: 'owner',
        }), now);
      return newId;
    })());
    candidate = { id };
  }
  ids.push(Number(candidate.id));
}

for (const candidateId of ids) {
  overrideCandidate(db, {
    candidateId, action: 'retain', reason: '用户确认为应保留并推送的正例',
    scope: 'once', actor: 'owner',
  });
}

const placeholders = versions.map(() => '?').join(',');
const rows = db.prepare(`SELECT c.id cid,c.item_version_id vid,c.decision,
  c.mandatory_class,c.section,c.late_discovery,v.title
  FROM candidates c JOIN item_versions v ON v.id=c.item_version_id
  WHERE c.run_id=? AND c.item_version_id IN (${placeholders}) ORDER BY c.id`)
  .all(runId, ...versions);
if (rows.length !== versions.length || rows.some(r => r.decision !== 'retain'))
  throw new Error(`人工保留未完整落库：期望 ${versions.length} 条，实际 ${rows.length} 条`);

console.log(JSON.stringify(rows, null, 2));
db.close();
