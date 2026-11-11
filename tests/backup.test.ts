// 备份压缩与保留（维护任务 brief-maintain）
// 2026-10 事故：Telegram 库 800 MB，readFileSync + gzipSync 整库进内存，2 GB 机器 swap 打满，
// 维护 600 秒超时被杀；残留的未压缩 .db 与 -journal 不匹配保留规则，在备份目录里越堆越多。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { gzipFile, pruneBackups, removeStaleTemps } from '../apps/worker/src/backup-files.ts';

const dir = mkdtempSync(join(tmpdir(), 'brief-backup-'));
let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };
const touch = (...names: string[]) => { for (const n of names) writeFileSync(join(dir, n), n); };
const files = () => readdirSync(dir).sort();
const reset = () => { for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true }); };

console.log('流式压缩：\n');
{
  const src = join(dir, 'telegram-2026-10-09.db');
  const payload = Buffer.alloc(4 * 1024 * 1024, 'telegram-message ');
  writeFileSync(src, payload);
  const bytes = await gzipFile(src);
  ok('原文件压缩后被删除', !existsSync(src));
  ok('得到 .gz 且内容可完整还原', gunzipSync(readFileSync(`${src}.gz`)).equals(payload));
  ok('返回压缩后大小', bytes > 0 && bytes < payload.length);
  ok('不留 .partial', !files().some(f => f.endsWith('.partial')));
}

console.log('\n压缩失败时不留半截文件、不删原文件：\n');
{
  reset();
  // 用目录充当源文件制造读失败（EISDIR），以 root 运行也能稳定复现
  const src = join(dir, 'brief-2026-10-09.db');
  mkdirSync(src);
  let threw = false;
  try { await gzipFile(src); } catch { threw = true; }
  ok('失败时抛错', threw);
  ok('源仍在', existsSync(src));
  ok('没有 .gz 或 .partial', !files().some(f => f.includes('.gz')), files().join(','));
}

console.log('\n清理中断残留：\n');
{
  reset();
  touch('brief-2026-10-04.db', 'brief-2026-10-08.db', 'telegram-2026-10-03.db-journal', 'telegram-2026-10-05.db.gz.partial',
        'brief-2026-10-08.db.gz', 'telegram-2026-10-02.db.gz', 'brief-pre-yicai-2026-09-30.db');
  const removed = removeStaleTemps(dir, 'brief').concat(removeStaleTemps(dir, 'telegram'));
  ok('删除未压缩 .db、-journal、.partial', removed.length === 4, removed.join(','));
  ok('保留 .db.gz 和人工命名的快照',
     JSON.stringify(files()) === JSON.stringify(['brief-2026-10-08.db.gz', 'brief-pre-yicai-2026-09-30.db', 'telegram-2026-10-02.db.gz']),
     files().join(','));
}

console.log('\n保留策略：\n');
{
  reset();
  // 2026-10-05 与 2026-09-28 是周一
  touch('telegram-2026-09-28.db.gz', 'telegram-2026-10-05.db.gz', 'telegram-2026-10-07.db.gz', 'telegram-2026-10-08.db.gz', 'brief-2026-10-01.db.gz');
  pruneBackups(dir, 'telegram', 1, 0);
  ok('KEEP_DAILY=1、KEEP_WEEKLY=0 只留最新一份',
     JSON.stringify(files()) === JSON.stringify(['brief-2026-10-01.db.gz', 'telegram-2026-10-08.db.gz']), files().join(','));
  ok('不影响其他前缀', files().includes('brief-2026-10-01.db.gz'));

  reset();
  touch('brief-2026-09-28.db.gz', 'brief-2026-10-05.db.gz', 'brief-2026-10-07.db.gz', 'brief-2026-10-08.db.gz');
  pruneBackups(dir, 'brief', 2, 1);
  ok('日备 2 份 + 最近 1 个周一',
     JSON.stringify(files()) === JSON.stringify(['brief-2026-10-05.db.gz', 'brief-2026-10-07.db.gz', 'brief-2026-10-08.db.gz']), files().join(','));

  reset();
  touch('brief-2026-10-08.db.gz');
  pruneBackups(dir, 'brief', 0, 0);
  ok('KEEP_DAILY=0 也不会删掉刚生成的最新一份', files().includes('brief-2026-10-08.db.gz'));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
