// 后台写操作（PRD 16.4 / 16.5 / FR-054 / FR-062 / 19.2）
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, nowIso } from '../packages/db/src/index.ts';
import { overrideCandidate, toggleSource, updateSourceGroup, planResend, executeResend,
         permanentOverrideFor, updateSourceUrl, ActionError } from '../packages/web/src/actions.ts';

const dir = mkdtempSync(join(tmpdir(), 'brief-a-'));
const db = openDb(join(dir, 'a.db'));
migrate(db, './migrations');
const now = nowIso();

db.prepare(`INSERT INTO sources (id,name,display_name,category,host_group,harvest_tier,
  config_json,source_version,created_at,updated_at) VALUES ('s1','S1','S1','forum','direct','standard','{}',1,?,?)`).run(now, now);
db.prepare(`INSERT INTO source_endpoints (source_id,priority,url,parser,enabled,etag,last_modified)
  VALUES ('s1',1,'https://old.example/feed.xml','rss',1,'old-etag','yesterday')`).run();
const runId = Number(db.prepare(`INSERT INTO runs (window_key,window_label,window_start_at,
  window_end_at,scheduled_at,status,trigger) VALUES ('2026-08-23:evening','晚报',?,?,?,'running','timer')`)
  .run(now, now, now).lastInsertRowid);
const itemId = Number(db.prepare(`INSERT INTO feed_items (source_id,source_item_key,key_kind,
  canonical_url,timestamp_confidence,first_seen_at,last_seen_at,created_at)
  VALUES ('s1','t:1','topic_id','https://x/1','exact',?,?,?)`).run(now, now, now).lastInsertRowid);
const vid = Number(db.prepare(`INSERT INTO item_versions (item_id,content_hash,raw_hash,title,
  clean_text,discovered_at,version_no) VALUES (?,?,?,?,?,?,1)`)
  .run(itemId, 'h1', 'r1', '标题', '正文', now).lastInsertRowid);
const cid = Number(db.prepare(`INSERT INTO candidates (run_id,item_version_id,origin_window_key,
  decision,mandatory_class,created_at) VALUES (?,?,'2026-08-23:evening','filter','none',?)`)
  .run(runId, vid, now).lastInsertRowid);

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };
const threw = (fn: () => unknown, code?: number) => {
  try { fn(); return false; } catch (e) { return e instanceof ActionError && (!code || e.code === code); } };
const cand = () => db.prepare('SELECT * FROM candidates WHERE id=?').get(cid) as any;
const audits = () => db.prepare('SELECT * FROM audit_events ORDER BY id').all() as any[];

console.log('理由必填（PRD 16.4）：\n');
{
  ok('空理由被拒', threw(() => overrideCandidate(db, { candidateId: cid, action: 'include', reason: '' }), 400));
  ok('过短理由被拒', threw(() => overrideCandidate(db, { candidateId: cid, action: 'include', reason: 'ab' }), 400));
  ok('拒绝后未修改数据', cand().decision === 'filter');
  ok('不存在的候选返回 404',
     threw(() => overrideCandidate(db, { candidateId: 9999, action: 'include', reason: '合理理由' }), 404));
}

console.log('\n人工收录（FR-062）：\n');
{
  const r = overrideCandidate(db, { candidateId: cid, action: 'include', reason: '这是可复用的开源项目' });
  ok('filter → normal', r.decision === 'normal' && cand().decision === 'normal');
  ok('写入 manual_overrides',
     (db.prepare(`SELECT count(*) c FROM manual_overrides WHERE target_type='candidate'`).get() as any).c === 1);
  const a = audits().at(-1)!;
  ok('写入审计事件（PRD 19.2）', a.action === 'manual_include' && a.entity_id === String(cid));
  const p = JSON.parse(a.payload_json);
  ok('审计含理由与前后状态', p.reason.includes('开源项目') && p.from === 'filter' && p.to === 'normal');
}

