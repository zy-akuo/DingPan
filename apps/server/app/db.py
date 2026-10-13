from __future__ import annotations

import json
from pathlib import Path

import aiosqlite

from .config import settings
from .models import FieldConfig, UserConfig

SCHEMA = """
CREATE TABLE IF NOT EXISTS zt_history (
    trade_date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    board_count INTEGER,
    industry TEXT,
    reason TEXT,
    PRIMARY KEY (trade_date, code)
);

CREATE TABLE IF NOT EXISTS stock_fundamentals (
    code TEXT PRIMARY KEY,
    name TEXT,
    region TEXT,
    industry TEXT,
    concepts TEXT,
    price REAL,
    total_mv REAL,
    float_mv REAL,
    free_float_mv REAL,
    top10_holder_pct REAL,
    top10_holders TEXT,
    top10_holders_date TEXT,
    former_names TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS risk_snapshot (
    trade_date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    risk_type TEXT NOT NULL,
    PRIMARY KEY (trade_date, code, risk_type)
);

CREATE TABLE IF NOT EXISTS risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    risk_type TEXT NOT NULL,
    action TEXT NOT NULL,
    UNIQUE(trade_date, code, risk_type, action)
);

CREATE TABLE IF NOT EXISTS auction_snapshots (
    trade_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    auction_pct REAL,
    seal_amount REAL,
    price REAL,
    board_count INTEGER,
    concepts TEXT,
    region TEXT,
    industry TEXT,
    is_yizhi INTEGER DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (trade_date, slot, code)
);
CREATE INDEX IF NOT EXISTS idx_auction_date ON auction_snapshots(trade_date);
"""


async def init_db() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(settings.db_path) as db:
        await db.executescript(SCHEMA)
        # lightweight migrations for older DBs
        cur = await db.execute("PRAGMA table_info(stock_fundamentals)")
        cols = {row[1] for row in await cur.fetchall()}
        alters = []
        for col, typ in [
            ("industry", "TEXT"),
            ("price", "REAL"),
            ("total_mv", "REAL"),
            ("float_mv", "REAL"),
            ("top10_holders", "TEXT"),
            ("top10_holders_date", "TEXT"),
            ("former_names", "TEXT"),
        ]:
            if col not in cols:
                alters.append(f"ALTER TABLE stock_fundamentals ADD COLUMN {col} {typ}")
        for sql in alters:
            await db.execute(sql)

        cur = await db.execute("PRAGMA table_info(zt_history)")
        zt_cols = {row[1] for row in await cur.fetchall()}
        if "reason" not in zt_cols:
            await db.execute("ALTER TABLE zt_history ADD COLUMN reason TEXT")
        await db.commit()


def _row_reason(r: dict) -> str:
    return str(r.get("reason") or r.get("industry") or "").strip()


