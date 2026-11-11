import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'brief-subscriptions-'));
try {
  const briefingPath = join(dir, 'brief.db');
  const telegramPath = join(dir, 'telegram.db');
  const output = join(dir, 'SUBSCRIPTIONS.md');
  const briefing = new Database(briefingPath);
  briefing.exec(`
    CREATE TABLE sources(id TEXT PRIMARY KEY,name TEXT,display_name TEXT,category TEXT,source_group TEXT,
      enabled INTEGER,priority INTEGER,site_url TEXT,archived_at TEXT);
    CREATE TABLE source_endpoints(source_id TEXT,priority INTEGER,url TEXT,enabled INTEGER);
    INSERT INTO sources VALUES('safe','Safe Feed','Safe Feed','tech','google',1,1,'https://example.com/',NULL);
    INSERT INTO source_endpoints VALUES('safe',1,'https://example.com/feed.xml',1);
    INSERT INTO source_endpoints VALUES('safe',2,'https://example.com/private?token=do-not-publish',1);
    INSERT INTO sources VALUES('off','Disabled','Disabled','tech','google',0,2,'https://disabled.example/',NULL);
    -- 已归档但启用位为 1（配置同步可能改回）：不公开
    INSERT INTO sources VALUES('arch','Archived Feed','Archived Feed','tech','google',1,3,'https://archived.example/','2026-11-10T00:00:00Z');
    INSERT INTO source_endpoints VALUES('arch',1,'https://archived.example/feed.xml',1);
    -- 路径令牌、路径令牌 + 认证参数、像令牌的随机串：整条不公开
    INSERT INTO sources VALUES('tok','Token Feed','Token Feed','tech','google',1,4,NULL,NULL);
    INSERT INTO source_endpoints VALUES('tok',1,'https://feeds.example/rss/briefs/${'a'.repeat(64)}',1);
    INSERT INTO source_endpoints VALUES('tok',2,'https://feeds.example/u/Ab3dEf5hIj7kLm9nOp1rSt3v/feed?token=zzz',1);
    INSERT INTO source_endpoints VALUES('tok',3,'https://feeds.example/plain/feed.xml?page=2',1);
  `);
  briefing.close();
  const telegram = new Database(telegramPath);
  telegram.exec(`
    CREATE TABLE telegram_sources(id INTEGER PRIMARY KEY,reference TEXT,display_name TEXT,title TEXT,username TEXT,
      source_type TEXT,status TEXT,enabled INTEGER);
    INSERT INTO telegram_sources VALUES(1,'t.me/+private-secret','Private Group Name',NULL,NULL,'normal','active',1);
    INSERT INTO telegram_sources VALUES(2,'t.me/c/123',NULL,NULL,NULL,'normal','error',0);
    INSERT INTO telegram_sources VALUES(3,'@publicchan','Public Channel Name',NULL,'publicchan','normal','active',1);
    INSERT INTO telegram_sources VALUES(4,'@stopped','Stopped Channel',NULL,'stopped','normal','active',0);
    INSERT INTO telegram_sources VALUES(5,'@urlonly','Url Only Channel',NULL,'urlonly','url','active',1);
  `);
  telegram.close();

  execFileSync(process.execPath, ['scripts/sync-public-subscriptions.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: briefingPath, TELEGRAM_DATABASE_PATH: telegramPath,
      PUBLIC_SUBSCRIPTIONS_REPO: dir, PUBLIC_SUBSCRIPTIONS_FILE: 'SUBSCRIPTIONS.md' },
  });
  const result = readFileSync(output, 'utf8');
  assert.match(result, /Safe Feed/);
  assert.match(result, /https:\/\/example\.com\/feed\.xml/);
  // 查询参数一律去掉，只留协议、主机、路径
  assert.doesNotMatch(result, /example\.com\/private/, '带认证参数的地址整条不公开，不是去掉参数后公开');
  assert.match(result, /<https:\/\/feeds\.example\/plain\/feed\.xml>/, '普通参数去掉后公开');
  assert.doesNotMatch(result, /rss\/briefs|aaaaaaaa|Ab3dEf5hIj7kLm9nOp1rSt3v|zzz/, '路径令牌不公开'); 
  // Telegram 部分暂停发布：即使有公开用户名的启用群也不发布
  assert.doesNotMatch(result, /Telegram 订阅|Public Channel Name/);
  assert.doesNotMatch(result, /do-not-publish|token=|private-secret|Private Group Name|t\.me\/c\/123|Disabled|Archived Feed|archived\.example|Stopped Channel|Url Only Channel/);
  console.log('✓ 公开订阅清单生成与敏感字段隔离测试通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