console.log('\n改分类：\n');
{
  const r = overrideCandidate(db, { candidateId: cid, action: 'reclassify',
    mandatoryClass: 'A', section: 'developer_product', reason: '属于 A 类可复用项目' });
  ok('改为 A 类后自动置为 retain', r.decision === 'retain' && cand().mandatory_class === 'A');
  ok('分区同时更新', cand().section === 'developer_product');
  ok('非法类别被拒', threw(() => overrideCandidate(db, { candidateId: cid, action: 'reclassify',
     mandatoryClass: 'X', reason: '测试非法输入' }), 400));
}

console.log('\n人工保留：\n');
{
  overrideCandidate(db, { candidateId: cid, action: 'filter', reason: '先验证过滤状态' });
  const r = overrideCandidate(db, { candidateId: cid, action: 'retain', reason: '用户确认为正例并要求保留' });
  ok('retain 可覆盖过滤且无需伪造 A-D 分类',
     r.decision === 'retain' && cand().decision === 'retain' && cand().mandatory_class === 'A');
  ok('retain 清除旧过滤理由', cand().filter_reason === null && cand().filter_rule_id === null);
}

console.log('\n永久规则 vs 仅本次（PRD 16.4）：\n');
{
  ok('仅本次不产生 canonical_key 规则', permanentOverrideFor(db, 'https://x/1') === null);
  overrideCandidate(db, { candidateId: cid, action: 'filter', scope: 'permanent',
    reason: '该站长期发广告，永久过滤' });
  const p = permanentOverrideFor(db, 'https://x/1');
  ok('永久规则以 canonical key 记录', p?.action === 'filter' && p.reason.includes('永久过滤'));
  ok('过滤理由标明为人工判定', String(cand().filter_reason).startsWith('人工：'));
}

console.log('\n来源启停（FR-001）：\n');
{
  ok('无理由停用被拒', threw(() => toggleSource(db, 's1', false, ''), 400));
  const r = toggleSource(db, 's1', false, '该源已连续 404 一周');
  ok('停用生效', r.enabled === false &&
     (db.prepare(`SELECT enabled FROM sources WHERE id='s1'`).get() as any).enabled === 0);
  ok('写入审计', audits().at(-1)!.action === 'source_disabled');
  toggleSource(db, 's1', true, '来源已恢复');
  ok('可再启用', (db.prepare(`SELECT enabled FROM sources WHERE id='s1'`).get() as any).enabled === 1);
  ok('不存在的来源 404', threw(() => toggleSource(db, 'nope', false, '合理理由'), 404));
}

console.log('\n编辑来源 URL：\n');
{
  const probe = async (_db: any, o: any) => ({ ok: true as const, outcome: 'ok',
    parsedCount: 12, sample: [], latencyMs: 1, testedUrl: o.url });
  ok('空理由被拒', await (async () => { try {
    await updateSourceUrl(db, { sourceId: 's1', url: 'https://new.example/feed.xml', reason: '' }, probe as any);
    return false; } catch (e) { return e instanceof ActionError && e.code === 400; } })());
  const r = await updateSourceUrl(db, { sourceId: 's1', url: 'https://new.example/feed.xml',
    reason: '订阅地址已经迁移' }, probe as any);
  const ep = db.prepare(`SELECT * FROM source_endpoints WHERE source_id='s1' AND priority=1`).get() as any;
  ok('测试通过后更新 URL', r.parsedCount === 12 && ep.url === 'https://new.example/feed.xml');
  ok('切换 URL 后清空条件请求缓存', ep.etag === null && ep.last_modified === null);
  ok('记录永久端点覆盖', (db.prepare(`SELECT count(*) c FROM manual_overrides
    WHERE target_type='source_endpoint' AND target_id='s1:1' AND action='edit_url'`).get() as any).c === 1);
  const a = audits().at(-1)!;
  const p = JSON.parse(a.payload_json);
  ok('审计记录新旧 URL 与理由', a.action === 'source_url_updated' &&
    p.oldUrl.includes('old.example') && p.newUrl.includes('new.example') && p.reason.includes('迁移'));
}