async def replace_auction_slot(
    trade_date: str, slot: str, rows: list[dict], updated_at: str
) -> None:
    """Replace one auction slot snapshot for a trade date (0915/0920/0925)."""
    ds = (trade_date or "").replace("-", "")[:8]
    sl = (slot or "").strip()
    if len(ds) != 8 or sl not in ("0915", "0920", "0925"):
        return
    async with aiosqlite.connect(settings.db_path) as db:
        await db.execute(
            "DELETE FROM auction_snapshots WHERE trade_date=? AND slot=?",
            (ds, sl),
        )
        await db.executemany(
            """
            INSERT INTO auction_snapshots(
                trade_date, slot, code, name, auction_pct, seal_amount, price,
                board_count, concepts, region, industry, is_yizhi, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            [
                (
                    ds,
                    sl,
                    str(r.get("code") or "").zfill(6),
                    str(r.get("name") or ""),
                    float(r.get("auction_pct") or 0),
                    float(r.get("seal_amount") or 0),
                    float(r.get("price") or 0),
                    int(r.get("board_count") or 1),
                    json.dumps(r.get("concepts") or [], ensure_ascii=False),
                    str(r.get("region") or ""),
                    str(r.get("industry") or ""),
                    1 if r.get("is_yizhi") else 0,
                    updated_at,
                )
                for r in rows
                if str(r.get("code") or "").isdigit()
            ],
        )
        await db.commit()


async def load_auction_dates(limit: int = 10) -> list[str]:
    async with aiosqlite.connect(settings.db_path) as db:
        cur = await db.execute(
            """
            SELECT DISTINCT trade_date FROM auction_snapshots
            ORDER BY trade_date DESC LIMIT ?
            """,
            (max(1, int(limit)),),
        )
        rows = await cur.fetchall()
    return [str(r[0]) for r in rows]


async def load_auction_day(trade_date: str) -> dict[str, list[dict]]:
    """Return {slot: [rows...]} for one day."""
    ds = (trade_date or "").replace("-", "")[:8]
    out: dict[str, list[dict]] = {"0915": [], "0920": [], "0925": []}
    if len(ds) != 8:
        return out
    async with aiosqlite.connect(settings.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT * FROM auction_snapshots WHERE trade_date=? ORDER BY seal_amount DESC
            """,
            (ds,),
        )
        for r in await cur.fetchall():
            slot = str(r["slot"] or "")
            if slot not in out:
                continue
            try:
                concepts = json.loads(r["concepts"] or "[]")
            except Exception:
                concepts = []
            if not isinstance(concepts, list):
                concepts = []
            out[slot].append(
                {
                    "code": str(r["code"] or "").zfill(6),
                    "name": str(r["name"] or ""),
                    "auction_pct": float(r["auction_pct"] or 0),
                    "seal_amount": float(r["seal_amount"] or 0),
                    "price": float(r["price"] or 0),
                    "board_count": int(r["board_count"] or 1),
                    "concepts": concepts,
                    "region": str(r["region"] or ""),
                    "industry": str(r["industry"] or ""),
                    "is_yizhi": bool(r["is_yizhi"]),
                    "updated_at": str(r["updated_at"] or ""),
                }
            )
    return out


async def purge_old_auction_dates(keep: int = 15) -> None:
    dates = await load_auction_dates(limit=keep + 50)
    if len(dates) <= keep:
        return
    drop = dates[keep:]
    async with aiosqlite.connect(settings.db_path) as db:
        for ds in drop:
            await db.execute("DELETE FROM auction_snapshots WHERE trade_date=?", (ds,))
        await db.commit()


async def upsert_zt_history(trade_date: str, rows: list[dict]) -> None:
    async with aiosqlite.connect(settings.db_path) as db:
        await db.executemany(
            """
            INSERT INTO zt_history(trade_date, code, name, board_count, industry, reason)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(trade_date, code) DO UPDATE SET
                name=excluded.name,
                board_count=excluded.board_count,
                industry=COALESCE(NULLIF(excluded.industry, ''), zt_history.industry),
                reason=COALESCE(NULLIF(excluded.reason, ''), zt_history.reason)
            """,
            [
                (
                    trade_date,
                    r["code"],
                    r.get("name"),
                    r.get("board_count", 1),
                    r.get("industry") or "",
                    _row_reason(r),
                )
                for r in rows
            ],
        )
        await db.commit()


async def list_zt_history_by_code(code: str) -> list[dict]:
    """Return all local limit-up rows for a stock, newest first."""
    code = (code or "").zfill(6)
    async with aiosqlite.connect(settings.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT trade_date, code, name, board_count, industry, reason
            FROM zt_history
            WHERE code = ?
            ORDER BY trade_date DESC
            """,
            (code,),
        )
        rows = await cur.fetchall()
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        if not d.get("reason"):
            d["reason"] = d.get("industry") or ""
        out.append(d)
    return out


async def list_zt_history_by_date(trade_date: str) -> list[dict]:
    """Return local limit-up rows for one trade date."""
    ds = (trade_date or "").replace("-", "")[:8]
    if len(ds) != 8:
        return []
    async with aiosqlite.connect(settings.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT trade_date, code, name, board_count, industry, reason
            FROM zt_history
            WHERE trade_date = ?
            ORDER BY board_count DESC, code ASC
            """,
            (ds,),
        )
        rows = await cur.fetchall()
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        if not d.get("reason"):
            d["reason"] = d.get("industry") or ""
        out.append(d)
    return out


async def delete_zt_history_dates(code: str, dates: list[str]) -> None:
    """Remove polluted / rejected limit-up rows for a stock."""
    code = (code or "").zfill(6)
    ds_list = [str(d).replace("-", "")[:8] for d in (dates or []) if d]
    ds_list = [d for d in ds_list if len(d) == 8 and d.isdigit()]
    if not code.isdigit() or not ds_list:
        return
    async with aiosqlite.connect(settings.db_path) as db:
        await db.executemany(
            "DELETE FROM zt_history WHERE code = ? AND trade_date = ?",
            [(code, ds) for ds in ds_list],
        )
        await db.commit()


