/**
 * 数据库备份开关（本机每日备份 / Google Drive 备份分别控制）。
 *
 * 存成数据目录下的一个小 JSON 文件，而不是数据库或密钥库：
 * Google Drive 备份脚本以 root 运行、用 bash + python3，读不了加密保管库；放进数据库又要新迁移。
 * 读取失败（文件不存在、损坏、字段缺失）一律按「开启」处理：宁可多备份，也不能因为配置出错静默停止备份。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type BackupSettings = { local: boolean; gdrive: boolean; updatedAt: string | null };

export function backupSettingsPath(): string {
  return process.env.BACKUP_SETTINGS_PATH ?? join(process.env.DATA_DIR ?? '/var/lib/briefing', 'backup-settings.json');
}

export function readBackupSettings(path = backupSettingsPath()): BackupSettings & { error?: string } {
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e: any) {
    if (e?.code === 'ENOENT') return { local: true, gdrive: true, updatedAt: null };
    return { local: true, gdrive: true, updatedAt: null, error: '备份开关文件无法读取，按全部开启处理' };
  }
  // 只有明确写成 false 才算关闭
  return { local: raw?.local !== false, gdrive: raw?.gdrive !== false, updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null };
}

/** 原子写入：先写临时文件再改名，备份脚本不会读到半截内容。权限 0644：root 运行的 Google Drive 脚本需要读。 */
export function writeBackupSettings(s: { local: boolean; gdrive: boolean }, path = backupSettingsPath()): BackupSettings {
  const value: BackupSettings = { local: !!s.local, gdrive: !!s.gdrive, updatedAt: new Date().toISOString() };
  const tmp = join(dirname(path), `.backup-settings.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o644 });
  renameSync(tmp, path);
  return value;
}

export type GdriveStatus = { state: 'OK' | 'FAIL' | 'SKIP' | 'UNKNOWN'; at: number | null; detail: string };

/** Google Drive 备份脚本写的状态行：`OK|FAIL|SKIP <ISO 时间> <说明>`。 */
export function readGdriveStatus(path = process.env.GDRIVE_BACKUP_STATUS_PATH ?? '/var/lib/briefing-gdrive-backup.status'): GdriveStatus {
  let line = '';
  try { line = readFileSync(path, 'utf8').trim().split('\n')[0] ?? ''; } catch { return { state: 'UNKNOWN', at: null, detail: '没有找到 Google Drive 备份记录' }; }
  const m = /^(OK|FAIL|SKIP)\s+(\S+)\s*(.*)$/.exec(line);
  if (!m) return { state: 'UNKNOWN', at: null, detail: '状态记录格式无法识别' };
  const at = Date.parse(m[2]!);
  return { state: m[1] as GdriveStatus['state'], at: Number.isFinite(at) ? at : null, detail: m[3]!.slice(0, 120) };
}
