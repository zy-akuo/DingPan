"""TTL cache: memory + SQLite persistence with timed cleanup."""
from __future__ import annotations

import json
import time
from typing import Any

import aiosqlite

from ..config import settings

CACHE_SCHEMA = """
CREATE TABLE IF NOT EXISTS payload_cache (
    cache_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    expires_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payload_cache_expires ON payload_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_payload_cache_kind ON payload_cache(kind);
"""


class TtlCache:
    """Process memory first, SQLite second. Expired entries purged periodically."""

    def __init__(self) -> None:
        self._mem: dict[str, tuple[float, Any]] = {}
        self._lock_ready = False

    async def init(self) -> None:
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(settings.db_path) as db:
            await db.executescript(CACHE_SCHEMA)
            await db.commit()
        self._lock_ready = True

    def _now(self) -> float:
        return time.time()

    def mem_get(self, key: str) -> Any | None:
        item = self._mem.get(key)
        if not item:
            return None
        exp, val = item
        if exp < self._now():
            self._mem.pop(key, None)
            return None
        return val

    def mem_set(self, key: str, value: Any, ttl_sec: float) -> None:
        self._mem[key] = (self._now() + max(1.0, ttl_sec), value)
        # soft cap memory entries
        if len(self._mem) > 800:
            oldest = sorted(self._mem.items(), key=lambda kv: kv[1][0])[:200]
            for k, _ in oldest:
                self._mem.pop(k, None)

    async def get(self, key: str) -> Any | None:
        hit = self.mem_get(key)
        if hit is not None:
            return hit
        try:
            async with aiosqlite.connect(settings.db_path) as db:
                cur = await db.execute(
                    "SELECT payload, expires_at FROM payload_cache WHERE cache_key = ?",
                    (key,),
                )
                row = await cur.fetchone()
            if not row:
                return None
            payload, expires_at = row
            if float(expires_at) < self._now():
                return None
            data = json.loads(payload)
            # warm memory
            self.mem_set(key, data, max(1.0, float(expires_at) - self._now()))
            return data
        except Exception:
            return None

    async def set(self, key: str, value: Any, ttl_sec: float, kind: str = "generic") -> None:
        ttl = max(1.0, float(ttl_sec))
        self.mem_set(key, value, ttl)
        try:
            now = self._now()
            async with aiosqlite.connect(settings.db_path) as db:
                await db.execute(
                    """
                    INSERT INTO payload_cache(cache_key, kind, payload, expires_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(cache_key) DO UPDATE SET
                        kind=excluded.kind,
                        payload=excluded.payload,
                        expires_at=excluded.expires_at,
                        updated_at=excluded.updated_at
                    """,
                    (key, kind, json.dumps(value, ensure_ascii=False), now + ttl, now),
                )
                await db.commit()
        except Exception:
            pass

    async def purge_expired(self) -> int:
        now = self._now()
        dead = [k for k, (exp, _) in self._mem.items() if exp < now]
        for k in dead:
            self._mem.pop(k, None)
        try:
            async with aiosqlite.connect(settings.db_path) as db:
                cur = await db.execute("DELETE FROM payload_cache WHERE expires_at < ?", (now,))
                await db.commit()
                return int(cur.rowcount or 0) + len(dead)
        except Exception:
            return len(dead)

    async def cleanup_loop(self, interval_sec: float = 600.0) -> None:
        """Default: purge every 10 minutes."""
        while True:
            try:
                await self.purge_expired()
            except Exception:
                pass
            await asyncio_sleep(interval_sec)


async def asyncio_sleep(sec: float) -> None:
    import asyncio

    await asyncio.sleep(sec)


# Singleton
ttl_cache = TtlCache()


def trading_ttl(trading: float, idle: float) -> float:
    from datetime import datetime, time

    now = datetime.now()
    if now.weekday() >= 5:
        return idle
    t = now.time()
    if (time(9, 15) <= t <= time(11, 35)) or (time(12, 55) <= t <= time(15, 5)):
        return trading
    return idle
