#!/usr/bin/env node
/** 把 config/sources.yaml 同步进数据库。幂等，可反复执行。 */
import { openDb, nowIso } from '../../../packages/db/src/index.ts';
import { loadSources } from '../../../packages/domain/src/rules.ts';

const db = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const cfg = loadSources();
const now = nowIso();

const upSrc = db.prepare(`
  INSERT INTO sources (id,name,display_name,category,source_group,host_group,harvest_tier,enabled,priority,
                       mandatory_retention,require_fulltext,config_json,source_version,
                       managed_by,site_url,vendor,is_official,source_role,created_at,updated_at)
  VALUES (@id,@name,@display_name,@category,@source_group,@host_group,@harvest_tier,@enabled,@priority,
          @mandatory_retention,@require_fulltext,@config_json,@source_version,
          'config',@site_url,@vendor,@is_official,@source_role,@now,@now)
  -- 只更新 config 归属的来源；后台新增的（managed_by='admin'）不得被覆盖
  ON CONFLICT(id) DO UPDATE SET
    name=@name, display_name=@display_name, category=@category, host_group=@host_group,
    harvest_tier=@harvest_tier, enabled=@enabled, priority=@priority,
    mandatory_retention=@mandatory_retention, require_fulltext=@require_fulltext,
    config_json=@config_json, source_version=@source_version,
    site_url=@site_url, vendor=@vendor, is_official=@is_official, source_role=@source_role,
    updated_at=@now
  WHERE sources.managed_by = 'config'`);

// 端点用 upsert 而非删重建：fetch_attempts.endpoint_id 外键引用它，
// 删除会切断审计链路（且触发 FOREIGN KEY constraint failed）。
// 配置里已移除的端点标记为 disabled 而不删除，历史仍可追溯。
const upEp = db.prepare(`
  INSERT INTO source_endpoints (source_id,priority,url,parser,host_group,enabled)
  VALUES (@source_id,@priority,@url,@parser,@host_group,1)
  ON CONFLICT(source_id,priority) DO UPDATE SET
    url=@url, parser=@parser, host_group=@host_group, enabled=1,
    -- URL 变了则条件 GET 缓存失效
    etag   = CASE WHEN source_endpoints.url = @url THEN source_endpoints.etag          ELSE NULL END,
    last_modified = CASE WHEN source_endpoints.url = @url THEN source_endpoints.last_modified ELSE NULL END`);
const disableEp = db.prepare(
  'UPDATE source_endpoints SET enabled=0 WHERE source_id=? AND priority NOT IN (SELECT value FROM json_each(?))');

db.transaction(() => {
  for (const s of cfg.sources) {
    // 后台永久启停是用户明确决定。配置同步只提供默认值，不能把后台已停用
    // 的来源重新打开（或把后台已启用的来源再次关闭）。
    const toggle = db.prepare(`SELECT action FROM manual_overrides
      WHERE target_type='source' AND target_id=? AND action IN ('enable','disable')
        AND scope='permanent' ORDER BY id DESC LIMIT 1`).get(s.id) as { action: string } | undefined;
    const enabled = toggle ? toggle.action === 'enable' : !!s.enabled;
    upSrc.run({
      id: s.id, name: s.name, display_name: s.display_name, category: s.category,
      source_group: s.source_group ?? 'unclassified',
      host_group: s.host_group, harvest_tier: s.harvest_tier,
      enabled: enabled ? 1 : 0, priority: s.priority ?? 5,
      mandatory_retention: s.mandatory_retention ? 1 : 0,
      require_fulltext: s.require_fulltext ? 1 : 0,
      config_json: JSON.stringify(s), source_version: cfg.meta.source_version,
      site_url: s.site_url ?? null,
      vendor: s.vendor ?? 'other', is_official: s.official === true ? 1 : 0,
      source_role: ['official', 'politics', 'context'].includes(s.role) ? s.role : (s.official === true ? 'official' : 'context'),
      now,
    });
    for (const e of s.endpoints) {
      // 后台对单个端点的永久 URL 覆盖优先于 sources.yaml，避免同步时改回旧地址。
      const overridden = db.prepare(`SELECT 1 FROM manual_overrides
        WHERE target_type='source_endpoint' AND target_id=? AND action='edit_url'
          AND scope='permanent' ORDER BY id DESC LIMIT 1`).get(`${s.id}:${e.priority}`);
      if (!overridden)
        upEp.run({ source_id: s.id, priority: e.priority, url: e.url,
                   parser: e.parser, host_group: e.host_group ?? null });
    }
    disableEp.run(s.id, JSON.stringify(s.endpoints.map((e: any) => e.priority)));
  }
})();

const n = db.prepare(`SELECT count(*) c FROM sources WHERE managed_by='config'`).get() as any;
const a = db.prepare(`SELECT count(*) c FROM sources WHERE managed_by='admin'`).get() as any;
const m = db.prepare('SELECT count(*) c FROM source_endpoints').get() as any;
console.log(`已同步 ${n.c} 个配置来源 / ${m.c} 个端点 (source_version=${cfg.meta.source_version})`);
if (a.c) console.log(`另有 ${a.c} 个后台新增的来源，未被本次同步触碰`);
db.close();
