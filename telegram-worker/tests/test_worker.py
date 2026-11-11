import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from briefing_telegram.worker import (
    MAX_IMAGE_BYTES,
    Store,
    Worker,
    catchup_options,
    extract_urls,
    image_metadata,
    is_transient,
    reference,
)


def test_reference_formats_and_no_join_action():
    assert reference("@Hezu1") == ("public", "@Hezu1")
    assert reference("https://t.me/s/hezu1") == ("public", "@hezu1")
    assert reference("t.me/c/123/9") == ("private_message", -1000000000123)
    assert reference("https://t.me/+invite")[0] == "invite"


def test_url_extraction_excludes_prices_and_normalizes():
    assert extract_urls("0.85 11.30 Example.COM/a https://EXAMPLE.com:443/a#x") == ("https://example.com/a",)


def test_url_source_never_persists_message_content(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    now = datetime.now(UTC).isoformat()
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES('@urlchan','url',-1001,'active',1,?,?,?)""", (now, now, now)).lastrowid
    store.db.execute("INSERT INTO telegram_sync_state(source_id) VALUES(?)", (source_id,))
    store.db.commit()
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    message = SimpleNamespace(id=9, message="private text https://example.com/x", date=datetime.now(UTC))
    store.save_urls(row, message)
    assert store.db.execute("SELECT count(*) FROM telegram_messages").fetchone()[0] == 0
    assert store.db.execute("SELECT normalized_url FROM telegram_urls").fetchone()[0] == "https://example.com/x"
    assert store.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_keep_messages_forever_ignores_telegram_deletion(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    now = datetime.now(UTC).isoformat()
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES('@keepall','normal',-1002,'active',1,?,?,?)""", (now, now, now)).lastrowid
    store.db.execute("""INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at)
      VALUES(?,-1002,10,?,'keep me','hash',?)""", (source_id, now, now))
    store.db.execute("UPDATE telegram_settings SET keep_messages_forever=1 WHERE singleton=1")
    store.db.commit()
    store.delete_normal(-1002, [10])
    assert store.db.execute(
        "SELECT deleted_at FROM telegram_messages WHERE chat_id=-1002 AND message_id=10"
    ).fetchone()[0] is None


def test_image_types_and_pure_image_message_are_queued(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    now = datetime.now(UTC)
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES('@images','normal',-1003,'active',1,?,?,?)""", (now.isoformat(), now.isoformat(), now.isoformat())).lastrowid
    store.db.execute("INSERT INTO telegram_sync_state(source_id) VALUES(?)", (source_id,))
    store.db.commit()
    source = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    photo = SimpleNamespace(id=1, message="", date=now, edit_date=None, reply_to_msg_id=None,
                            photo=SimpleNamespace(id=99, sizes=[SimpleNamespace(size=1024)]), document=None)
    meta = image_metadata(photo)
    assert meta and meta[1] == "image/jpeg"
    store.save_normal(source, photo)
    pending = store.media_task(source, photo, meta)
    assert pending is not None
    assert pending[1].suffix == ".jpeg"
    assert store.db.execute("SELECT text FROM telegram_messages WHERE message_id=1").fetchone()[0] == ""
    assert store.db.execute("SELECT status FROM telegram_media_tasks WHERE message_id=1").fetchone()[0] == "downloading"

    animated = SimpleNamespace(photo=None, document=SimpleNamespace(id=2, size=1, mime_type="image/gif", attributes=[]), gif=True, sticker=None)
    sticker = SimpleNamespace(photo=None, document=SimpleNamespace(id=3, size=1, mime_type="image/webp",
                              attributes=[type("DocumentAttributeSticker", (), {})()]), gif=None, sticker=True)
    video = SimpleNamespace(photo=None, document=SimpleNamespace(id=4, size=1, mime_type="video/mp4", attributes=[]), gif=None, sticker=None)
    assert image_metadata(animated) is None
    assert image_metadata(sticker) is None
    assert image_metadata(video) is None


def test_image_size_boundary_and_url_source_isolation(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    now = datetime.now(UTC)
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES('@normal','normal',-1004,'active',1,?,?,?)""", (now.isoformat(), now.isoformat(), now.isoformat())).lastrowid
    store.db.execute("INSERT INTO telegram_sync_state(source_id) VALUES(?)", (source_id,))
    store.db.commit()
    source = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    exact = SimpleNamespace(id=2, message="caption", date=now, edit_date=None, reply_to_msg_id=None, photo=None,
                            document=SimpleNamespace(id=20, size=MAX_IMAGE_BYTES, mime_type="image/png", attributes=[]), gif=None, sticker=None)
    too_big = SimpleNamespace(id=3, message="caption", date=now, edit_date=None, reply_to_msg_id=None, photo=None,
                              document=SimpleNamespace(id=21, size=MAX_IMAGE_BYTES + 1, mime_type="image/png", attributes=[]), gif=None, sticker=None)
    store.save_normal(source, exact)
    exact_meta = image_metadata(exact)
    assert exact_meta is not None
    assert store.media_task(source, exact, exact_meta) is not None
    store.save_normal(source, too_big)
    too_big_meta = image_metadata(too_big)
    assert too_big_meta is not None
    assert store.media_task(source, too_big, too_big_meta) is None
    task = store.db.execute("SELECT status,error_type,temp_path FROM telegram_media_tasks WHERE message_id=3").fetchone()
    assert tuple(task) == ("skipped", "too_large", None)


