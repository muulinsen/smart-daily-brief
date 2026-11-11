/**
 * 备份文件的压缩与保留。
 *
 * 压缩必须走流式：Telegram 库已超过 800 MB，旧实现 readFileSync + gzipSync 会把整库连同压缩结果
 * 一起放进内存，在 2 GB 内存的机器上直接把 swap 打满，维护任务 600 秒超时被杀，备份从此停摆。
 */
import { createReadStream, createWriteStream, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/** 把 src 流式压缩成 `${src}.gz`，成功后删除 src，返回压缩后字节数。中途失败不会留下半截 .gz。 */
export async function gzipFile(src: string): Promise<number> {
  const out = `${src}.gz`;
  const partial = `${out}.partial`;
  try {
    await pipeline(createReadStream(src), createGzip(), createWriteStream(partial));
  } catch (error) {
    try { unlinkSync(partial); } catch { /* 未生成 */ }
    throw error;
  }
  renameSync(partial, out);
  unlinkSync(src);
  return statSync(out).size;
}

/**
 * 清理上次被中断的维护留下的残骸：未压缩的 `<prefix>-YYYY-MM-DD.db`、SQLite 的 `-journal`、
 * 写到一半的 `.gz.partial`。这些文件不匹配保留规则的 `.db.gz` 模式，不清理就会永远堆在备份目录里。
 */
export function removeStaleTemps(dir: string, prefix: string): string[] {
  const stale = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.db(?:-journal|\\.gz\\.partial)?$`);
  const removed = readdirSync(dir).filter(f => stale.test(f));
  for (const f of removed) unlinkSync(join(dir, f));
  return removed;
}

/** 按日期保留最近 keepDaily 份 `<prefix>-YYYY-MM-DD.db.gz`，另保留最近 keepWeekly 个周一的份。返回被删除的文件名。 */
export function pruneBackups(dir: string, prefix: string, keepDaily: number, keepWeekly: number): string[] {
  const pattern = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.db\\.gz$`);
  const backups = readdirSync(dir).filter(f => pattern.test(f)).sort().reverse();
  const weekly = backups.filter(f => new Date(f.slice(prefix.length + 1, prefix.length + 11)).getUTCDay() === 1);
  const keep = new Set([...backups.slice(0, Math.max(keepDaily, 1)), ...weekly.slice(0, keepWeekly)]);
  const removed = backups.filter(f => !keep.has(f));
  for (const f of removed) unlinkSync(join(dir, f));
  return removed;
}