async def search_local_stocks(q: str, limit: int = 20) -> list[dict]:
    """Match local fundamentals by code / name / former names."""
    q = (q or "").strip()
    if not q:
        return []
    limit = max(1, min(50, int(limit or 20)))
    like = f"%{q}%"
    async with aiosqlite.connect(settings.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT code, name, former_names, industry
            FROM stock_fundamentals
            WHERE code = ?
               OR name LIKE ?
               OR former_names LIKE ?
            LIMIT ?
            """,
            (q.zfill(6) if q.isdigit() else q, like, like, limit * 3),
        )
        rows = await cur.fetchall()

    scored: list[tuple[int, dict]] = []
    ql = q.lower()
    for r in rows:
        data = dict(r)
        former: list[str] = []
        raw_former = data.get("former_names")
        if raw_former:
            try:
                parsed = json.loads(raw_former) if isinstance(raw_former, str) else raw_former
                if isinstance(parsed, list):
                    former = [str(x) for x in parsed if x]
            except (TypeError, json.JSONDecodeError):
                former = []
        name = str(data.get("name") or "")
        code = str(data.get("code") or "").zfill(6)
        score = 100
        if code == q.zfill(6) and q.isdigit():
            score = 0
        elif name == q:
            score = 1
        elif any(fn == q for fn in former):
            score = 2
        elif name.lower().startswith(ql):
            score = 3
        elif any(fn.lower().startswith(ql) for fn in former):
            score = 4
        elif ql in name.lower():
            score = 5
        elif any(ql in fn.lower() for fn in former):
            score = 6
        else:
            continue
        scored.append(
            (
                score,
                {
                    "code": code,
                    "name": name or code,
                    "former_names": former,
                    "industry": data.get("industry") or "",
                    "match_via": "former" if score in (2, 4, 6) else "name",
                },
            )
        )
    scored.sort(key=lambda x: (x[0], x[1]["code"]))
    return [item for _, item in scored[:limit]]


async def count_history_dates() -> int:
    async with aiosqlite.connect(settings.db_path) as db:
        cur = await db.execute("SELECT COUNT(DISTINCT trade_date) FROM zt_history")
        row = await cur.fetchone()
        return int(row[0] or 0)


async def get_meta(key: str) -> str | None:
    async with aiosqlite.connect(settings.db_path) as db:
        cur = await db.execute("SELECT value FROM meta WHERE key = ?", (key,))
        row = await cur.fetchone()
        return row[0] if row else None


async def set_meta(key: str, value: str) -> None:
    async with aiosqlite.connect(settings.db_path) as db:
        await db.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        await db.commit()


async def calc_year_rates(code: str, lookback_days: int = 250) -> tuple[float | None, float | None]:
    """Return (seal_rate%, consecutive_board_rate%) using ~1y trading days as denominator."""
    async with aiosqlite.connect(settings.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT trade_date, board_count FROM zt_history
            WHERE code = ?
            ORDER BY trade_date DESC
            LIMIT ?
            """,
            (code, lookback_days),
        )
        rows = await cur.fetchall()
        cur2 = await db.execute("SELECT COUNT(DISTINCT trade_date) FROM zt_history")
        total_dates = int((await cur2.fetchone())[0] or 0)

    if not rows:
        return None, None
    # Prefer actual history span; fall back to 250 when backfill is rich enough
    denom = max(total_dates, lookback_days) if total_dates >= 60 else lookback_days
    seal_days = len(rows)
    seal_rate = round(seal_days / denom * 100, 2)
    lb_days = sum(1 for r in rows if (r["board_count"] or 1) >= 2)
    board_rate = round(lb_days / denom * 100, 2)
    return seal_rate, board_rate


def _parse_fundamentals_row(row: aiosqlite.Row | dict) -> dict:
    data = dict(row)
    if data.get("concepts"):
        try:
            data["concepts"] = json.loads(data["concepts"])
        except json.JSONDecodeError:
            data["concepts"] = []
    if data.get("top10_holders"):
        try:
            data["top10_holders"] = json.loads(data["top10_holders"])
        except json.JSONDecodeError:
            data["top10_holders"] = []
    elif "top10_holders" in data and data["top10_holders"] is None:
        data["top10_holders"] = None
    if data.get("former_names"):
        try:
            data["former_names"] = json.loads(data["former_names"])
        except json.JSONDecodeError:
            data["former_names"] = []
    elif "former_names" in data and data["former_names"] is None:
        data["former_names"] = None
    return data