def _active_source(store: Store, chat_id: int, ref: str) -> int:
    now = datetime.now(UTC).isoformat()
    source_id = store.db.execute("""INSERT INTO telegram_sources(reference,source_type,chat_id,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES(?,'normal',?,'active',1,?,?,?)""", (ref, chat_id, now, now, now)).lastrowid
    store.db.execute("INSERT INTO telegram_sync_state(source_id) VALUES(?)", (source_id,))
    store.db.commit()
    assert source_id is not None
    return source_id


class FakeClient:
    def __init__(self, messages=(), entity_error: Exception | None = None):
        self.messages = list(messages)
        self.entity_error = entity_error
        self.calls: list[dict] = []

    async def get_entity(self, chat_id):
        if self.entity_error:
            raise self.entity_error
        return SimpleNamespace(id=chat_id)

    async def iter_messages(self, entity, **options):
        self.calls.append(options)
        found = [m for m in self.messages if m.id > options.get("min_id", 0)]
        for message in sorted(found, key=lambda m: m.id, reverse=not options.get("reverse")):
            yield message

    async def get_messages(self, entity, ids):
        return [m for m in self.messages if m.id in ids]


def _text(message_id: int, sent: datetime):
    return SimpleNamespace(id=message_id, message=f"m{message_id}", date=sent, edit_date=None,
                           reply_to_msg_id=None, photo=None, document=None, gif=None, sticker=None)


def test_transient_errors_are_classified():
    assert is_transient(ConnectionError("Connection to Telegram failed 5 time(s)"))
    assert is_transient(asyncio.TimeoutError())
    assert not is_transient(ValueError("No user has \"x\" as username"))


def test_reload_connection_error_keeps_source_enabled(tmp_path: Path):
    # 2026-09-29：一次断线让 reload() 把全部来源标为 error/enabled=0，采集停了 10 天
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    source_id = _active_source(store, -1005, "@flaky")
    worker = Worker(store, FakeClient(entity_error=ConnectionError("Connection to Telegram failed")), tmp_path / "s.sock")
    asyncio.run(worker.reload())
    status, enabled, error = store.db.execute(
        "SELECT status,enabled,last_error FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    assert (status, enabled) == ("active", 1)
    assert "ConnectionError" in error

    worker = Worker(store, FakeClient(entity_error=ValueError("No user has that username")), tmp_path / "s.sock")
    asyncio.run(worker.reload())
    assert tuple(store.db.execute("SELECT status,enabled FROM telegram_sources WHERE id=?", (source_id,)).fetchone()) == ("error", 0)


def test_catchup_options():
    cutoff = datetime(2026, 10, 4, tzinfo=UTC)
    assert catchup_options(0, True, cutoff) == {}
    assert catchup_options(100, True, cutoff) == {"min_id": 100, "reverse": True}
    assert catchup_options(100, False, cutoff) == {"min_id": 100, "reverse": True, "offset_date": cutoff}


def test_catchup_past_retention_backfills_gap_when_keeping_forever(tmp_path: Path):
    # 断点早于保留期：正序补采遇到的第一条就是旧消息，原来的 break 会一条都补不回来
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    store.db.execute("UPDATE telegram_settings SET keep_messages_forever=1, raw_retention_days=6 WHERE singleton=1")
    source_id = _active_source(store, -1006, "@gap")
    store.db.execute("UPDATE telegram_sync_state SET last_message_id=100 WHERE source_id=?", (source_id,))
    store.db.commit()
    now = datetime.now(UTC)
    messages = [_text(101, now - timedelta(days=10)), _text(102, now - timedelta(days=8)), _text(103, now - timedelta(hours=1))]
    client = FakeClient(messages)
    worker = Worker(store, client, tmp_path / "s.sock")
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1006)))
    saved = [r[0] for r in store.db.execute("SELECT message_id FROM telegram_messages WHERE source_id=? ORDER BY message_id", (source_id,))]
    assert saved == [101, 102, 103]
    assert client.calls[0] == {"min_id": 100, "reverse": True}
    assert store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (source_id,)).fetchone()[0] == 103


