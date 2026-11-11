#!/bin/bash
# 备份日报系统 Telegram 聊天记录(及日报库)到 Google Drive
# 1) briefing-backup/ 只保留最新两份压缩包(今天+昨天)
# 2) briefing-text/ 每天重新导出可阅读文本(jsonl,按群按月),覆盖旧内容
# 3) briefing-weekly/ 每周日(UTC)额外存一份压缩包,保留最近8份
# 4) 结果写入 /var/lib/briefing-gdrive-backup.status,供外部检查(OK / FAIL / SKIP)
# 仓库内副本：deploy/scripts/briefing-gdrive-backup.sh，部署时复制到 /usr/local/bin（root 0700）
set -euo pipefail
REMOTE="briefing-gdrive:briefing-backup"
TEXT_REMOTE="briefing-gdrive:briefing-text"
WEEKLY_REMOTE="briefing-gdrive:briefing-weekly"
STATUS=${GDRIVE_BACKUP_STATUS_PATH:-/var/lib/briefing-gdrive-backup.status}
STAMP=$(date -u +%Y%m%d-%H%M%S)
# 后台「备份与存储」的开关（brief-web 写入 /var/lib/briefing/backup-settings.json）。
# 只有明确写成 "gdrive": false 才跳过；文件不存在或读不了一律照常备份。
SETTINGS=${BACKUP_SETTINGS_PATH:-/var/lib/briefing/backup-settings.json}
if [ -f "$SETTINGS" ] && python3 - "$SETTINGS" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(d, dict) and d.get("gdrive") is False else 1)
PY
then
  echo "SKIP $(date -u +%Y-%m-%dT%H:%M:%SZ) Google Drive 备份已在后台关闭" > "$STATUS"
  echo "Google Drive 备份已在后台关闭，跳过"
  exit 0
fi
# 临时目录用 mktemp 安全创建（固定路径可被本机其他用户抢先创建，以 root 运行时会把数据写进对方控制的目录）
TMP=$(mktemp -d "${GDRIVE_BACKUP_TMP_PARENT:-/var/tmp}/gdrive-backup.XXXXXX")
chmod 700 "$TMP"
finish() {
  rc=$?
  if [ $rc -eq 0 ]; then
    echo "OK $(date -u +%Y-%m-%dT%H:%M:%SZ) briefing-$STAMP.tar.zst" > "$STATUS"
  else
    echo "FAIL $(date -u +%Y-%m-%dT%H:%M:%SZ) exit=$rc" > "$STATUS"
  fi
  rm -rf "$TMP"
}
trap finish EXIT
nice -n 19 ionice -c3 sqlite3 /var/lib/briefing/telegram/telegram.sqlite3 ".backup '$TMP/telegram.sqlite3'"
nice -n 19 ionice -c3 sqlite3 /var/lib/briefing/brief.db ".backup '$TMP/brief.db'"
cd "$TMP"

nice -n 19 python3 - "$TMP/telegram.sqlite3" "$TMP/text" <<'PY'
import sqlite3, sys, os, re, json
db, out = sys.argv[1], sys.argv[2]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
src = {r[0]: r[1:] for r in con.execute("select id, coalesce(nullif(title,''),display_name,reference), coalesce(username,''), chat_id from telegram_sources")}
def safe(s): return re.sub(r'[\\/:*?"<>|\s]+', '_', s).strip('_')[:60] or 'unknown'
files = {}
cur = con.execute("select source_id, message_id, sent_at, text, edited_at, reply_to_id, source_url from telegram_messages where deleted_at is null and text is not null and text<>'' order by source_id, sent_at, message_id")
try:
    for sid, mid, sent, text, edited, reply, url in cur:
        title, uname, chat = src.get(sid, (f"source{sid}", '', 0))
        d = os.path.join(out, f"{sid}_{safe(title)}")
        os.makedirs(d, exist_ok=True)
        fn = os.path.join(d, sent[:7] + ".jsonl")
        # 结果按来源、时间排序，同一文件只会连续出现：换文件时关掉上一个，避免历史很长时打开文件数超限
        f = files.get(fn)
        if f is None:
            for old in files.values(): old.close()
            files.clear()
            f = files[fn] = open(fn, "a", encoding="utf-8")
        f.write(json.dumps({"time_utc": sent, "source": title, "message_id": mid, "text": text, "reply_to": reply, "edited_at": edited, "url": url}, ensure_ascii=False) + "\n")
finally:
    for f in files.values(): f.close()
os.makedirs(out, exist_ok=True)   # 没有任何文本消息时也要有导出目录，否则整个备份中途失败
with open(os.path.join(out, "README.txt"), "w", encoding="utf-8") as r:
    r.write("日报系统 Telegram 聊天记录文本导出\n每行一条 JSON:time_utc(UTC时间,北京时间+8小时)、source(群/频道)、message_id、text、reply_to、edited_at、url(原消息链接)\n目录=来源编号_名称,文件=月份.jsonl\n不含已删除消息;数据库未记录发送人。\n每天自动重新生成并覆盖。\n")
PY

tar --use-compress-program="zstd -T1 -10" -cf "briefing-$STAMP.tar.zst" telegram.sqlite3 brief.db
rm -f telegram.sqlite3 brief.db
rclone copy "briefing-$STAMP.tar.zst" "$REMOTE/" --drive-chunk-size 64M --transfers 1
rclone sync "$TMP/text" "$TEXT_REMOTE/" --transfers 2
# 每周日(UTC)再存一份长期存档,保留最近8份
if [ "$(date -u +%u)" = "7" ]; then
  rclone copyto "$REMOTE/briefing-$STAMP.tar.zst" "$WEEKLY_REMOTE/weekly-$STAMP.tar.zst" --drive-server-side-across-configs 2>/dev/null \
    || rclone copyto "briefing-$STAMP.tar.zst" "$WEEKLY_REMOTE/weekly-$STAMP.tar.zst" --drive-chunk-size 64M
  rclone lsf "$WEEKLY_REMOTE/" --files-only | grep -E '^weekly-[0-9]{8}-[0-9]{6}\.tar\.zst$' | sort | head -n -8 | while read -r f; do rclone deletefile "$WEEKLY_REMOTE/$f"; done
fi
# 只保留最新两份压缩包(上传成功之后才清理)
rclone lsf "$REMOTE/" --files-only | grep -E '^briefing-[0-9]{8}-[0-9]{6}\.tar\.zst$' | sort | head -n -2 | while read -r f; do rclone deletefile "$REMOTE/$f"; done
echo "backup ok: briefing-$STAMP.tar.zst ($(du -h briefing-$STAMP.tar.zst | cut -f1)); text $(du -sh $TMP/text | cut -f1)"