async def get_fundamentals(code: str) -> dict | None:
    async with aiosqlite.connect(settings.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM stock_fundamentals WHERE code = ?", (code,))
        row = await cur.fetchone()
    if not row:
        return None
    return _parse_fundamentals_row(row)


async def get_fundamentals_batch(codes: list[str]) -> dict[str, dict]:
    """一次查出多只股票基础信息，供竞价高频 enrich 使用。"""
    uniq = []
    seen: set[str] = set()
    for c in codes:
        code = str(c or "").zfill(6)
        if code.isdigit() and code not in seen:
            seen.add(code)
            uniq.append(code)
    if not uniq:
        return {}
    out: dict[str, dict] = {}
    async with aiosqlite.connect(settings.db_path) as db:
        db.row_factory = aiosqlite.Row
        # SQLite 变量上限约 999，分块
        for i in range(0, len(uniq), 400):
            chunk = uniq[i : i + 400]
            placeholders = ",".join("?" for _ in chunk)
            cur = await db.execute(
                f"SELECT * FROM stock_fundamentals WHERE code IN ({placeholders})",
                chunk,
            )
            for row in await cur.fetchall():
                data = _parse_fundamentals_row(row)
                out[str(data.get("code") or "").zfill(6)] = data
    return out


async def upsert_fundamentals(code: str, payload: dict) -> None:
    concepts = payload.get("concepts") or []
    if isinstance(concepts, list):
        concepts_json = json.dumps(concepts, ensure_ascii=False)
    else:
        concepts_json = str(concepts)
    holders = payload.get("top10_holders")
    if isinstance(holders, list):
        holders_json = json.dumps(holders, ensure_ascii=False)
    elif holders is None:
        holders_json = None
    else:
        holders_json = str(holders)
    former = payload.get("former_names")
    if isinstance(former, list):
        former_json = json.dumps(former, ensure_ascii=False)
    elif former is None:
        former_json = None
    else:
        former_json = str(former)
    async with aiosqlite.connect(settings.db_path) as db:
        await db.execute(
            """
            INSERT INTO stock_fundamentals(
                code, name, region, industry, concepts, price, total_mv, float_mv,
                free_float_mv, top10_holder_pct, top10_holders, top10_holders_date,
                former_names, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
                name=excluded.name,
                region=excluded.region,
                industry=excluded.industry,
                concepts=excluded.concepts,
                price=excluded.price,
                total_mv=excluded.total_mv,
                float_mv=excluded.float_mv,
                free_float_mv=excluded.free_float_mv,
                top10_holder_pct=excluded.top10_holder_pct,
                top10_holders=excluded.top10_holders,
                top10_holders_date=excluded.top10_holders_date,
                former_names=excluded.former_names,
                updated_at=excluded.updated_at
            """,
            (
                code,
                payload.get("name"),
                payload.get("region"),
                payload.get("industry"),
                concepts_json,
                payload.get("price"),
                payload.get("total_mv"),
                payload.get("float_mv"),
                payload.get("free_float_mv"),
                payload.get("top10_holder_pct"),
                holders_json,
                payload.get("top10_holders_date") or "",
                former_json,
                payload.get("updated_at"),
            ),
        )
        await db.commit()


def load_user_config() -> UserConfig:
    path: Path = settings.config_path
    if not path.exists():
        cfg = UserConfig()
        save_user_config(cfg)
        return cfg
    try:
        return UserConfig.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception:
        return UserConfig()


def save_user_config(cfg: UserConfig) -> None:
    settings.config_path.write_text(
        cfg.model_dump_json(indent=2),
        encoding="utf-8",
    )


def update_field_config(fields: FieldConfig) -> UserConfig:
    cfg = load_user_config()
    cfg.fields = fields
    save_user_config(cfg)
    return cfg


def _normalize_codes(codes: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for x in codes or []:
        c = str(x or "").strip().zfill(6)
        if len(c) != 6 or not c.isdigit() or c in seen:
            continue
        seen.add(c)
        out.append(c)
    return out


def _normalize_pinned(pinned: list[str] | None, codes: list[str]) -> list[str]:
    code_set = set(codes)
    out: list[str] = []
    seen: set[str] = set()
    for x in pinned or []:
        c = str(x or "").strip().zfill(6)
        if c not in code_set or c in seen:
            continue
        seen.add(c)
        out.append(c)
    return out


def update_watchlist(
    codes: list[str] | None,
    pinned: list[str] | None = None,
) -> UserConfig:
    cfg = load_user_config()
    cfg.watchlist = _normalize_codes(codes)
    if pinned is not None:
        cfg.watchlist_pinned = _normalize_pinned(pinned, cfg.watchlist)
    else:
        cfg.watchlist_pinned = _normalize_pinned(cfg.watchlist_pinned, cfg.watchlist)
    save_user_config(cfg)
    return cfg


def update_alertlist(
    codes: list[str] | None,
    pinned: list[str] | None = None,
) -> UserConfig:
    cfg = load_user_config()
    cfg.alertlist = _normalize_codes(codes)
    if pinned is not None:
        cfg.alertlist_pinned = _normalize_pinned(pinned, cfg.alertlist)
    else:
        cfg.alertlist_pinned = _normalize_pinned(cfg.alertlist_pinned, cfg.alertlist)
    save_user_config(cfg)
    return cfg


async def replace_risk_snapshot(trade_date: str, rows: list[dict]) -> None:
    """rows: {code, name, risk_type}"""
    async with aiosqlite.connect(settings.db_path) as db:
        await db.execute("DELETE FROM risk_snapshot WHERE trade_date = ?", (trade_date,))
        if rows:
            await db.executemany(
                """
                INSERT OR REPLACE INTO risk_snapshot(trade_date, code, name, risk_type)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (
                        trade_date,
                        str(r.get("code") or "").zfill(6),
                        str(r.get("name") or ""),
                        str(r.get("risk_type") or "warn"),
                    )
                    for r in rows
                    if str(r.get("code") or "").isdigit()
                ],
            )
        await db.commit()


async def load_risk_snapshot(trade_date: str) -> list[dict]:
    async with aiosqlite.connect(settings.db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT trade_date, code, name, risk_type FROM risk_snapshot WHERE trade_date = ?",
            (trade_date,),
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def upsert_risk_events(events: list[dict]) -> None:
    """events: {trade_date, code, name, risk_type, action} action=add|remove"""
    if not events:
        return
    async with aiosqlite.connect(settings.db_path) as db:
        await db.executemany(
            """
            INSERT OR IGNORE INTO risk_events(trade_date, code, name, risk_type, action)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (
                    str(e.get("trade_date") or ""),
                    str(e.get("code") or "").zfill(6),
                    str(e.get("name") or ""),
                    str(e.get("risk_type") or "warn"),
                    str(e.get("action") or "add"),
                )
                for e in events
                if str(e.get("code") or "").isdigit()
            ],
        )
        await db.commit()


async def load_risk_events(limit_days: int = 30, risk_type: str | None = None) -> list[dict]:
    async with aiosqlite.connect(settings.db_path) as db:
        db.row_factory = aiosqlite.Row
        if risk_type:
            cur = await db.execute(
                """
                SELECT trade_date, code, name, risk_type, action
                FROM risk_events
                WHERE risk_type = ?
                ORDER BY trade_date DESC, action ASC, code ASC
                LIMIT 2000
                """,
                (risk_type,),
            )
        else:
            cur = await db.execute(
                """
                SELECT trade_date, code, name, risk_type, action
                FROM risk_events
                ORDER BY trade_date DESC, action ASC, code ASC
                LIMIT 2000
                """
            )
        rows = await cur.fetchall()
    out = [dict(r) for r in rows]
    # keep roughly latest N calendar dates
    if limit_days > 0 and out:
        dates = sorted({r["trade_date"] for r in out}, reverse=True)[:limit_days]
        keep = set(dates)
        out = [r for r in out if r["trade_date"] in keep]
    return out


async def load_prev_risk_trade_date(before: str) -> str | None:
    async with aiosqlite.connect(settings.db_path) as db:
        cur = await db.execute(
            """
            SELECT DISTINCT trade_date FROM risk_snapshot
            WHERE trade_date < ?
            ORDER BY trade_date DESC
            LIMIT 1
            """,
            (before,),
        )
        row = await cur.fetchone()
    return str(row[0]) if row else None