def test_catchup_past_retention_skips_old_when_not_keeping(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    store.db.execute("UPDATE telegram_settings SET keep_messages_forever=0, raw_retention_days=6 WHERE singleton=1")
    source_id = _active_source(store, -1007, "@gap2")
    store.db.execute("UPDATE telegram_sync_state SET last_message_id=100 WHERE source_id=?", (source_id,))
    store.db.commit()
    now = datetime.now(UTC)
    worker = Worker(store, FakeClient([_text(101, now - timedelta(days=10)), _text(102, now - timedelta(hours=1))]), tmp_path / "s.sock")
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1007)))
    saved = [r[0] for r in store.db.execute("SELECT message_id FROM telegram_messages WHERE source_id=?", (source_id,))]
    assert saved == [102]


def test_live_events_do_not_skip_restart_gap(tmp_path: Path):
    # 2026-10-09：重启后实时事件先到，把游标推到最新，补采从最新开始，停机期间约 6500 条消息丢失
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    store.db.execute("UPDATE telegram_settings SET keep_messages_forever=1 WHERE singleton=1")
    source_id = _active_source(store, -1008, "@busy")
    store.db.execute("UPDATE telegram_sync_state SET last_message_id=100 WHERE source_id=?", (source_id,))
    store.db.commit()
    now = datetime.now(UTC)
    gap = [_text(i, now - timedelta(days=2)) for i in range(101, 105)]
    live = _text(105, now)
    client = FakeClient([*gap, live])
    worker = Worker(store, client, tmp_path / "s.sock")
    asyncio.run(worker.on_message(SimpleNamespace(chat_id=-1008, message=live)))
    assert store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (source_id,)).fetchone()[0] == 100
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1008)))
    saved = [r[0] for r in store.db.execute("SELECT message_id FROM telegram_messages WHERE source_id=? ORDER BY message_id", (source_id,))]
    assert saved == [101, 102, 103, 104, 105]
    assert store.db.execute("SELECT count(*) FROM telegram_messages WHERE message_id=105").fetchone()[0] == 1
    assert store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (source_id,)).fetchone()[0] == 105


class InterruptingClient(FakeClient):
    """首次同步读到第 stop_after 条后抛错，模拟被看门狗终止或断线。"""
    def __init__(self, messages, stop_after: int):
        super().__init__(messages)
        self.stop_after = stop_after

    async def iter_messages(self, entity, **options):
        n = 0
        async for message in super().iter_messages(entity, **options):
            if n == self.stop_after:
                raise ConnectionError("connection lost")
            n += 1
            yield message


def test_interrupted_first_sync_does_not_skip_older_messages(tmp_path: Path):
    # 首次同步按时间倒序：若逐条推进游标，中断后从已存最大 ID 正序续读，更早的消息永久漏采
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    store.db.execute("UPDATE telegram_settings SET keep_messages_forever=1 WHERE singleton=1")
    source_id = _active_source(store, -1009, "@first")
    now = datetime.now(UTC)
    messages = [_text(i, now - timedelta(hours=10 - i)) for i in range(1, 6)]
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    worker = Worker(store, InterruptingClient(messages, stop_after=2), tmp_path / "s.sock")
    try:
        asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1009)))
    except ConnectionError:
        pass
    assert store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (source_id,)).fetchone()[0] == 0
    worker = Worker(store, FakeClient(messages), tmp_path / "s.sock")
    asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1009)))
    saved = [r[0] for r in store.db.execute("SELECT message_id FROM telegram_messages WHERE source_id=? ORDER BY message_id", (source_id,))]
    assert saved == [1, 2, 3, 4, 5]
    assert store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (source_id,)).fetchone()[0] == 5


def test_progress_signal_written_and_silent_without_fd(tmp_path: Path, monkeypatch):
    import os

    import briefing_telegram.worker as w
    monkeypatch.delenv("TELEGRAM_PROGRESS_FD", raising=False)
    w._progress_fd = None
    w.init_progress()
    w.progress()  # 没有 fd 时不报错
    r, wr = os.pipe()
    monkeypatch.setenv("TELEGRAM_PROGRESS_FD", str(wr))
    w.init_progress()
    w._progress_at = 0.0
    w.progress()
    w.progress()  # 一秒内节流
    os.close(wr)
    assert os.read(r, 10) == b"."
    os.close(r)
    w._progress_fd = None
    w.progress()


