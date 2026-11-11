from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from telethon import TelegramClient, events, functions, utils
from telethon.errors import FloodWaitError, ServerError, SessionPasswordNeededError
from telethon.tl.types import Channel, Chat, ChatInviteAlready

USERNAME = re.compile(r"[A-Za-z0-9_]{5,32}")
URLISH = re.compile(r"https?://[^\s<>\"'，。；：！？、]+|(?<![@\w])(?:www\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})){1,}(?:/[^\s<>\"'，。；：！？、]*)?", re.IGNORECASE)
BARE_HOST = re.compile(r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{2,59})$", re.IGNORECASE)
MAX_IMAGE_BYTES = 10 * 1024 * 1024
RECENT_RECHECK = timedelta(hours=24)
FULL_RECHECK_SECONDS = 24 * 3600
# 断线、超时、限流、Telegram 服务端错误都会自行恢复，不能据此停用来源。
# 2026-09-29 一次断线让 reload() 把全部 17 个来源标成 error/enabled=0，采集静默停了 10 天。
TRANSIENT_ERRORS = (ConnectionError, OSError, asyncio.TimeoutError, FloodWaitError, ServerError)


# 进度信号：写给 supervisor 看门狗的管道（fd 由 TELEGRAM_PROGRESS_FD 指定）。
# supervisor 长时间收不到进度就强制结束本进程，由 systemd 重启（2026-11-07 断线后请求永不返回，采集停摆 10.5 小时）。
_progress_fd: int | None = None
_progress_at = 0.0


def init_progress() -> None:
    global _progress_fd
    raw = os.environ.get("TELEGRAM_PROGRESS_FD", "")
    if not raw.isdigit():
        return
    try:
        os.set_blocking(int(raw), False)
        _progress_fd = int(raw)
    except OSError:
        _progress_fd = None


def progress() -> None:
    """报告"仍在推进"。节流到每秒一次；管道满或不存在时静默忽略，绝不阻塞采集。"""
    global _progress_at
    if _progress_fd is None:
        return
    now = time.monotonic()
    if now - _progress_at < 1:
        return
    _progress_at = now
    with suppress(OSError):
        os.write(_progress_fd, b".")


def image_metadata(message) -> tuple[str, str, int | None] | None:
    """Return a stable fingerprint for photos and non-GIF image documents only."""
    photo = getattr(message, "photo", None)
    if photo is not None:
        sizes = [getattr(item, "size", 0) or 0 for item in getattr(photo, "sizes", ())]
        size = max(sizes, default=0) or None
        stable = f"photo:{getattr(photo, 'id', '')}:{size or ''}"
        return hashlib.sha256(stable.encode()).hexdigest(), "image/jpeg", size
    document = getattr(message, "document", None)
    if document is None:
        return None
    mime = str(getattr(document, "mime_type", "") or "").lower()
    attributes = {type(item).__name__ for item in getattr(document, "attributes", ())}
    if (re.fullmatch(r"image/[a-z0-9.+-]+", mime) is None or mime == "image/gif"
            or "DocumentAttributeAnimated" in attributes
            or "DocumentAttributeSticker" in attributes
            or bool(getattr(message, "gif", None))
            or bool(getattr(message, "sticker", None))):
        return None
    size = int(getattr(document, "size", 0) or 0) or None
    stable = f"document:{getattr(document, 'id', '')}:{size or ''}:{mime}"
    return hashlib.sha256(stable.encode()).hexdigest(), mime, size


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def extract_urls(text: str) -> tuple[str, ...]:
    result: list[str] = []
    for match in URLISH.finditer(text):
        raw = match.group(0).rstrip(".,;:!?，。；：！？、)]}》】'\"")
        explicit = raw.lower().startswith(("http://", "https://"))
        parsed = urlparse(raw if explicit else f"https://{raw}")
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            continue
        if not explicit and not BARE_HOST.fullmatch(parsed.hostname):
            continue
        host = parsed.hostname.lower()
        port = f":{parsed.port}" if parsed.port and not (parsed.scheme == "http" and parsed.port == 80) and not (parsed.scheme == "https" and parsed.port == 443) else ""
        normalized = f"{parsed.scheme.lower()}://{host}{port}{parsed.path or '/'}"
        if parsed.query:
            normalized += f"?{parsed.query}"
        if normalized not in result:
            result.append(normalized)
    return tuple(result)


def is_transient(exc: BaseException) -> bool:
    return isinstance(exc, TRANSIENT_ERRORS)


def catchup_options(last_id: int, keep_forever: bool, cutoff: datetime) -> dict:
    """增量补采的 iter_messages 参数。

    有 last_id 时按时间正序从断点往后读。消息永久保留时从断点读全，补齐停采期间的全部消息；
    否则直接从保留期起点开始，跳过反正会被清理的旧消息。
    """
    if not last_id:
        return {}
    options: dict = {"min_id": last_id, "reverse": True}
    if not keep_forever:
        options["offset_date"] = cutoff
    return options