console.log('\n来源展示分组：\n');
{
  ok('无理由调整分组被拒', threw(() => updateSourceGroup(db, 's1', 'openai', ''), 400));
  const r = updateSourceGroup(db, 's1', 'openai', '归入官方厂商来源');
  ok('分组修改生效', r.sourceGroup === 'openai' &&
     (db.prepare(`SELECT source_group FROM sources WHERE id='s1'`).get() as any).source_group === 'openai');
  ok('非法分组被拒', threw(() => updateSourceGroup(db, 's1', 'other', '测试非法分组'), 400));
}

console.log('\n补发两步确认（PRD 16.5 / FR-054）：\n');
{
  const briefId = Number(db.prepare(`INSERT INTO briefs (run_id,version,subject,text_body,
    html_body,html_bytes,status,rule_version,created_at) VALUES (?,1,'十六源简报｜2026-08-23 晚报','t','h',8123,'final',1,?)`)
    .run(runId, now).lastInsertRowid);
  db.prepare(`INSERT INTO deliveries (brief_id,recipient,delivery_type,resend_sequence,
    attempt,status,provider_id,sent_at,created_at) VALUES (?,?,'primary',0,1,'sent','m1',?,?)`)
    .run(briefId, 'me@x.com', now, now);

  const plan = planResend(db, briefId, 'me@x.com');
  ok('展示已投递记录（PRD 16.5 防误操作）',
     plan.priorDeliveries.length === 1 && plan.priorDeliveries[0]!.status === 'sent');
  ok('给出新主题行与体积', plan.subject.includes('晚报') && plan.htmlBytes === 8123);
  ok('下一个补发序号为 1', plan.nextSequence === 1);

  let sent: any = null;
  const send = async (o: any) => { sent = o; return { ok: true, providerId: 'm2' }; };
  const r = await executeResend(db, send,
    { briefId, recipient: 'me@x.com', reason: '首次投递格式有误', confirmedSequence: 1 });
  ok('补发成功并带正确序号', r.ok && r.sequence === 1 && sent.sequence === 1);
  ok('补发写入审计', audits().at(-1)!.action === 'manual_resend');

  // 页面过期检测：期间序号已变
  db.prepare(`INSERT INTO deliveries (brief_id,recipient,delivery_type,resend_sequence,
    attempt,status,created_at) VALUES (?,?,'resend',1,1,'sent',?)`).run(briefId, 'me@x.com', now);
  let conflict = false;
  try {
    await executeResend(db, send, { briefId, recipient: 'me@x.com', reason: '再补一次', confirmedSequence: 1 });
  } catch (e) { conflict = e instanceof ActionError && e.code === 409; }
  ok('序号变化时拒绝并提示刷新（防重复补发）', conflict);

  let noReason = false;
  try { await executeResend(db, send, { briefId, recipient: 'me@x.com', reason: '', confirmedSequence: 2 }); }
  catch (e) { noReason = e instanceof ActionError && e.code === 400; }
  ok('补发同样必须填理由', noReason);
}

console.log('\n审计完整性：\n');
{
  const all = audits();
  // 校验具体动作集合比数量更有意义：失败的操作不应留痕，成功的必须留痕
  const acts = all.map(a => a.action).sort();
  const expect = ['manual_filter','manual_filter','manual_include','manual_reclassify','manual_resend','manual_retain',
                  'source_disabled','source_enabled','source_group_updated','source_url_updated'].sort();
  ok('留痕动作与成功的写操作一一对应',
     JSON.stringify(acts) === JSON.stringify(expect), acts.join(', '));
  ok('被拒绝的操作未留痕（无理由/非法值/序号冲突）', all.length === 10);
  ok('每条审计都带理由',
     all.every(a => { const p = JSON.parse(a.payload_json ?? '{}'); return !!p.reason; }));
  ok('每条审计都记录操作者',
     all.every(a => { const p = JSON.parse(a.payload_json ?? '{}'); return !!p.actor; }));
}

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