def test_backfill_reports_progress(tmp_path: Path, monkeypatch):
    import briefing_telegram.worker as w
    calls: list[int] = []
    monkeypatch.setattr(w, "progress", lambda: calls.append(1))
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    source_id = _active_source(store, -1010, "@prog")
    now = datetime.now(UTC)
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    asyncio.run(Worker(store, FakeClient([_text(1, now), _text(2, now)]), tmp_path / "s.sock").backfill_source(row, SimpleNamespace(id=-1010)))
    assert len(calls) >= 2


def test_coverage_watermark_and_attempt_recorded(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    source_id = _active_source(store, -1011, "@cov")
    now = datetime.now(UTC)
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    before = datetime.now(UTC).isoformat()
    asyncio.run(Worker(store, FakeClient([_text(1, now)]), tmp_path / "s.sock").backfill_source(row, SimpleNamespace(id=-1011)))
    covered, at, ok = store.db.execute("SELECT covered_until,last_attempt_at,last_attempt_ok FROM telegram_sync_progress WHERE source_id=?", (source_id,)).fetchone()
    assert covered and covered >= before[:19] and ok == 1 and at >= covered


def test_failed_attempt_recorded_without_moving_coverage(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    source_id = _active_source(store, -1012, "@fail")
    store.db.execute("UPDATE telegram_sync_state SET last_message_id=5 WHERE source_id=?", (source_id,))
    store.db.execute("INSERT INTO telegram_sync_progress(source_id,covered_until) VALUES(?,'2026-01-01T00:00:00.000Z')", (source_id,))
    store.db.commit()
    worker = Worker(store, InterruptingClient([_text(6, datetime.now(UTC)), _text(7, datetime.now(UTC))], stop_after=1), tmp_path / "s.sock")
    worker.entities = {-1012: SimpleNamespace(id=-1012)}

    async def no_reload():
        return None
    worker.reload = no_reload  # type: ignore[method-assign]
    worker.validate_pending = no_reload  # type: ignore[method-assign]
    asyncio.run(worker.reconcile())
    covered, ok = store.db.execute("SELECT covered_until,last_attempt_ok FROM telegram_sync_progress WHERE source_id=?", (source_id,)).fetchone()
    assert covered == "2026-01-01T00:00:00.000Z" and ok == 0


def test_retention_recheck_does_not_advance_cursor(tmp_path: Path):
    # 主补采读到 101，实时事件存了 103、漏了 102；复查只看库里已有的 ID，若推进游标到 103，102 将永久漏采
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    source_id = _active_source(store, -1013, "@recheck")
    store.db.execute("UPDATE telegram_sync_state SET last_message_id=100 WHERE source_id=?", (source_id,))
    store.db.commit()
    now = datetime.now(UTC)
    m101, m102, m103 = _text(101, now), _text(102, now), _text(103, now)
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    worker = Worker(store, FakeClient([m101, m103]), tmp_path / "s.sock")
    asyncio.run(worker.on_message(SimpleNamespace(chat_id=-1013, message=m103)))
    client = FakeClient([m101, m103])
    client.messages = [m101]          # 连续历史只读到 101
    client_get = FakeClient([m101, m103])
    client.get_messages = client_get.get_messages  # type: ignore[method-assign]
    asyncio.run(Worker(store, client, tmp_path / "s.sock").backfill_source(row, SimpleNamespace(id=-1013)))
    assert store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (source_id,)).fetchone()[0] == 101
    asyncio.run(Worker(store, FakeClient([m101, m102, m103]), tmp_path / "s.sock").backfill_source(row, SimpleNamespace(id=-1013)))
    saved = [r[0] for r in store.db.execute("SELECT message_id FROM telegram_messages WHERE source_id=? ORDER BY message_id", (source_id,))]
    assert saved == [101, 102, 103]


def test_coverage_published_before_retention_recheck(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    source_id = _active_source(store, -1014, "@late")
    now = datetime.now(UTC)
    client = FakeClient([_text(1, now)])

    async def broken(entity, ids):
        raise ConnectionError("lost during recheck")
    client.get_messages = broken  # type: ignore[method-assign]
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    try:
        asyncio.run(Worker(store, client, tmp_path / "s.sock").backfill_source(row, SimpleNamespace(id=-1014)))
    except ConnectionError:
        pass
    covered, ok = store.db.execute("SELECT covered_until,last_attempt_ok FROM telegram_sync_progress WHERE source_id=?", (source_id,)).fetchone()
    # 2026-11-08：复查慢或失败都不能挡住总结——新消息读完就发布覆盖水位；尝试结果保持「进行中」直到 reconcile 记为失败
    assert covered is not None and ok is None


def test_new_attempt_clears_stale_failure(tmp_path: Path):
    # 上一轮失败留下 ok=0；本轮开始补采时必须先置为进行中，否则汇总会在恢复期间把它当成故障来源跳过
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    source_id = _active_source(store, -1015, "@retry")
    store.db.execute("INSERT INTO telegram_sync_progress(source_id,last_attempt_at,last_attempt_ok) VALUES(?,'2026-01-01T00:00:00.000Z',0)", (source_id,))
    store.db.commit()
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    now = datetime.now(UTC)
    try:
        asyncio.run(Worker(store, InterruptingClient([_text(1, now), _text(2, now)], stop_after=1), tmp_path / "s.sock").backfill_source(row, SimpleNamespace(id=-1015)))
    except ConnectionError:
        pass
    assert store.db.execute("SELECT last_attempt_ok FROM telegram_sync_progress WHERE source_id=?", (source_id,)).fetchone()[0] is None


def test_skipping_expired_history_reports_progress_and_advances_cursor(tmp_path: Path, monkeypatch):
    import briefing_telegram.worker as w
    calls: list[int] = []
    monkeypatch.setattr(w, "progress", lambda: calls.append(1))
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    store.db.execute("UPDATE telegram_settings SET keep_messages_forever=0, raw_retention_days=6 WHERE singleton=1")
    source_id = _active_source(store, -1016, "@old")
    store.db.execute("UPDATE telegram_sync_state SET last_message_id=10 WHERE source_id=?", (source_id,))
    store.db.commit()
    old = datetime.now(UTC) - timedelta(days=30)
    messages = [_text(i, old) for i in range(11, 1212)]

    class Stop(FakeClient):
        async def iter_messages(self, entity, **options):
            n = 0
            async for m in super().iter_messages(entity, **options):
                if n == 1100:
                    raise ConnectionError("killed")
                n += 1
                yield m
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    try:
        asyncio.run(Worker(store, Stop(messages), tmp_path / "s.sock").backfill_source(row, SimpleNamespace(id=-1016)))
    except ConnectionError:
        pass
    assert len(calls) >= 1000, "扫过过期历史时每条都报告进度"
    assert store.db.execute("SELECT last_message_id FROM telegram_sync_state WHERE source_id=?", (source_id,)).fetchone()[0] >= 1010, "中断后游标停在已跳过的位置附近，不会从头重扫"


def test_migration_006_is_rerunnable(tmp_path: Path):
    # 迁移中途被中断或 Node/Python 同时执行导致重复执行时，不能让后续启动失败
    from pathlib import Path as P
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    sql = (P(__file__).parents[1] / "migrations" / "006_sync_coverage.sql").read_text(encoding="utf8")
    store.db.executescript(sql)
    store.db.execute("DELETE FROM telegram_schema_migrations WHERE name='006_sync_coverage.sql'")
    store.db.commit()
    store.initialize()
    assert store.db.execute("SELECT count(*) FROM telegram_schema_migrations WHERE name='006_sync_coverage.sql'").fetchone()[0] == 1


def test_recheck_recent_only_after_full_recheck(tmp_path: Path):
    store = Store(tmp_path / "telegram.db")
    store.initialize()
    store.db.execute("UPDATE telegram_settings SET raw_retention_days=6 WHERE singleton=1")
    source_id = _active_source(store, -1017, "@big")
    store.db.execute("UPDATE telegram_sync_state SET last_message_id=2 WHERE source_id=?", (source_id,))
    store.db.commit()
    now = datetime.now(UTC)
    old, recent = _text(1, now - timedelta(days=3)), _text(2, now - timedelta(hours=1))
    row = store.db.execute("SELECT * FROM telegram_sources WHERE id=?", (source_id,)).fetchone()
    client = FakeClient([old, recent])
    asked: list[list[int]] = []
    inner = client.get_messages

    async def spy(entity, ids):
        asked.append(list(ids))
        return await inner(entity, ids)
    client.get_messages = spy  # type: ignore[method-assign]
    worker = Worker(store, client, tmp_path / "s.sock")
    for m in (old, recent):
        store.save_normal(row, m, advance_cursor=False)
    asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1017)))
    assert asked[-1] == [1, 2], "进程启动后第一轮做保留期全量复查"
    asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1017)))
    assert asked[-1] == [2], "之后每轮只复查最近 24 小时"
    worker.full_recheck_at[source_id] -= 25 * 3600
    asyncio.run(worker.backfill_source(row, SimpleNamespace(id=-1017)))
    assert asked[-1] == [1, 2], "满 24 小时再做一次全量"
