// 来源日报资格（共用 SQL）：从 allnet-controls.test.ts 迁出的普通来源回归，删除全网热点后行为与签名必须保持不变
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openDb, migrate, sha256 } from '../packages/db/src/index.ts';
import { itemsInWindow } from '../packages/db/src/queries.ts';
import { candidateEligibleSql, eligibilitySignature, assertEligibilityUnchanged } from '../packages/db/src/eligibility.ts';
import { toggleSource } from '../packages/web/src/actions.ts';
import { deliver } from '../packages/templates/src/delivery.ts';

const dir = mkdtempSync(join(tmpdir(), 'source-eligibility-')); const dbpath = join(dir, 'test.db'); const db = openDb(dbpath);
migrate(db, 'migrations');
const now = new Date().toISOString();
for (const [id, enabled] of [['on', 1], ['off', 0], ['normal', 1]] as const)
  db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,managed_by,enabled,created_at,updated_at)
    VALUES(?,?,?,'tech','direct','standard','{}',1,'admin',?,?,?)`).run(id, id, id, enabled, now, now);
const env = { ...process.env, DATABASE_PATH: dbpath, SNAPSHOT_DIR: join(dir, 'snap') };
const win = { key: 'test', label: 'test', start: new Date(Date.now() - 3600000), end: new Date(Date.now() + 3600000) };
const add = (source: string, key: string, url: string, seen: string, published: string | null = now) => {
  const id = Number(db.prepare(`INSERT INTO feed_items(source_id,source_item_key,key_kind,canonical_url,published_at,timestamp_confidence,first_seen_at,last_seen_at,created_at)
    VALUES(?,?,'guid',?,?,?,?,?,?)`).run(source, key, url, published, published ? 'exact' : 'missing', seen, seen, seen).lastInsertRowid);
  const vid = Number(db.prepare(`INSERT INTO item_versions(item_id,content_hash,raw_hash,title,clean_text,is_excerpt,discovered_at,version_no) VALUES(?,?,'test',?,?,0,?,1)`)
    .run(id, key, key, key, seen).lastInsertRowid);
  db.prepare('UPDATE feed_items SET current_version_id=? WHERE id=?').run(vid, id); return vid;
};
try {
  // 停用来源的内容不得压制有效来源（重复网址判断只看有资格的来源）
  add('off', 'disabled-copy', 'https://example.com/shared', new Date(Date.now() - 10000).toISOString());
  const normalVid = add('normal', 'daily', 'https://example.com/shared', new Date().toISOString());
  assert.equal(itemsInWindow(db, win).find(r => r.vid === normalVid)?.dup_canonical, 0);
  assert.ok(!itemsInWindow(db, win).some(r => r.source_id === 'off'), '停用来源的条目不入选');
  // 缺发布时间的普通条目不按首次发现时间入选（原全网热点专属规则删除后不能扩大到普通来源）
  const undated = add('normal', 'undated', 'https://example.com/undated', new Date().toISOString(), null);
  assert.ok(!itemsInWindow(db, win).some(r => r.vid === undated));
  console.log('  ✅ 重复网址只看有资格的来源；停用来源与缺发布时间的条目不入选');

  const onVid = add('on', 'new', 'https://example.com/new', new Date().toISOString());
  db.prepare(`INSERT INTO runs(window_key,window_label,window_start_at,window_end_at,scheduled_at,status,trigger) VALUES('2026-09-06:daily','test',?,?,?,'running','timer')`).run(now, now, now);
  for (const vid of [onVid, normalVid]) db.prepare(`INSERT INTO candidates(run_id,item_version_id,origin_window_key,decision,created_at) VALUES(1,?,'2026-09-06:daily','escalate',?)`).run(vid, now);

  // 签名与删除全网热点之前的写法逐字一致（allnet_subscriptions 表在阶段一仍存在，普通来源 JOIN 结果为 NULL）
  const legacy = sha256(JSON.stringify(db.prepare(`SELECT DISTINCT s.id,s.enabled,a.briefing_enabled_since
    FROM candidates c JOIN item_versions v ON v.id=c.item_version_id
    JOIN feed_items f ON f.id=v.item_id JOIN sources s ON s.id=f.source_id
    LEFT JOIN allnet_subscriptions a ON a.source_id=s.id WHERE c.run_id=? ORDER BY s.id`).all(1)));
  assert.equal(eligibilitySignature(db, 1), legacy, '普通来源的资格签名必须与旧版一致（旧版简报复用与投递重试依赖它）');
  console.log('  ✅ 资格签名与旧版逐字一致');

  const before = eligibilitySignature(db, 1); toggleSource(db, 'on', false, 'stop daily');
  assert.throws(() => assertEligibilityUnchanged(db, 1, before), /资格已变化/);
  assert.equal((db.prepare(`SELECT count(*) n FROM candidates c WHERE ${candidateEligibleSql()}`).get() as any).n, 1, '停用来源的已有候选被排除');
  console.log('  ✅ 停用来源后资格签名变化、已有候选被排除');

  db.prepare("UPDATE candidates SET decision='filter',filter_rule_id='TEST',filter_reason='test' WHERE item_version_id=?").run(normalVid);
  for (const stage of ['triage', 'review', 'brief']) {
    const r = spawnSync(process.execPath, [`apps/worker/src/${stage}.ts`, '--run', '1', '--no-send'],
      { env: { ...env, MAIL_TO: '', AI_PROVIDER: 'mock', AI_L1_PROVIDER: 'mock', AI_L2_PROVIDER: 'mock', AI_L3_PROVIDER: 'mock' }, encoding: 'utf8' });
    assert.equal(r.status, 0, `${stage}: ${r.stderr} ${r.stdout}`);
  }
  assert.equal((db.prepare('SELECT count(*) n FROM evaluations e JOIN candidates c ON c.id=e.candidate_id WHERE c.item_version_id=?').get(onVid) as any).n, 0);
  const generated = db.prepare('SELECT html_body FROM briefs WHERE run_id=1 ORDER BY id DESC LIMIT 1').get() as any;
  assert.ok(!generated || !generated.html_body.includes('https://example.com/new'), '被排除的条目不得出现在正文或附录');
  console.log('  ✅ 判定与组装跳过停用来源的条目');

  // 投递重试等待期间来源被停用：第二次发送必须被拦下
  const signature = eligibilitySignature(db, 1);
  const brief = Number(db.prepare(`INSERT INTO briefs(run_id,version,subject,text_body,html_body,html_bytes,status,rule_version,created_at,eligibility_signature) VALUES(1,9,'s','t','h',1,'final',1,?,?)`).run(now, signature).lastInsertRowid);
  let calls = 0;
  await assert.rejects(() => deliver(db, async () => { calls++; return { ok: false, permanent: false, error: 'temporary' }; },
    { briefId: brief, recipient: 'test@example.com', deliveryType: 'primary', subject: 's', text: 't', html: 'h', sleep: async () => { toggleSource(db, 'normal', false, 'stop before retry'); } }), /资格已变化/);
  assert.equal(calls, 1); assert.equal((db.prepare('SELECT status FROM deliveries WHERE brief_id=?').get(brief) as any).status, 'failed');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log('  ✅ 投递重试期间来源停用会拦下第二次发送');
  console.log('\n✅ 全部通过');
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