def reference(raw: str) -> tuple[str, str | int]:
    value = raw.strip()
    if value.startswith("@") and USERNAME.fullmatch(value[1:]):
        return "public", value
    parsed = urlparse(value if "://" in value else f"https://{value}")
    if parsed.scheme not in {"http", "https"} or (parsed.hostname or "").lower() not in {"t.me", "www.t.me", "telegram.me", "www.telegram.me"}:
        raise ValueError("unsupported Telegram reference")
    pieces = [x for x in parsed.path.split("/") if x]
    if pieces and pieces[0].lower() == "s":
        pieces.pop(0)
    if len(pieces) == 3 and pieces[0].lower() == "c" and pieces[1].isdigit() and pieces[2].isdigit():
        return "private_message", -1_000_000_000_000 - int(pieces[1])
    if (len(pieces) == 1 and pieces[0].startswith("+")) or (len(pieces) == 2 and pieces[0].lower() == "joinchat"):
        token = pieces[0][1:] if pieces[0].startswith("+") else pieces[1]
        return "invite", token
    if len(pieces) == 1 and USERNAME.fullmatch(pieces[0]):
        return "public", f"@{pieces[0]}"
    raise ValueError("unsupported Telegram reference")


class Store:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=30000")
        self.db.execute("PRAGMA journal_mode=WAL")
        path.chmod(0o600)
        self.media_dir = Path(os.environ.get("TELEGRAM_MEDIA_DIR", str(path.parent / "telegram-media")))
        self.media_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.media_dir.chmod(0o700)

    def initialize(self) -> None:
        migrations = Path(__file__).parents[2] / "migrations"
        self.db.execute("CREATE TABLE IF NOT EXISTS telegram_schema_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT")
        for sql_path in sorted(migrations.glob("[0-9][0-9][0-9]_*.sql")):
            sql = sql_path.read_text(encoding="utf8")
            checksum = hashlib.sha256(sql.encode()).hexdigest()[:16]
            row = self.db.execute("SELECT checksum FROM telegram_schema_migrations WHERE name=?", (sql_path.name,)).fetchone()
            if row and row[0] != checksum:
                raise RuntimeError(f"applied Telegram migration changed: {sql_path.name}")
            if not row:
                self.apply_migration(sql_path.name, sql, checksum)

    def apply_migration(self, name: str, sql: str, checksum: str) -> None:
        """原子执行一个迁移：取得写锁后重新检查登记（另一个进程可能刚执行完），逐条执行 + 登记在同一事务里，失败整体回滚。"""
        self.db.commit()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            if self.db.execute("SELECT 1 FROM telegram_schema_migrations WHERE name=?", (name,)).fetchone():
                self.db.execute("ROLLBACK")
                return
            statement = ""
            for line in sql.splitlines(keepends=True):
                statement += line
                if sqlite3.complete_statement(statement):
                    if statement.strip():
                        self.db.execute(statement)
                    statement = ""
            if statement.strip():
                self.db.execute(statement)
            self.db.execute("INSERT OR REPLACE INTO telegram_schema_migrations VALUES(?,?,?)", (name, checksum, utc_now()))
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def worker_state(self, state: str, *, authorized: bool = False, hint: str | None = None, error: str | None = None) -> None:
        self.db.execute("UPDATE telegram_worker_state SET authorized=?,login_state=?,account_hint=?,last_error=?,heartbeat_at=?,updated_at=? WHERE singleton=1", (authorized, state, hint, error, utc_now(), utc_now()))
        self.db.commit()

    def heartbeat(self, authorized: bool) -> None:
        self.db.execute("UPDATE telegram_worker_state SET authorized=?,heartbeat_at=?,updated_at=? WHERE singleton=1", (authorized, utc_now(), utc_now()))
        self.db.commit()

    def pending(self):
        return self.db.execute("SELECT * FROM telegram_sources WHERE status='pending' ORDER BY validation_requested_at,id").fetchall()

    def enabled(self):
        # 全历史回填可能持续数分钟；优先续跑可避免被普通来源的删除校验长期阻塞。
        return self.db.execute("""SELECT * FROM telegram_sources
          WHERE status='active' AND enabled=1
          ORDER BY retain_all_history DESC,id""").fetchall()

    def resolved(self, row: sqlite3.Row, entity) -> None:
        chat_id = utils.get_peer_id(entity)
        kind = "group" if isinstance(entity, Chat) or getattr(entity, "megagroup", False) else "channel"
        title = str(getattr(entity, "title", chat_id))
        username = getattr(entity, "username", None)
        try:
            self.db.execute("UPDATE telegram_sources SET chat_id=?,title=?,username=?,telegram_kind=?,status='active',enabled=1,last_error=NULL,validated_at=?,updated_at=? WHERE id=?", (chat_id, title, username, kind, utc_now(), utc_now(), row["id"]))
            self.db.execute("INSERT OR IGNORE INTO telegram_sync_state(source_id) VALUES(?)", (row["id"],))
            self.db.commit()
        except sqlite3.IntegrityError:
            self.db.rollback()
            self.failed(row["id"], "该 Telegram chat_id 已存在，不能重复添加")

    def attempt(self, source_id: int, ok: bool | None, covered_until: str | None = None) -> None:
        """记录同步尝试：ok=None 表示开始（进行中），True/False 为结束结果；成功时可同时发布覆盖水位。
        汇总据此区分「来源自身故障」（明确失败）与「还没轮到 / 正在恢复」（进行中、从未尝试）。"""
        okv = None if ok is None else (1 if ok else 0)
        self.db.execute("""INSERT INTO telegram_sync_progress(source_id,covered_until,last_attempt_at,last_attempt_ok) VALUES(?,?,?,?)
          ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_attempt_ok=excluded.last_attempt_ok,
          covered_until=coalesce(excluded.covered_until,telegram_sync_progress.covered_until)""", (source_id, covered_until, utc_now(), okv))
        self.db.commit()

    def cover(self, source_id: int, covered_until: str) -> None:
        """发布覆盖水位：covered_until 之前发出的消息都已采到（ensureDueJobs 按它推进窗口）。不改动尝试状态。"""
        self.db.execute("""INSERT INTO telegram_sync_progress(source_id,covered_until) VALUES(?,?)
          ON CONFLICT(source_id) DO UPDATE SET covered_until=excluded.covered_until""", (source_id, covered_until))
        self.db.commit()

    def transient_failure(self, source_id: int, message: str) -> None:
        """只记录错误，保持来源启用，下一轮 reconcile 自动重试。"""
        self.db.execute("UPDATE telegram_sources SET last_error=?,updated_at=? WHERE id=?", (message[:500], utc_now(), source_id))
        self.db.commit()

    def failed(self, source_id: int, message: str) -> None:
        self.db.execute("UPDATE telegram_sources SET status='error',enabled=0,last_error=?,updated_at=? WHERE id=?", (message[:500], utc_now(), source_id))
        self.db.commit()

    def save_normal(self, source: sqlite3.Row, message, *, advance_cursor: bool = True) -> None:
        """advance_cursor=False 用于实时事件：只落库，不推进补采游标（见 Worker.on_message）。"""
        text = str(getattr(message, "message", "") or "")
        if not text.strip() and image_metadata(message) is None:
            return
        sent = utc(message.date); edited = utc(message.edit_date) if message.edit_date else None
        digest = hashlib.sha256(text.encode()).hexdigest()
        link = f"https://t.me/{source['username']}/{message.id}" if source["username"] else None
        now = utc_now()
        with self.db:
            self.db.execute("""INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,edited_at,reply_to_id,source_url,content_hash,collected_at,deleted_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(chat_id,message_id) DO UPDATE SET text=excluded.text,edited_at=excluded.edited_at,reply_to_id=excluded.reply_to_id,source_url=excluded.source_url,content_hash=excluded.content_hash,collected_at=excluded.collected_at,deleted_at=NULL""",
              (source["id"], source["chat_id"], message.id, sent, text, edited, getattr(message,"reply_to_msg_id",None), link, digest, now))
            self.db.execute("INSERT OR IGNORE INTO telegram_message_versions(chat_id,message_id,content_hash,text,edited_at,collected_at) VALUES(?,?,?,?,?,?)", (source["chat_id"],message.id,digest,text,edited,now))
            if advance_cursor:
                self.db.execute("UPDATE telegram_sync_state SET last_message_id=max(last_message_id,?),last_synced_at=?,last_error=NULL WHERE source_id=?", (message.id,now,source["id"]))

    def save_normal_batch(self, source: sqlite3.Row, messages: list) -> int:
        now = utc_now()
        rows: list[tuple] = []
        versions: list[tuple] = []
        max_id = 0
        for message in messages:
            max_id = max(max_id, int(message.id))
            text = str(getattr(message, "message", "") or "")
            if not text.strip() and image_metadata(message) is None:
                continue
            sent = utc(message.date)
            edited = utc(message.edit_date) if message.edit_date else None
            digest = hashlib.sha256(text.encode()).hexdigest()
            link = f"https://t.me/{source['username']}/{message.id}" if source["username"] else None
            rows.append((source["id"], source["chat_id"], message.id, sent, text, edited,
                         getattr(message, "reply_to_msg_id", None), link, digest, now))
            versions.append((source["chat_id"], message.id, digest, text, edited, now))
        with self.db:
            self.db.executemany("""INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,edited_at,reply_to_id,source_url,content_hash,collected_at,deleted_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(chat_id,message_id) DO UPDATE SET text=excluded.text,edited_at=excluded.edited_at,
              reply_to_id=excluded.reply_to_id,source_url=excluded.source_url,content_hash=excluded.content_hash,collected_at=excluded.collected_at,deleted_at=NULL""", rows)
            self.db.executemany("INSERT OR IGNORE INTO telegram_message_versions(chat_id,message_id,content_hash,text,edited_at,collected_at) VALUES(?,?,?,?,?,?)", versions)
            if max_id:
                self.db.execute("UPDATE telegram_sync_state SET last_message_id=max(last_message_id,?),last_synced_at=?,last_error=NULL WHERE source_id=?",
                                (max_id, now, source["id"]))
        return len(rows)

    def vision_enabled_at(self) -> datetime:
        value = self.db.execute(
            "SELECT vision_enabled_at FROM telegram_settings WHERE singleton=1"
        ).fetchone()[0]
        return datetime.fromisoformat(str(value))

    def media_task(self, source: sqlite3.Row, message, metadata: tuple[str, str, int | None]):
        fingerprint, mime, declared_size = metadata
        row = self.db.execute("""SELECT * FROM telegram_media_tasks
          WHERE chat_id=? AND message_id=? AND media_fingerprint=?""",
          (source["chat_id"], message.id, fingerprint)).fetchone()
        if row:
            stale_download = row["status"] == "downloading" and (
                datetime.now(UTC) - datetime.fromisoformat(row["updated_at"])
            ) >= timedelta(minutes=5)
            retry_download = row["status"] == "failed" and row["error_type"] == "download_error"
            if not stale_download and not retry_download:
                return None
        now = utc_now()
        caption = str(getattr(message, "message", "") or "")
        stale_path = row["temp_path"] if row else None
        previous = self.db.execute("""SELECT id,temp_path FROM telegram_media_tasks
          WHERE chat_id=? AND message_id=? AND media_fingerprint<>? AND superseded_at IS NULL""",
          (source["chat_id"], message.id, fingerprint)).fetchall()
        if declared_size is not None and declared_size > MAX_IMAGE_BYTES:
            with self.db:
                self.db.execute("""UPDATE telegram_media_tasks SET superseded_at=?,updated_at=?,temp_path=NULL,
                  temp_state='deleted',status=CASE WHEN status='completed' THEN status ELSE 'skipped' END,
                  error_type=coalesce(error_type,'media_replaced')
                  WHERE chat_id=? AND message_id=? AND media_fingerprint<>? AND superseded_at IS NULL""",
                  (now, now, source["chat_id"], message.id, fingerprint))
                self.db.execute("""INSERT INTO telegram_media_tasks
                  (source_id,chat_id,message_id,media_fingerprint,mime_type,original_caption,
                   telegram_size_bytes,temp_state,status,error_type,error_message,created_at,updated_at,completed_at)
                  VALUES(?,?,?,?,?,?,?,'absent','skipped','too_large','Telegram reported image larger than 10 MiB',?,?,?)
                  ON CONFLICT(chat_id,message_id,media_fingerprint) DO UPDATE SET
                    status='skipped',temp_path=NULL,temp_state='deleted',error_type='too_large',
                    error_message=excluded.error_message,updated_at=excluded.updated_at,completed_at=excluded.completed_at""",
                  (source["id"], source["chat_id"], message.id, fingerprint, mime, caption,
                   declared_size, now, now, now))
            for old in previous:
                self.delete_media(old["temp_path"])
            self.delete_media(stale_path)
            return None
        # Telethon appends an extension when the target filename has none.  That
        # would make the subsequent size check look at a non-existent path
        # (while leaving the real .jpg/.png file behind).  Include a sanitized
        # MIME-derived suffix so Telethon writes exactly the path we track.
        suffix = re.sub(r"[^a-z0-9]", "", mime.rsplit("/", 1)[-1].lower())[:12] or "img"
        filename = f"{secrets.token_urlsafe(24)}.{suffix}"
        path = self.media_dir / filename
        with self.db:
            self.db.execute("""UPDATE telegram_media_tasks SET superseded_at=?,updated_at=?,temp_path=NULL,
              temp_state='deleted',status=CASE WHEN status='completed' THEN status ELSE 'skipped' END,
              error_type=coalesce(error_type,'media_replaced')
              WHERE chat_id=? AND message_id=? AND media_fingerprint<>? AND superseded_at IS NULL""",
              (now, now, source["chat_id"], message.id, fingerprint))
            self.db.execute("""INSERT INTO telegram_media_tasks
              (source_id,chat_id,message_id,media_fingerprint,mime_type,original_caption,
               telegram_size_bytes,temp_path,temp_state,status,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?, 'downloading','downloading',?,?)
              ON CONFLICT(chat_id,message_id,media_fingerprint) DO UPDATE SET
                temp_path=excluded.temp_path,temp_state='downloading',status='downloading',
                error_type=NULL,error_message=NULL,updated_at=excluded.updated_at""",
              (source["id"], source["chat_id"], message.id, fingerprint, mime, caption,
               declared_size, str(path), now, now))
        for old in previous:
            self.delete_media(old["temp_path"])
        self.delete_media(stale_path)
        return fingerprint, path

    def delete_media(self, value: str | None) -> None:
        if not value:
            return
        try:
            path = Path(value).resolve()
            path.relative_to(self.media_dir.resolve())
            path.unlink(missing_ok=True)
        except (OSError, ValueError):
            return

    def media_ready(self, source: sqlite3.Row, message_id: int, fingerprint: str, size: int) -> None:
        with self.db:
            self.db.execute("""UPDATE telegram_media_tasks
              SET actual_size_bytes=?,temp_state='ready',status='pending',error_type=NULL,
                  error_message=NULL,next_attempt_at=NULL,updated_at=?
              WHERE chat_id=? AND message_id=? AND media_fingerprint=?""",
              (size, utc_now(), source["chat_id"], message_id, fingerprint))

    def media_download_failed(self, source: sqlite3.Row, message_id: int, fingerprint: str,
                              error_type: str, message: str) -> None:
        now = utc_now()
        with self.db:
            self.db.execute("""UPDATE telegram_media_tasks
              SET temp_path=NULL,temp_state='deleted',status='failed',error_type=?,error_message=?,updated_at=?,
                  completed_at=CASE WHEN ?='download_error' THEN NULL ELSE ? END
              WHERE chat_id=? AND message_id=? AND media_fingerprint=?""",
              (error_type, message[:500], now, error_type, now, source["chat_id"], message_id, fingerprint))

    def supersede_removed_media(self, source: sqlite3.Row, message_id: int) -> None:
        now = utc_now()
        rows = self.db.execute("""SELECT temp_path FROM telegram_media_tasks
          WHERE chat_id=? AND message_id=? AND superseded_at IS NULL""",
          (source["chat_id"], message_id)).fetchall()
        with self.db:
            self.db.execute("""UPDATE telegram_media_tasks SET superseded_at=?,updated_at=?,temp_path=NULL,
              temp_state='deleted',status=CASE WHEN status='completed' THEN status ELSE 'skipped' END,
              error_type=coalesce(error_type,'media_removed')
              WHERE chat_id=? AND message_id=? AND superseded_at IS NULL""",
              (now, now, source["chat_id"], message_id))
        for row in rows:
            self.delete_media(row["temp_path"])

    def save_urls(self, source: sqlite3.Row, message, *, advance_cursor: bool = True) -> None:
        # Deliberately do not persist message, sender, bio, link, or media metadata.
        urls = extract_urls(str(getattr(message, "message", "") or ""))
        found = utc_now()
        days = int(self.db.execute("SELECT url_retention_days FROM telegram_settings WHERE singleton=1").fetchone()[0])
        expires = (datetime.now(UTC) + timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.db:
            for url in urls:
                self.db.execute("""INSERT INTO telegram_urls(normalized_url,first_source_id,last_source_id,first_discovered_at,last_discovered_at,expires_at)
                  VALUES(?,?,?,?,?,?) ON CONFLICT(normalized_url) DO UPDATE SET last_source_id=excluded.last_source_id,last_discovered_at=excluded.last_discovered_at,expires_at=excluded.expires_at""",
                  (url,source["id"],source["id"],found,found,expires))
            if advance_cursor:
                self.db.execute("UPDATE telegram_sync_state SET last_message_id=max(last_message_id,?),last_synced_at=?,last_error=NULL WHERE source_id=?", (message.id,found,source["id"]))

    def delete_normal(self, chat_id: int, ids: list[int]) -> None:
        if not ids:
            return
        keep = self.db.execute(
            "SELECT keep_messages_forever FROM telegram_settings WHERE singleton=1"
        ).fetchone()
        if keep and bool(keep[0]):
            return
        placeholders = ",".join("?" for _ in ids)
        media = self.db.execute(f"""SELECT temp_path FROM telegram_media_tasks
          WHERE chat_id=? AND message_id IN ({placeholders}) AND superseded_at IS NULL""",
          (chat_id, *ids)).fetchall()
        now = utc_now()
        with self.db:
            self.db.executemany("UPDATE telegram_messages SET deleted_at=? WHERE chat_id=? AND message_id=?", [(now,chat_id,x) for x in ids])
            self.db.execute(f"""UPDATE telegram_media_tasks SET status=CASE WHEN status='completed' THEN status ELSE 'skipped' END,
              superseded_at=?,temp_path=NULL,temp_state='deleted',error_type=coalesce(error_type,'message_deleted'),updated_at=?
              WHERE chat_id=? AND message_id IN ({placeholders}) AND superseded_at IS NULL""",
              (now, now, chat_id, *ids))
        for row in media:
            self.delete_media(row["temp_path"])


class Worker:
    def __init__(self, store: Store, client: TelegramClient, socket_path: Path):
        self.store, self.client, self.socket_path = store, client, socket_path
        self.entities: dict[int, object] = {}
        self.phone = os.environ.get("TELEGRAM_PHONE", "")
        # 每个来源上次完成「保留期全量复查」的时刻（单调时钟；进程重启后第一轮做一次全量）
        self.full_recheck_at: dict[int, float] = {}

    @staticmethod
    def is_full_history(row: sqlite3.Row) -> bool:
        return bool(row["retain_all_history"])

    async def backfill_all_history(self, row: sqlite3.Row, entity) -> None:
        state = self.store.db.execute(
            "SELECT * FROM telegram_history_backfills WHERE source_id=?", (row["id"],)
        ).fetchone()
        if state and state["completed_at"]:
            return
        if not state:
            now = utc_now()
            self.store.db.execute("""INSERT INTO telegram_history_backfills
              (source_id,next_offset_id,messages_seen,started_at,updated_at)
              VALUES(?,0,0,?,?)""", (row["id"], now, now))
            self.store.db.commit()
            offset_id, seen = 0, 0
        else:
            if not state["started_at"]:
                self.store.db.execute(
                    "UPDATE telegram_history_backfills SET started_at=? WHERE source_id=?",
                    (utc_now(), row["id"]),
                )
                self.store.db.commit()
            offset_id, seen = int(state["next_offset_id"]), int(state["messages_seen"])

        # Telethon 对 limit>3000 默认每次 GetHistory 等 1 秒；历史回填采用
        # 保守的 5 req/s，并保留服务端 FloodWait 自动退避。
        options = {"wait_time": 0.2, **({"offset_id": offset_id} if offset_id else {})}
        try:
            batch: list = []
            last_id = offset_id
            async for message in self.client.iter_messages(entity, **options):
                batch.append(message)
                last_id = int(message.id)
                seen += 1
                progress()
                if len(batch) < 500:
                    continue
                if row["source_type"] == "normal":
                    self.store.save_normal_batch(row, batch)
                else:
                    for item in batch: self.store.save_urls(row, item)
                batch.clear()
                self.store.db.execute("""UPDATE telegram_history_backfills SET
                  next_offset_id=?,messages_seen=?,updated_at=?,last_error=NULL WHERE source_id=?""",
                  (last_id, seen, utc_now(), row["id"]))
                self.store.db.commit()
                if seen % 5000 == 0:
                    print(f"历史回填 来源#{row['id']}: 已扫描 {seen} 条，message_id={last_id}", flush=True)
            if batch:
                if row["source_type"] == "normal":
                    self.store.save_normal_batch(row, batch)
                else:
                    for item in batch: self.store.save_urls(row, item)
            now = utc_now()
            self.store.db.execute("""UPDATE telegram_history_backfills SET
              next_offset_id=0,messages_seen=?,updated_at=?,completed_at=?,last_error=NULL
              WHERE source_id=?""", (seen, now, now, row["id"]))
            self.store.db.commit()
            print(f"历史回填完成 来源#{row['id']}: 共扫描 {seen} 条", flush=True)
        except Exception as exc:
            self.store.db.execute("UPDATE telegram_history_backfills SET updated_at=?,last_error=? WHERE source_id=?",
                                  (utc_now(), type(exc).__name__, row["id"]))
            self.store.db.commit()
            raise

    async def resolve(self, row: sqlite3.Row):
        kind, value = reference(row["reference"])
        if kind == "invite":
            checked = await self.client(functions.messages.CheckChatInviteRequest(value))
            if not isinstance(checked, ChatInviteAlready):
                raise ValueError("邀请链接对应群组尚未加入；系统不会自动加入")
            return checked.chat
        if kind == "private_message":
            for dialog in await self.client.get_dialogs():
                if utils.get_peer_id(dialog.entity) == value:
                    return dialog.entity
            raise ValueError("私群消息链接对应群组尚未加入；系统不会自动加入")
        return await self.client.get_entity(value)

    async def validate_pending(self) -> None:
        for row in self.store.pending():
            try:
                entity = await self.resolve(row)
                if not isinstance(entity, (Channel, Chat)):
                    raise TypeError("地址不是群组或频道")
                self.store.resolved(row, entity)
            except Exception as exc:  # noqa: BLE001 - isolate source validation failures
                if is_transient(exc):
                    self.store.transient_failure(row["id"], f"校验暂时失败，下轮重试：{type(exc).__name__}")
                else:
                    self.store.failed(row["id"], str(exc) or type(exc).__name__)
            progress()

    async def reload(self) -> None:
        self.entities = {}
        for row in self.store.enabled():
            try:
                self.entities[row["chat_id"]] = await self.client.get_entity(row["chat_id"])
            except Exception as exc:  # noqa: BLE001 - isolate source resolution failures
                if is_transient(exc):
                    self.store.transient_failure(row["id"], f"来源解析暂时失败，下轮重试：{type(exc).__name__}")
                else:
                    self.store.failed(row["id"], f"来源解析失败：{type(exc).__name__}")
            progress()

    async def backfill_source(self, row: sqlite3.Row, entity) -> None:
        settings = self.store.db.execute("SELECT timezone,raw_retention_days,keep_messages_forever FROM telegram_settings WHERE singleton=1").fetchone()
        zone = ZoneInfo(settings["timezone"])
        local_now = datetime.now(UTC).astimezone(zone)
        cutoff_local = datetime.combine(local_now.date() - timedelta(days=int(settings["raw_retention_days"]) - 1), datetime.min.time(), zone)
        cutoff = cutoff_local.astimezone(UTC)
        state = self.store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (row["id"],)).fetchone()
        last_id = int(state[0]) if state else 0
        keep_forever = bool(settings["keep_messages_forever"])
        # 首次同步按时间倒序读取：中途中断时若已逐条推进游标，下一轮会从已存最大 ID 正序续读，
        # 更早的消息就永久漏采。因此首次同步期间不推进游标，整轮完成后一次性设置。
        first_sync = not last_id
        max_seen = 0
        # 覆盖水位保守取本轮扫描开始时刻：扫描期间才到达的消息不一定都被读到
        scan_started = utc_now()
        # 标记本轮进行中：上一轮的失败记录失效，汇总不会把正在恢复的来源当成故障来源跳过
        self.store.attempt(row["id"], None)
        skipped_max = skipped = 0
        async for message in self.client.iter_messages(entity, **catchup_options(last_id, keep_forever, cutoff)):
            progress()   # 在日期过滤之前报告：长时间扫过过期历史也算进度，避免被看门狗误杀
            date = message.date if message.date.tzinfo else message.date.replace(tzinfo=UTC)
            if date < cutoff and not (last_id and keep_forever):
                # 正序补采时最早的消息先到，遇到旧消息只能跳过；原来的 break 会让断点超过保留期的来源一条都补不回来
                if last_id:
                    # 增量（正序）扫描跳过的过期消息本来就不保存，可以安全推进游标，避免每次重启都从同一处重扫
                    skipped_max = max(skipped_max, int(message.id))
                    skipped += 1
                    if skipped % 500 == 0:
                        self.store.db.execute("UPDATE telegram_sync_state SET last_message_id=max(last_message_id,?) WHERE source_id=?", (skipped_max, row["id"]))
                        self.store.db.commit()
                    continue
                break  # 首次同步按时间倒序，越过保留期即可停止
            max_seen = max(max_seen, int(message.id))
            if row["source_type"] == "url":
                self.store.save_urls(row, message, advance_cursor=not first_sync)
            else:
                self.store.save_normal(row, message, advance_cursor=not first_sync)
                await self.capture_image(row, message, report=True)
        if skipped_max:
            self.store.db.execute("UPDATE telegram_sync_state SET last_message_id=max(last_message_id,?) WHERE source_id=?", (skipped_max, row["id"]))
        if first_sync and max_seen:
            self.store.db.execute("UPDATE telegram_sync_state SET last_message_id=max(last_message_id,?),last_synced_at=?,last_error=NULL WHERE source_id=?",
                                  (max_seen, utc_now(), row["id"]))
        self.store.db.commit()
        # 新消息读完即发布覆盖水位：此前发出的消息都已入库。保留期复查只负责同步之后的编辑，不能挡住总结
        # （2026-11-08：大群每轮全量复查 3 万条要一个多小时，覆盖水位等复查结束才发布，Telegram 总结赶不上 08:00 日报）。
        self.store.cover(row["id"], scan_started)
        retry_ids = [int(item[0]) for item in self.store.db.execute("""SELECT message_id
          FROM telegram_media_tasks WHERE source_id=? AND
          (status='downloading' OR (status='failed' AND error_type='download_error'))
          AND superseded_at IS NULL ORDER BY message_id LIMIT 100""", (row["id"],)).fetchall()]
        if retry_ids:
            for message in await self.client.get_messages(entity, ids=retry_ids):
                if message is not None:
                    await self.capture_image(row, message, report=True)
                    progress()
        if self.is_full_history(row):
            await self.backfill_all_history(row, entity)
        if row["source_type"] == "normal" and not self.is_full_history(row):
            # 每轮只复查最近 24 小时；保留期全量复查每 24 小时一次（大群全量复查每轮要数十次请求）
            full_due = time.monotonic() - self.full_recheck_at.get(row["id"], float("-inf")) >= FULL_RECHECK_SECONDS
            since = cutoff if full_due else max(cutoff, datetime.now(UTC) - RECENT_RECHECK)
            retained = [int(item[0]) for item in self.store.db.execute("SELECT message_id FROM telegram_messages WHERE source_id=? AND sent_at>=? AND deleted_at IS NULL ORDER BY message_id", (row["id"], utc(since))).fetchall()]
            for offset in range(0, len(retained), 500):
                requested = retained[offset:offset + 500]
                current = await self.client.get_messages(entity, ids=requested)
                progress()
                returned: set[int] = set()
                for message in current:
                    if message is not None:
                        returned.add(int(message.id))
                        # 复查读的是库里已有的 ID，不是连续历史，不能推进补采游标（否则会跳过实时事件漏掉的消息）
                        self.store.save_normal(row, message, advance_cursor=False)
                        await self.capture_image(row, message, report=True)
                        progress()
                self.store.delete_normal(row["chat_id"], [item for item in requested if item not in returned])
            if full_due:
                self.full_recheck_at[row["id"]] = time.monotonic()
        self.store.db.execute("UPDATE telegram_sources SET last_success_at=?,last_error=NULL,updated_at=? WHERE id=?",(utc_now(),utc_now(),row["id"]))
        self.store.db.commit()
        self.store.attempt(row["id"], True)

    async def reconcile(self) -> None:
        await self.validate_pending()
        await self.reload()
        for row in self.store.enabled():
            entity = self.entities.get(row["chat_id"])
            if entity is None:
                self.store.attempt(row["id"], False)   # 本轮解析失败，没法同步
                continue
            try:
                await self.backfill_source(row, entity)
            except Exception as exc:  # noqa: BLE001 - one source must not block others
                self.store.db.execute("UPDATE telegram_sources SET last_error=?,updated_at=? WHERE id=?",(f"同步失败：{type(exc).__name__}",utc_now(),row["id"]))
                self.store.db.commit()
                self.store.attempt(row["id"], False)
            progress()

    async def on_message(self, event) -> None:
        source = self.store.db.execute("SELECT * FROM telegram_sources WHERE chat_id=? AND enabled=1 AND status='active'",(event.chat_id,)).fetchone()
        if source:
            # 实时事件不推进补采游标：采集器重启后事件处理先于 reconcile 生效，活跃群的新消息
            # 会把 last_message_id 推到最新，补采随后从最新处开始，停机期间的消息就永远补不回来
            # （2026-10-09 @wantwantgroup 漏了约 6500 条）。游标只由 backfill_source 推进。
            if source["source_type"] == "url":
                self.store.save_urls(source, event.message, advance_cursor=False)
            else:
                self.store.save_normal(source, event.message, advance_cursor=False)
                await self.capture_image(source, event.message)

    async def capture_image(self, source: sqlite3.Row, message, *, report: bool = False) -> None:
        """report=True 只用于补采路径：下载过程中按进度报告给看门狗；实时事件路径不报告，以免掩盖补采卡死。"""
        metadata = image_metadata(message)
        if metadata is None:
            self.store.supersede_removed_media(source, message.id)
            return
        sent = message.date if message.date.tzinfo else message.date.replace(tzinfo=UTC)
        if sent.astimezone(UTC) < self.store.vision_enabled_at():
            return
        pending = self.store.media_task(source, message, metadata)
        if pending is None:
            return
        fingerprint, path = pending
        try:
            await message.download_media(file=str(path), progress_callback=(lambda *_: progress()) if report else None)
            size = path.stat().st_size
            if size <= 0:
                raise ValueError("empty image")
            if size > MAX_IMAGE_BYTES:
                path.unlink(missing_ok=True)
                self.store.media_download_failed(source, message.id, fingerprint, "too_large",
                                                 "Downloaded image larger than 10 MiB")
                return
            path.chmod(0o600)
            self.store.media_ready(source, message.id, fingerprint, size)
        except Exception as exc:  # noqa: BLE001 - reconnect reconciliation retries downloads
            with suppress(OSError): path.unlink()
            self.store.media_download_failed(source, message.id, fingerprint, "download_error",
                                             type(exc).__name__)

    async def on_delete(self, event) -> None:
        if event.chat_id is not None:
            source=self.store.db.execute("SELECT source_type FROM telegram_sources WHERE chat_id=?",(event.chat_id,)).fetchone()
            if source and source[0] == "normal":
                self.store.delete_normal(event.chat_id,list(event.deleted_ids))

    async def login_request(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        response: dict[str, object]
        try:
            raw = await asyncio.wait_for(reader.readline(),10)
            obj = json.loads(raw[:8192]); command = obj.get("command"); value = str(obj.get("value", ""))
            if command == "start":
                if await self.client.is_user_authorized():
                    me=await self.client.get_me(); self.store.worker_state("authorized",authorized=True,hint=str(getattr(me,"id","")))
                    response={"ok":True,"state":"authorized"}
                elif not self.phone:
                    response={"ok":False,"error":"未配置 Telegram 手机号"}
                else:
                    await self.client.send_code_request(self.phone); self.store.worker_state("code_required")
                    response={"ok":True,"state":"code_required"}
            elif command == "code":
                try:
                    await self.client.sign_in(self.phone,value)
                    self.store.worker_state("authorized",authorized=True); response={"ok":True,"state":"authorized"}
                except SessionPasswordNeededError:
                    self.store.worker_state("password_required"); response={"ok":True,"state":"password_required"}
            elif command == "password":
                await self.client.sign_in(password=value); self.store.worker_state("authorized",authorized=True); response={"ok":True,"state":"authorized"}
            else:
                response={"ok":False,"error":"未知登录命令"}
            value = ""  # minimize lifetime of sensitive input
        except Exception as exc:  # noqa: BLE001 - return a redacted login failure
            self.store.worker_state("error",error=type(exc).__name__)
            response={"ok":False,"error":"Telegram 登录失败，请检查输入或 worker 日志中的错误类型"}
        writer.write((json.dumps(response,ensure_ascii=False)+"\n").encode()); await writer.drain(); writer.close(); await writer.wait_closed()

    async def run(self) -> None:
        await self.client.connect()
        authorized=await self.client.is_user_authorized()
        self.store.worker_state("authorized" if authorized else "idle",authorized=authorized)
        self.socket_path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.socket_path.unlink(missing_ok=True)
        server=await asyncio.start_unix_server(self.login_request,path=self.socket_path)
        self.socket_path.chmod(0o600)
        self.client.add_event_handler(self.on_message,events.NewMessage())
        self.client.add_event_handler(self.on_message,events.MessageEdited())
        self.client.add_event_handler(self.on_delete,events.MessageDeleted())
        try:
            while True:
                progress()
                if await self.client.is_user_authorized():
                    await self.reconcile()
                self.store.heartbeat(await self.client.is_user_authorized())
                progress()
                await asyncio.sleep(300)
        finally:
            server.close(); await server.wait_closed(); self.socket_path.unlink(missing_ok=True); await self.client.disconnect()


async def async_main() -> None:
    init_progress()
    api_id = int(os.environ["TELEGRAM_API_ID"])
    api_hash = os.environ["TELEGRAM_API_HASH"]
    db_path = Path(os.environ.get("TELEGRAM_DATABASE_PATH", "./data/telegram.sqlite3"))
    session = Path(os.environ.get("TELEGRAM_SESSION_PATH", "./data/telegram"))
    session.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    store=Store(db_path); store.initialize()
    client=TelegramClient(str(session),api_id,api_hash)
    try:
        await Worker(store,client,Path(os.environ.get("TELEGRAM_LOGIN_SOCKET","./data/telegram-login.sock"))).run()
    finally:
        for path in session.parent.glob(session.name+".session*"):
            with suppress(OSError): path.chmod(0o600)


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
