from __future__ import annotations

import asyncio
from datetime import datetime, time
from typing import Any

from ..collectors import EastMoneyClient, today_yyyymmdd
from ..collectors.eastmoney import classify_risk_type, risk_hint_for
from ..db import (
    calc_year_rates,
    count_history_dates,
    get_fundamentals,
    get_meta,
    delete_zt_history_dates,
    list_zt_history_by_code,
    load_prev_risk_trade_date,
    load_risk_events,
    load_risk_snapshot,
    replace_risk_snapshot,
    search_local_stocks,
    set_meta,
    upsert_fundamentals,
    upsert_risk_events,
    upsert_zt_history,
)
from ..models import (
    HistoryGroup,
    LadderGroup,
    MarketSnapshot,
    MarketSummary,
    SpeechEvent,
    StockItem,
    StockStatus,
)


def _is_trading_time(now: datetime | None = None) -> bool:
    now = now or datetime.now()
    if now.weekday() >= 5:
        return False
    t = now.time()
    return (time(9, 15) <= t <= time(11, 35)) or (time(12, 55) <= t <= time(15, 5))


def _board_tag(board: int, open_times: int) -> str:
    if board <= 1:
        base = "首板"
    else:
        base = f"{board}连板"
    if open_times <= 0:
        return f"{base}·硬板"
    return f"{base}·回封"


def _parse_board_count(raw: Any, high_days: Any = None) -> int:
    try:
        n = int(raw)
        if n > 0:
            return n
    except (TypeError, ValueError):
        pass
    text = str(high_days or "").strip()
    if not text or "首" in text:
        return 1
    import re

    m = re.search(r"(\d+)\s*连", text)
    if m:
        return max(1, int(m.group(1)))
    m = re.search(r"(\d+)\s*板", text)
    if m:
        return max(1, int(m.group(1)))
    return 1


def _fmt_money(v: float) -> str:
    if abs(v) >= 1e8:
        return f"{v / 1e8:.2f}亿"
    if abs(v) >= 1e4:
        return f"{v / 1e4:.0f}万"
    return f"{v:.0f}"


def _fund_list_complete(fund: dict[str, Any] | None) -> bool:
    """列表展示所需字段是否齐全（地域 / 自由流通 / 十大股东）。"""
    if not fund:
        return False
    if not (fund.get("region") or "").strip():
        return False
    if fund.get("free_float_mv") is None:
        return False
    if fund.get("top10_holder_pct") is None:
        return False
    return True


def _apply_fund_fields(stock: StockItem, fund: dict[str, Any]) -> None:
    if fund.get("concepts"):
        stock.concepts = fund["concepts"] or stock.concepts
    if fund.get("region"):
        stock.region = fund["region"]
    if fund.get("industry"):
        stock.industry = fund["industry"] or stock.industry
    if fund.get("free_float_mv") is not None:
        stock.free_float_mv = fund["free_float_mv"]
    if fund.get("top10_holder_pct") is not None:
        stock.top10_holder_pct = fund["top10_holder_pct"]
    if fund.get("price"):
        stock.price = fund["price"] or stock.price
    if fund.get("total_mv"):
        stock.total_mv = fund["total_mv"] or stock.total_mv
    if fund.get("float_mv"):
        stock.float_mv = fund["float_mv"] or stock.float_mv


class MarketService:
    def __init__(self) -> None:
        self.client = EastMoneyClient()
        self.snapshot = MarketSnapshot(
            trade_date=today_yyyymmdd(),
            updated_at=datetime.now().isoformat(timespec="seconds"),
            summary=MarketSummary(),
        )
        self._prev_zt_codes: set[str] = set()
        self._prev_zb_codes: set[str] = set()
        self._prev_board: dict[str, int] = {}
        self._lock = asyncio.Lock()
        self._fund_queue: asyncio.Queue[str] = asyncio.Queue()
        self._fund_inflight: set[str] = set()
        self._fund_complete: set[str] = set()
        self._fund_retry_at: dict[str, float] = {}
        self._y_zt: list[dict[str, Any]] = []
        self._y_zb_count = 0
        self._y_dt_count = 0
        self._listeners: list[asyncio.Queue] = []
        self._fund_broadcast_pending = False
        self._fail_quote_cache: dict[str, dict[str, Any]] = {}
        # code -> {risk_tags, risk_hint, risk_type, name}
        self._risk_map: dict[str, dict[str, Any]] = {}
        self._risk_updated_at: str = ""
        self._risk_source: str = ""

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=4)
        self._listeners.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._listeners:
            self._listeners.remove(q)

    async def _broadcast(self) -> None:
        payload = self.snapshot.model_dump()
        dead: list[asyncio.Queue] = []
        for q in self._listeners:
            try:
                if q.full():
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            self.unsubscribe(q)

    async def warmup_yesterday(self) -> None:
        from datetime import timedelta

        today = today_yyyymmdd()
        d = datetime.now().date()
        for _ in range(15):
            d = d - timedelta(days=1)
            ds = d.strftime("%Y%m%d")
            if ds >= today:
                continue
            try:
                rows = await self.client.fetch_zt_pool(ds)
                zb = await self.client.fetch_zb_pool(ds)
                dt = await self.client.fetch_dt_pool(ds)
            except Exception:
                continue
            # skip empty non-trading days
            if not rows and not zb and not dt:
                continue
            self._y_zt = rows
            self._y_zb_count = len(zb)
            self._y_dt_count = len(dt)
            break

    def _to_stock(self, row: dict[str, Any], status: StockStatus) -> StockItem:
        board = int(row.get("board_count") or 1)
        open_times = int(row.get("open_times") or 0)
        speed_raw = row.get("speed")
        try:
            speed = float(speed_raw) if speed_raw is not None else None
        except (TypeError, ValueError):
            speed = None
        code = row["code"]
        name = row["name"]
        risk_tags, risk_hint = self._risk_for(code, name)
        return StockItem(
            code=code,
            name=name,
            market=row.get("market") or "",
            price=float(row.get("price") or 0),
            change_pct=float(row.get("change_pct") or 0),
            amount=float(row.get("amount") or 0),
            volume=float(row.get("volume") or 0),
            float_mv=float(row.get("float_mv") or 0),
            total_mv=float(row.get("total_mv") or 0),
            turnover=float(row.get("turnover") or 0),
            seal_amount=float(row.get("seal_amount") or 0),
            first_seal_time=row.get("first_seal_time") or "",
            last_seal_time=row.get("last_seal_time") or "",
            board_count=board,
            open_times=open_times,
            industry=row.get("industry") or "",
            concepts=list(row.get("concepts") or []),
            zt_stats=row.get("zt_stats") or "",
            status=status,
            board_tag=_board_tag(board, open_times),
            speed=speed,
            reason=str(row.get("reason") or ""),
            risk_tags=risk_tags,
            risk_hint=risk_hint,
        )

    def _risk_for(self, code: str, name: str = "") -> tuple[list[str], str]:
        hit = self._risk_map.get(code)
        if hit:
            tags = list(hit.get("risk_tags") or [])
            hint = str(hit.get("risk_hint") or "")
            if tags:
                return tags, hint or risk_hint_for(tags[0])
        rt = classify_risk_type(name)
        if rt:
            return [rt], risk_hint_for(rt)
        return [], ""

    def _apply_risk_to_stock(self, stock: StockItem) -> None:
        tags, hint = self._risk_for(stock.code, stock.name)
        stock.risk_tags = tags
        stock.risk_hint = hint

    def _apply_risk_to_lists(self, *lists: list[StockItem]) -> None:
        for lst in lists:
            for s in lst:
                self._apply_risk_to_stock(s)

    def _apply_risk_to_ladder(self, ladder: list[LadderGroup]) -> None:
        for g in ladder:
            for s in g.stocks:
                self._apply_risk_to_stock(s)

    async def refresh_risk(self, force: bool = False) -> dict[str, Any]:
        """刷新风险警示池，写入本地快照并生成加入/移除事件。"""
        date = today_yyyymmdd()
        rows: list[dict[str, Any]] = []
        source = "risk_board"

        # 优先尝试开盘啦避雷啦（公开接口暂不可用，失败则走风险警示板）
        try:
            from ..collectors.kaipanla import KaipanlaClient

            kpl = KaipanlaClient(timeout=8.0)
            try:
                hit = await asyncio.wait_for(kpl.fetch_bileila(0), timeout=6)
            finally:
                await kpl.aclose()
            if hit:
                # 真实结构待抓包确认后在此解析
                pass
        except Exception:
            pass

        try:
            rows = await asyncio.wait_for(self.client.fetch_risk_warning_board(), timeout=45)
        except Exception:
            rows = []

        # 若外部池失败，用名称规则从当前盯盘池兜底
        if not rows:
            for lst in (self.snapshot.zt, self.snapshot.lb, self.snapshot.zb, self.snapshot.dt):
                for s in lst:
                    rt = classify_risk_type(s.name)
                    if not rt:
                        continue
                    rows.append(
                        {
                            "code": s.code,
                            "name": s.name,
                            "risk_type": rt,
                            "risk_tags": [rt],
                            "risk_hint": risk_hint_for(rt),
                        }
                    )
            if rows:
                source = "name"
            elif self._risk_map and not force:
                return {
                    "count": len(self._risk_map),
                    "updated_at": self._risk_updated_at,
                    "source": self._risk_source,
                    "cached": True,
                }

        risk_map: dict[str, dict[str, Any]] = {}
        snap_rows: list[dict[str, Any]] = []
        for r in rows:
            code = str(r.get("code") or "").zfill(6)
            if not code.isdigit():
                continue
            rt = str(r.get("risk_type") or classify_risk_type(str(r.get("name") or "")) or "warn")
            tags = list(r.get("risk_tags") or [rt])
            hint = str(r.get("risk_hint") or risk_hint_for(rt))
            name = str(r.get("name") or code)
            risk_map[code] = {
                "code": code,
                "name": name,
                "risk_type": rt,
                "risk_tags": tags,
                "risk_hint": hint,
            }
            snap_rows.append({"code": code, "name": name, "risk_type": rt})

        # 与上一交易日快照对比，生成时间线事件
        try:
            prev_date = await load_prev_risk_trade_date(date)
            prev_rows = await load_risk_snapshot(prev_date) if prev_date else []
            prev_keys = {(r["code"], r["risk_type"]): r for r in prev_rows}
            cur_keys = {(r["code"], r["risk_type"]): r for r in snap_rows}
            events: list[dict[str, Any]] = []
            for key, r in cur_keys.items():
                if key not in prev_keys:
                    events.append(
                        {
                            "trade_date": date,
                            "code": r["code"],
                            "name": r["name"],
                            "risk_type": r["risk_type"],
                            "action": "add",
                        }
                    )
            for key, r in prev_keys.items():
                if key not in cur_keys:
                    events.append(
                        {
                            "trade_date": date,
                            "code": r["code"],
                            "name": r["name"],
                            "risk_type": r["risk_type"],
                            "action": "remove",
                        }
                    )
            # 首日无历史时，把当前池记为今日新加入，便于面板有内容
            if not prev_date and snap_rows and not events:
                for r in snap_rows:
                    events.append(
                        {
                            "trade_date": date,
                            "code": r["code"],
                            "name": r["name"],
                            "risk_type": r["risk_type"],
                            "action": "add",
                        }
                    )
            await replace_risk_snapshot(date, snap_rows)
            await upsert_risk_events(events)
        except Exception:
            pass

        self._risk_map = risk_map
        self._risk_updated_at = datetime.now().isoformat(timespec="seconds")
        self._risk_source = source

        # 回填当前快照中的风险标签
        self._apply_risk_to_lists(self.snapshot.zt, self.snapshot.lb, self.snapshot.zb, self.snapshot.dt)
        self._apply_risk_to_ladder(self.snapshot.ladder)
        try:
            await self._broadcast()
        except Exception:
            pass
        return {
            "count": len(risk_map),
            "updated_at": self._risk_updated_at,
            "source": source,
            "cached": False,
        }

    async def get_risk_alerts(self, tab: str = "latest") -> dict[str, Any]:
        """避雷啦面板数据：latest / st / delist。"""
        tab = (tab or "latest").strip().lower()
        if tab not in ("latest", "st", "delist"):
            tab = "latest"
        if not self._risk_map:
            try:
                await self.refresh_risk()
            except Exception:
                pass

        type_filter = None if tab == "latest" else tab
        events = await load_risk_events(limit_days=45, risk_type=type_filter)

        # 按日聚合
        by_date: dict[str, dict[str, list[dict[str, Any]]]] = {}
        for e in events:
            d = str(e.get("trade_date") or "")
            if len(d) == 8:
                label = f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
            else:
                label = d
            bucket = by_date.setdefault(label, {"added": [], "removed": []})
            item = {
                "code": e["code"],
                "name": e.get("name") or e["code"],
                "risk_type": e.get("risk_type") or "warn",
                "risk_tags": [e.get("risk_type") or "warn"],
                "risk_hint": risk_hint_for(str(e.get("risk_type") or "warn")),
            }
            if e.get("action") == "remove":
                bucket["removed"].append(item)
            else:
                bucket["added"].append(item)

        days = []
        for label in sorted(by_date.keys(), reverse=True):
            days.append(
                {
                    "date": label.replace("-", ""),
                    "date_label": label,
                    "added": by_date[label]["added"],
                    "removed": by_date[label]["removed"],
                }
            )

        # 当前在册列表（子 Tab 过滤）
        current = []
        for code, info in sorted(self._risk_map.items(), key=lambda x: x[1].get("name") or x[0]):
            rt = str(info.get("risk_type") or "")
            if type_filter and rt != type_filter:
                continue
            current.append(
                {
                    "code": code,
                    "name": info.get("name") or code,
                    "risk_type": rt,
                    "risk_tags": list(info.get("risk_tags") or [rt]),
                    "risk_hint": info.get("risk_hint") or risk_hint_for(rt),
                }
            )

        return {
            "tab": tab,
            "days": days,
            "current": current,
            "count": len(current),
            "updated_at": self._risk_updated_at,
            "source": self._risk_source or "eastmoney",
            "map": {c: {"risk_tags": v.get("risk_tags"), "risk_hint": v.get("risk_hint")} for c, v in self._risk_map.items()},
        }

    async def get_speed_rank(self, limit: int = 50) -> list[StockItem]:
        rows = await self.client.fetch_speed_rank(limit=limit)
        items: list[StockItem] = []
        for r in rows:
            s = self._to_stock(r, StockStatus.HOLDING)
            items.append(s.model_copy(update={"board_tag": "", "board_count": 1}))
        return items

    async def get_stocks_by_codes(self, codes: list[str]) -> list[StockItem]:
        """Resolve watchlist codes: prefer live pool snapshot, else rich quotes."""
        if not codes:
            return []
        snap = self.snapshot
        pool_map: dict[str, StockItem] = {}
        for lst in (snap.zt, snap.lb, snap.zb, snap.dt):
            for s in lst:
                pool_map.setdefault(s.code, s)

        missing = [c for c in codes if c not in pool_map]
        quotes: dict[str, dict[str, Any]] = {}
        if missing:
            try:
                quotes = await self.client.fetch_quotes_rich_batch(missing)
            except Exception:
                quotes = {}

        out: list[StockItem] = []
        for code in codes:
            if code in pool_map:
                out.append(pool_map[code])
                continue
            q = quotes.get(code)
            if not q:
                out.append(
                    StockItem(
                        code=code,
                        name=code,
                        status=StockStatus.HOLDING,
                        board_tag="",
                    )
                )
                continue
            out.append(
                StockItem(
                    code=code,
                    name=str(q.get("name") or code),
                    market=str(q.get("market") or ""),
                    price=float(q.get("price") or 0),
                    change_pct=float(q.get("change_pct") or 0),
                    amount=float(q.get("amount") or 0),
                    volume=float(q.get("volume") or 0),
                    float_mv=float(q.get("float_mv") or 0),
                    total_mv=float(q.get("total_mv") or 0),
                    turnover=float(q.get("turnover") or 0),
                    industry=str(q.get("industry") or ""),
                    concepts=list(q.get("concepts") or []),
                    status=StockStatus.HOLDING,
                    board_count=1,
                    board_tag="",
                )
            )
        return out

    def _build_ladder(
        self,
        zt: list[StockItem],
        zb: list[StockItem],
        y_zt: list[dict[str, Any]],
    ) -> list[LadderGroup]:
        y_map = {r["code"]: r for r in y_zt}
        buckets: dict[int, dict[str, StockItem]] = {}

        def put(level: int, item: StockItem) -> None:
            if level < 1:
                return
            bucket = buckets.setdefault(level, {})
            old = bucket.get(item.code)
            if old is None:
                bucket[item.code] = item
                return
            # priority: 成 > 炸 > 败
            rank = {StockStatus.SUCCESS: 3, StockStatus.BROKEN: 2, StockStatus.FAIL: 1}
            if rank.get(item.status, 0) >= rank.get(old.status, 0):
                bucket[item.code] = item

        # 成：今日 N+1 连板 → 落在 N进N+1（首板 board=1 不进此桶，见下方「首板」）
        for s in zt:
            if s.board_count <= 1:
                continue
            prev = s.board_count - 1
            put(prev, s.model_copy(update={"status": StockStatus.SUCCESS}))

        # 炸：仅当「昨日涨停池有记录」时归入昨日板数对应的 N进N+1
        # 昨日无记录的今日炸板 = 首板炸板，只进「首板」行
        for s in zb:
            yrow = y_map.get(s.code)
            if not yrow:
                continue
            key = int(yrow.get("board_count") or 1)
            put(
                key,
                s.model_copy(
                    update={
                        "status": StockStatus.BROKEN,
                        "board_count": key,
                        "market": s.market or yrow.get("market") or "",
                        "industry": s.industry or yrow.get("industry") or "",
                        "concepts": s.concepts
                        or list(yrow.get("concepts") or ([yrow.get("industry")] if yrow.get("industry") else [])),
                    }
                ),
            )

        # 败：昨日涨停、今日既未封住也未进炸板池
        zt_codes = {s.code for s in zt}
        zb_codes = {s.code for s in zb}
        for code, yrow in y_map.items():
            if code in zt_codes or code in zb_codes:
                continue
            bc = int(yrow.get("board_count") or 1)
            put(
                bc,
                StockItem(
                    code=code,
                    name=str(yrow.get("name") or code),
                    market=str(yrow.get("market") or ""),
                    board_count=bc,
                    status=StockStatus.FAIL,
                    change_pct=0.0,
                    industry=str(yrow.get("industry") or ""),
                    concepts=list(
                        yrow.get("concepts")
                        or ([yrow.get("industry")] if yrow.get("industry") else [])
                    ),
                    board_tag=f"{bc}连板" if bc > 1 else "首板",
                ),
            )

        def sort_stocks(items: list[StockItem]) -> list[StockItem]:
            order = {StockStatus.SUCCESS: 0, StockStatus.BROKEN: 1, StockStatus.FAIL: 2}

            def key(s: StockItem):
                return (order.get(s.status, 9), s.first_seal_time or "99:99:99", s.code)

            return sorted(items, key=key)

        groups: list[LadderGroup] = []
        for prev in sorted((k for k in buckets if k >= 1), reverse=True):
            stocks = sort_stocks(list(buckets[prev].values()))
            success = sum(1 for s in stocks if s.status == StockStatus.SUCCESS)
            total = len(stocks)
            rate = f"{success}/{total}={round(success / total * 100)}%" if total else "0/0=0%"
            groups.append(
                LadderGroup(
                    key=f"{prev}-{prev + 1}",
                    label=f"{prev}进{prev + 1}",
                    promotion_rate=rate,
                    stocks=stocks,
                )
            )

        # 首板：今日首板「成」+ 昨日不在涨停池的今日「炸」
        first_map: dict[str, StockItem] = {}
        for s in zt:
            if s.board_count <= 1:
                first_map[s.code] = s.model_copy(update={"status": StockStatus.SUCCESS})
        for s in zb:
            if s.code in y_map:
                # 昨日已涨停 → 只属于 N进N+1，不进首板
                continue
            first_map[s.code] = s.model_copy(update={"status": StockStatus.BROKEN})
        first_all = sort_stocks(list(first_map.values()))
        ok = sum(1 for s in first_all if s.status == StockStatus.SUCCESS)
        total = len(first_all)
        groups.append(
            LadderGroup(
                key="first",
                label="首板",
                promotion_rate=f"{ok}/{total}={round(ok / total * 100) if total else 0}%",
                stocks=first_all,
            )
        )
        return groups

    async def _enrich_ladder_fails(self, ladder: list[LadderGroup]) -> list[LadderGroup]:
        fail_codes = [
            s.code
            for g in ladder
            for s in g.stocks
            if s.status == StockStatus.FAIL
        ]
        seen: set[str] = set()
        uniq_codes: list[str] = []
        for c in fail_codes:
            if c not in seen:
                seen.add(c)
                uniq_codes.append(c)
        if not uniq_codes:
            return ladder

        quotes: dict[str, dict[str, Any]] = {}
        # 1) 腾讯批量（快、稳）
        try:
            quotes = await asyncio.wait_for(
                self.client.fetch_quotes_tencent_batch(uniq_codes),
                timeout=8,
            )
        except Exception:
            quotes = {}

        # 2) 缺口再走东财（限时，避免拖垮整轮 refresh）
        missing = [
            c
            for c in uniq_codes
            if c not in quotes
            or (
                abs(float(quotes[c].get("change_pct") or 0)) < 1e-12
                and float(quotes[c].get("price") or 0) <= 0
            )
        ]
        if missing:
            try:
                em = await asyncio.wait_for(
                    self.client.fetch_quotes_batch(missing),
                    timeout=6,
                )
                quotes.update(em)
            except Exception:
                pass

        # 3) 缓存成功的行情，下一轮超时也能回填
        for code, q in quotes.items():
            if q and (q.get("change_pct") is not None or q.get("price")):
                self._fail_quote_cache[code] = q

        for g in ladder:
            for i, s in enumerate(g.stocks):
                if s.status != StockStatus.FAIL:
                    continue
                q = quotes.get(s.code) or self._fail_quote_cache.get(s.code) or {}
                if not q:
                    continue
                pct = q.get("change_pct")
                try:
                    pct_f = float(pct) if pct is not None else s.change_pct
                except (TypeError, ValueError):
                    pct_f = s.change_pct
                g.stocks[i] = s.model_copy(
                    update={
                        "name": q.get("name") or s.name,
                        "change_pct": pct_f,
                        "price": float(q.get("price") or s.price or 0),
                    }
                )
        return ladder

    def _enrich_ladder_fails_from_cache(self, ladder: list[LadderGroup]) -> list[LadderGroup]:
        if not self._fail_quote_cache:
            return ladder
        for g in ladder:
            for i, s in enumerate(g.stocks):
                if s.status != StockStatus.FAIL:
                    continue
                if abs(s.change_pct) > 1e-9:
                    continue
                q = self._fail_quote_cache.get(s.code) or {}
                if not q:
                    continue
                try:
                    pct_f = float(q.get("change_pct") or 0)
                except (TypeError, ValueError):
                    continue
                g.stocks[i] = s.model_copy(
                    update={
                        "name": q.get("name") or s.name,
                        "change_pct": pct_f,
                        "price": float(q.get("price") or s.price or 0),
                    }
                )
        return ladder

    def _diff_speech(
        self,
        zt: list[StockItem],
        zb: list[StockItem],
    ) -> list[SpeechEvent]:
        events: list[SpeechEvent] = []
        zt_map = {s.code: s for s in zt}
        cur_zt = set(zt_map)
        cur_zb = {s.code for s in zb}

        for code in cur_zt - self._prev_zt_codes:
            s = zt_map[code]
            if s.board_count <= 1:
                events.append(
                    SpeechEvent(
                        type="zt",
                        code=code,
                        name=s.name,
                        board_count=s.board_count,
                        text=f"{s.name}涨停，首板",
                    )
                )
            else:
                events.append(
                    SpeechEvent(
                        type="lb",
                        code=code,
                        name=s.name,
                        board_count=s.board_count,
                        text=f"{s.name}涨停，{s.board_count}连板",
                    )
                )

        for code in cur_zt & self._prev_zt_codes:
            s = zt_map[code]
            prev_b = self._prev_board.get(code, s.board_count)
            if s.board_count > prev_b:
                events.append(
                    SpeechEvent(
                        type="lb",
                        code=code,
                        name=s.name,
                        board_count=s.board_count,
                        text=f"{s.name}晋级{s.board_count}连板",
                    )
                )

        zb_map = {s.code: s for s in zb}
        for code in cur_zb - self._prev_zb_codes:
            s = zb_map[code]
            events.append(
                SpeechEvent(
                    type="zb",
                    code=code,
                    name=s.name,
                    board_count=s.board_count,
                    text=f"{s.name}炸板",
                )
            )

        self._prev_zt_codes = cur_zt
        self._prev_zb_codes = cur_zb
        self._prev_board = {c: s.board_count for c, s in zt_map.items()}
        return events

    async def refresh(self) -> MarketSnapshot:
        async with self._lock:
            date = today_yyyymmdd()
            zt_rows: list[dict[str, Any]] = []
            zb_rows: list[dict[str, Any]] = []
            dt_rows: list[dict[str, Any]] = []
            try:
                # 若当日池为空（周末/节假日/接口抖动），回退到最近有数据的交易日
                from datetime import timedelta

                probe = datetime.now().date()
                for _ in range(12):
                    ds = probe.strftime("%Y%m%d")
                    try:
                        zt_rows, zb_rows, dt_rows = await asyncio.wait_for(
                            asyncio.gather(
                                self.client.fetch_zt_pool(ds),
                                self.client.fetch_zb_pool(ds),
                                self.client.fetch_dt_pool(ds),
                            ),
                            timeout=15,
                        )
                    except Exception:
                        zt_rows, zb_rows, dt_rows = [], [], []
                    if zt_rows or zb_rows or dt_rows:
                        date = ds
                        break
                    probe = probe - timedelta(days=1)
            except Exception:
                return self.snapshot

            # 空结果不要覆盖已有有效快照（防止限流/瞬时失败把盘面清空）
            if not zt_rows and not zb_rows and not dt_rows:
                if self.snapshot.zt or self.snapshot.zb or self.snapshot.dt:
                    return self.snapshot
                return self.snapshot

            zt = [self._to_stock(r, StockStatus.SUCCESS) for r in zt_rows]
            zb = [self._to_stock(r, StockStatus.BROKEN) for r in zb_rows]
            dt = [self._to_stock(r, StockStatus.FAIL) for r in dt_rows]

            # 成交量补齐放到后台，避免拖垮主刷新
            try:
                codes = [s.code for s in zt[:40]]
                vol_map = await asyncio.wait_for(
                    self.client.fetch_quotes_batch(codes),
                    timeout=8,
                )
                for s in zt:
                    q = vol_map.get(s.code) or {}
                    if q.get("volume"):
                        s.volume = float(q["volume"])
                    if q.get("amount") and not s.amount:
                        s.amount = float(q["amount"])
            except Exception:
                pass

            zt.sort(key=lambda s: (s.first_seal_time or "", s.code), reverse=True)
            lb = [s for s in zt if s.board_count >= 2]
            zb.sort(key=lambda s: (s.first_seal_time or "", s.code), reverse=True)

            y_zt_count = len(self._y_zt)
            y_lb = sum(1 for r in self._y_zt if int(r.get("board_count") or 1) >= 2)
            denom = len(zt) + len(zb)
            seal_today = round(len(zt) / denom * 100, 1) if denom else 0.0
            y_denom = y_zt_count + self._y_zb_count
            seal_y = round(y_zt_count / y_denom * 100, 1) if y_denom else 0.0

            summary = MarketSummary(
                zt_today=len(zt),
                zt_yesterday=y_zt_count,
                lb_today=len(lb),
                lb_yesterday=y_lb,
                seal_rate_today=seal_today,
                seal_rate_yesterday=seal_y,
                zb_today=len(zb),
                zb_yesterday=self._y_zb_count,
                dt_today=len(dt),
                dt_yesterday=self._y_dt_count,
            )

            speech = self._diff_speech(zt, zb)
            ladder = self._build_ladder(zt, zb, self._y_zt)
            try:
                ladder = await asyncio.wait_for(self._enrich_ladder_fails(ladder), timeout=12)
            except Exception:
                # 超时也尽量用缓存回填
                try:
                    ladder = await self._enrich_ladder_fails_from_cache(ladder)
                except Exception:
                    pass

            # 合并本地基本面缓存到全市场列表，并排队补齐缺失字段
            await self._merge_and_enqueue_funds(zt + lb + zb + dt)
            # 天梯含败股等，单独回填地域等基本面
            await self._merge_and_enqueue_funds(
                [s for g in ladder for s in g.stocks]
            )

            # 叠加避雷啦风险标签
            self._apply_risk_to_lists(zt, lb, zb, dt)
            self._apply_risk_to_ladder(ladder)

            self.snapshot = MarketSnapshot(
                trade_date=date,
                updated_at=datetime.now().isoformat(timespec="seconds"),
                summary=summary,
                zt=zt,
                lb=lb,
                zb=zb,
                dt=dt,
                ladder=ladder,
                speech_events=speech,
            )

            try:
                await upsert_zt_history(date, zt_rows)
            except Exception:
                pass
            await self._broadcast()
            return self.snapshot

    async def poll_loop(self, interval_trading: float, interval_idle: float) -> None:
        from ..db import load_user_config

        await self.warmup_yesterday()
        try:
            await self.refresh_risk()
        except Exception:
            pass
        while True:
            try:
                await self.refresh()
            except Exception:
                pass
            try:
                cfg = load_user_config()
                user_iv = float(getattr(cfg.fields, "poll_interval_sec", None) or interval_trading)
            except Exception:
                user_iv = interval_trading
            user_iv = max(1.0, min(30.0, user_iv))
            delay = user_iv if _is_trading_time() else interval_idle
            await asyncio.sleep(delay)

    async def _merge_and_enqueue_funds(self, stocks: list[StockItem]) -> None:
        """从 SQLite 合并已有基本面；缺失的入队后台补齐。"""
        unique: list[StockItem] = []
        seen_codes: set[str] = set()
        for s in stocks:
            if s.code in seen_codes:
                continue
            seen_codes.add(s.code)
            unique.append(s)

        async def _load(s: StockItem) -> tuple[StockItem, dict | None]:
            try:
                return s, await get_fundamentals(s.code)
            except Exception:
                return s, None

        # 并行读库，避免刷新被逐票拖慢
        loaded = await asyncio.gather(*[_load(s) for s in unique])
        now = datetime.now().timestamp()
        for s, fund in loaded:
            if fund:
                _apply_fund_fields(s, fund)
                if _fund_list_complete(fund):
                    self._fund_complete.add(s.code)
            if s.code in self._fund_complete or s.code in self._fund_inflight:
                continue
            # 失败/残缺冷却 45 秒，避免狂打接口
            retry_at = getattr(self, "_fund_retry_at", {}).get(s.code, 0)
            if now < retry_at:
                continue
            self._fund_inflight.add(s.code)
            try:
                self._fund_queue.put_nowait(s.code)
            except Exception:
                self._fund_inflight.discard(s.code)

    def _apply_fund_to_live_snapshot(self, code: str, fund: dict[str, Any]) -> bool:
        code = code.zfill(6)
        hit = False
        for bucket in (self.snapshot.zt, self.snapshot.lb, self.snapshot.zb, self.snapshot.dt):
            for s in bucket:
                if s.code == code:
                    _apply_fund_fields(s, fund)
                    hit = True
        for g in self.snapshot.ladder:
            for s in g.stocks:
                if s.code == code:
                    _apply_fund_fields(s, fund)
                    hit = True
        return hit

    async def fund_worker(self) -> None:
        """并行补齐基本面，写库并回填当前快照。"""
        sem = asyncio.Semaphore(3)

        async def _one() -> None:
            while True:
                code = await self._fund_queue.get()
                try:
                    async with sem:
                        fund = await self.refresh_fundamentals(code, force=False)
                    if _fund_list_complete(fund):
                        self._fund_complete.add(code)
                        self._fund_retry_at.pop(code, None)
                    else:
                        # 仍不完整：短暂冷却后允许再次入队
                        self._fund_complete.discard(code)
                        self._fund_retry_at[code] = datetime.now().timestamp() + 45
                    if self._apply_fund_to_live_snapshot(code, fund):
                        if not self._fund_broadcast_pending:
                            self._fund_broadcast_pending = True
                            asyncio.create_task(self._deferred_fund_broadcast())
                except Exception:
                    self._fund_complete.discard(code)
                    self._fund_retry_at[code] = datetime.now().timestamp() + 45
                finally:
                    self._fund_inflight.discard(code)
                    self._fund_queue.task_done()

        await asyncio.gather(*[_one() for _ in range(3)])

    async def _deferred_fund_broadcast(self) -> None:
        await asyncio.sleep(1.2)
        self._fund_broadcast_pending = False
        try:
            await self._broadcast()
        except Exception:
            pass

    async def risk_worker(self, interval_sec: float = 600) -> None:
        """定时刷新风险警示池（默认 10 分钟）。"""
        await asyncio.sleep(8)
        while True:
            try:
                await self.refresh_risk()
            except Exception:
                pass
            await asyncio.sleep(max(120.0, float(interval_sec or 600)))

    async def refresh_fundamentals(self, code: str, force: bool = False) -> dict:
        code = code.zfill(6)
        ttl = 30 * 60 if _is_trading_time() else 6 * 3600
        if not force:
            cached = await get_fundamentals(code)
            if cached and cached.get("updated_at") and _fund_list_complete(cached):
                try:
                    ts = datetime.fromisoformat(cached["updated_at"])
                    age = (datetime.now() - ts).total_seconds()
                    if age < ttl:
                        seal_r, board_r = await calc_year_rates(code)
                        cached["year_seal_rate"] = seal_r
                        cached["year_board_rate"] = board_r
                        cached["_cache_hit"] = True
                        return cached
                except Exception:
                    pass

        data = await self.client.fetch_fundamentals(code)
        data["updated_at"] = datetime.now().isoformat(timespec="seconds")
        # 若新结果缺字段而旧缓存有，合并保留
        try:
            old = await get_fundamentals(code)
        except Exception:
            old = None
        if old:
            for k in (
                "region",
                "industry",
                "concepts",
                "free_float_mv",
                "top10_holder_pct",
                "top10_holders",
                "top10_holders_date",
                "former_names",
                "total_mv",
                "float_mv",
            ):
                if data.get(k) in (None, "", []) and old.get(k) not in (None, "", []):
                    data[k] = old[k]
        await upsert_fundamentals(code, data)
        seal_r, board_r = await calc_year_rates(code)
        data["year_seal_rate"] = seal_r
        data["year_board_rate"] = board_r
        data["_cache_hit"] = False
        return data

    async def get_stock_detail(self, code: str) -> dict:
        """Merge fundamentals into current snapshot stock; prefer cache (no force)."""
        code = code.zfill(6)
        # 先出列表快照，再合并缓存/网络基本面，避免 force 全量打接口
        fund = await self.refresh_fundamentals(code, force=False)
        # 旧缓存缺股东明细 / 曾用名时强制补拉一次（抽屉专用字段）
        if fund.get("top10_holders") is None or fund.get("former_names") is None:
            fund = await self.refresh_fundamentals(code, force=True)
        base = None
        for bucket in (self.snapshot.zt, self.snapshot.lb, self.snapshot.zb, self.snapshot.dt):
            for s in bucket:
                if s.code == code:
                    base = s.model_dump()
                    break
            if base:
                break
        if not base:
            base = {"code": code, "name": fund.get("name") or code}

        for k in (
            "price",
            "total_mv",
            "float_mv",
            "free_float_mv",
            "top10_holder_pct",
            "top10_holders",
            "top10_holders_date",
            "former_names",
            "region",
            "industry",
            "concepts",
            "year_seal_rate",
            "year_board_rate",
            "change_pct",
        ):
            if fund.get(k) not in (None, "", []):
                base[k] = fund[k]
        # 允许空列表写回（表示已拉取且无曾用名 / 无股东）
        if isinstance(fund.get("top10_holders"), list):
            base["top10_holders"] = fund["top10_holders"]
        if isinstance(fund.get("former_names"), list):
            base["former_names"] = fund["former_names"]
        if fund.get("top10_holders_date"):
            base["top10_holders_date"] = fund["top10_holders_date"]
        if fund.get("name"):
            base["name"] = fund["name"]
        base["_cache_hit"] = bool(fund.get("_cache_hit"))
        return base

    @staticmethod
    def _norm_date(date: str | None) -> str:
        raw = (date or "").replace("-", "").strip()
        if len(raw) == 8 and raw.isdigit():
            return raw
        return today_yyyymmdd()

    @staticmethod
    def _avg_change(stocks: list[StockItem]) -> float:
        if not stocks:
            return 0.0
        return round(sum(s.change_pct for s in stocks) / len(stocks), 2)

    def _group_by_board(self, stocks: list[StockItem]) -> list[HistoryGroup]:
        buckets: dict[int, list[StockItem]] = {}
        for s in stocks:
            bc = max(1, int(s.board_count or 1))
            buckets.setdefault(bc, []).append(s)
        groups: list[HistoryGroup] = []
        for bc in sorted(buckets.keys(), reverse=True):
            items = sorted(
                buckets[bc],
                key=lambda x: (x.first_seal_time or "99:99:99", x.code),
            )
            label = "首板" if bc <= 1 else f"{bc}连板"
            groups.append(
                HistoryGroup(
                    key=f"board-{bc}",
                    label=label,
                    avg_change_pct=self._avg_change(items),
                    count=len(items),
                    stocks=items,
                )
            )
        return groups

    def _group_by_industry(self, stocks: list[StockItem]) -> list[HistoryGroup]:
        buckets: dict[str, list[StockItem]] = {}
        for s in stocks:
            key = (s.industry or "").strip() or "其他"
            buckets.setdefault(key, []).append(s)
        groups: list[HistoryGroup] = []
        for name, items in buckets.items():
            items = sorted(
                items,
                key=lambda x: (x.first_seal_time or "99:99:99", x.code),
            )
            groups.append(
                HistoryGroup(
                    key=f"ind-{name}",
                    label=name,
                    avg_change_pct=self._avg_change(items),
                    count=len(items),
                    stocks=items,
                )
            )
        groups.sort(key=lambda g: (-g.count, g.label))
        return groups

    def _group_by_block_top(
        self,
        blocks: list[dict[str, Any]],
        stock_map: dict[str, StockItem],
    ) -> list[HistoryGroup]:
        """用同花顺概念板块分组；未入板块的股票归入「其他」。"""
        used: set[str] = set()
        groups: list[HistoryGroup] = []
        for b in blocks:
            name = str(b.get("name") or "").strip() or "概念"
            codes = []
            for row in b.get("stock_list") or []:
                code = str(row.get("code") or "").zfill(6)
                if code and code in stock_map:
                    codes.append(code)
            items = [stock_map[c] for c in codes if c not in used]
            for s in items:
                used.add(s.code)
            if not items:
                continue
            items = sorted(
                items,
                key=lambda x: (x.first_seal_time or "99:99:99", x.code),
            )
            groups.append(
                HistoryGroup(
                    key=f"blk-{name}",
                    label=name,
                    avg_change_pct=self._avg_change(items),
                    count=len(items),
                    stocks=items,
                )
            )
        rest = [s for s in stock_map.values() if s.code not in used]
        if rest:
            rest = sorted(
                rest,
                key=lambda x: (x.first_seal_time or "99:99:99", x.code),
            )
            groups.append(
                HistoryGroup(
                    key="blk-其他",
                    label="其他",
                    avg_change_pct=self._avg_change(rest),
                    count=len(rest),
                    stocks=rest,
                )
            )
        groups.sort(key=lambda g: (-g.count, g.label))
        return groups

    async def get_zt_history(self, date: str | None, ths_client: Any = None) -> dict[str, Any]:
        """按日期回溯涨停：开盘啦连板梯队 + 概念分类（不再使用东财）。"""
        from ..collectors.kaipanla import KaipanlaClient
        from .ttl_cache import ttl_cache, trading_ttl

        ds = self._norm_date(date)
        cache_key = f"history_zt:kpl:v1:{ds}"
        cached = await ttl_cache.get(cache_key)
        if (
            cached
            and isinstance(cached, dict)
            and int(cached.get("count") or 0) > 0
            and cached.get("board_groups") is not None
        ):
            return cached

        kpl = KaipanlaClient()
        try:
            raw = await kpl.fetch_limit_ladder(ds)
        finally:
            await kpl.aclose()

        items: list[StockItem] = []
        for row in raw.get("items") or []:
            board = int(row.get("board_count") or 1)
            open_times = int(row.get("open_times") or 0)
            s = StockItem(
                code=str(row.get("code") or "").zfill(6),
                name=str(row.get("name") or ""),
                market=str(row.get("market") or ""),
                price=float(row.get("price") or 0),
                change_pct=float(row.get("change_pct") or 0),
                amount=float(row.get("amount") or 0),
                volume=float(row.get("volume") or 0),
                float_mv=float(row.get("float_mv") or 0),
                total_mv=float(row.get("total_mv") or 0),
                turnover=float(row.get("turnover") or 0),
                seal_amount=float(row.get("seal_amount") or 0),
                first_seal_time=str(row.get("first_seal_time") or ""),
                last_seal_time=str(row.get("last_seal_time") or ""),
                board_count=board,
                open_times=open_times,
                industry=str(row.get("industry") or ""),
                concepts=list(row.get("concepts") or []),
                zt_stats=str(row.get("zt_stats") or ""),
                status=StockStatus.SUCCESS,
                board_tag=_board_tag(board, open_times),
                reason=str(row.get("reason") or ""),
            )
            items.append(s)

        stock_map = {s.code: s for s in items}

        def _hydrate(group_rows: list[dict[str, Any]]) -> list[StockItem]:
            out: list[StockItem] = []
            for r in group_rows:
                code = str(r.get("code") or "").zfill(6)
                if code in stock_map:
                    out.append(stock_map[code])
            return out

        concept_groups: list[HistoryGroup] = []
        for g in raw.get("concept_groups") or []:
            stocks = _hydrate(g.get("stocks") or [])
            concept_groups.append(
                HistoryGroup(
                    key=str(g.get("key") or g.get("label") or ""),
                    label=str(g.get("label") or ""),
                    avg_change_pct=float(g.get("avg_change_pct") or self._avg_change(stocks)),
                    count=int(g.get("count") or len(stocks)),
                    amount=float(g.get("amount") or sum(float(s.amount or 0) for s in stocks)),
                    stocks=stocks,
                )
            )

        board_groups: list[HistoryGroup] = []
        for g in raw.get("board_groups") or []:
            stocks = _hydrate(g.get("stocks") or [])
            board_groups.append(
                HistoryGroup(
                    key=str(g.get("key") or g.get("label") or ""),
                    label=str(g.get("label") or ""),
                    avg_change_pct=float(g.get("avg_change_pct") or self._avg_change(stocks)),
                    count=int(g.get("count") or len(stocks)),
                    stocks=stocks,
                )
            )

        payload = {
            "date": ds,
            "date_label": raw.get("date_label") or ds,
            "count": len(items),
            "zt_count": int(raw.get("zt_count") or len(items)),
            "dt_count": int(raw.get("dt_count") or 0),
            "expression": raw.get("expression") or {},
            "items": [s.model_dump() for s in items],
            "concept_groups": [g.model_dump() for g in concept_groups],
            "board_groups": [g.model_dump() for g in board_groups],
            "source": "kaipanla",
        }
        if items:
            ttl = trading_ttl(45, 3600) if ds == today_yyyymmdd() else 6 * 3600
            await ttl_cache.set(cache_key, payload, ttl, kind="history_zt")
            try:
                await upsert_zt_history(
                    ds,
                    [
                        {
                            "code": s.code,
                            "name": s.name,
                            "board_count": s.board_count,
                            "industry": s.industry or s.reason or "",
                            "reason": s.reason or s.industry or "",
                        }
                        for s in items
                    ],
                )
            except Exception:
                pass
        else:
            await ttl_cache.set(cache_key, payload, 60, kind="history_zt")
        return payload

    @staticmethod
    def _board_label(board: int) -> str:
        b = max(1, int(board or 1))
        return "首板" if b <= 1 else f"{b}连板"

    @staticmethod
    def _is_st_like_name(name: str) -> bool:
        """开盘啦涨停梯队通常不含 ST/*ST/退市股；东财 DMSK 会把 5% 板算进来。"""
        n = (name or "").strip().replace("ＳＴ", "ST").replace("＊", "*")
        if not n:
            return False
        return n.startswith(("*ST", "ST*", "ST", "退市"))

    @staticmethod
    def _limit_thr_for(name: str, code: str) -> float:
        if MarketService._is_st_like_name(name):
            return 4.85
        if (code or "").startswith(("300", "301", "688")):
            return 19.5
        return 9.5

    @staticmethod
    def _compute_board_streaks(dates_asc: list[str]) -> dict[str, int]:
        """按相邻涨停日估算连板数（间隔≤4个自然日视为连板，覆盖周末）。"""
        from datetime import datetime as _dt

        boards: dict[str, int] = {}
        prev: str | None = None
        prev_board = 0
        for ds in dates_asc:
            if prev is None:
                boards[ds] = 1
            else:
                try:
                    gap = (_dt.strptime(ds, "%Y%m%d") - _dt.strptime(prev, "%Y%m%d")).days
                except ValueError:
                    gap = 99
                boards[ds] = prev_board + 1 if 1 <= gap <= 4 else 1
            prev = ds
            prev_board = boards[ds]
        return boards

    @staticmethod
    def _kline_pct_map(bars: list[dict[str, Any]]) -> dict[str, float]:
        """YYYYMMDD -> 涨跌幅%；缺省 pct 时用收盘价回算。"""
        out: dict[str, float] = {}
        prev_close = 0.0
        for b in bars or []:
            ds = str(b.get("date") or "").replace("-", "")[:8]
            if len(ds) != 8 or not ds.isdigit():
                continue
            close = float(b.get("close") or 0)
            pct = float(b.get("pct") or 0)
            if abs(pct) < 1e-9 and prev_close > 0 and close > 0:
                pct = (close - prev_close) / prev_close * 100
            out[ds] = pct
            if close > 0:
                prev_close = close
        return out

    async def resolve_stock_query(self, q: str, limit: int = 12) -> list[dict[str, Any]]:
        """按代码 / 现用名 / 曾用名解析个股候选。"""
        q = (q or "").strip()
        if not q:
            return []
        limit = max(1, min(30, int(limit or 12)))
        merged: dict[str, dict[str, Any]] = {}

        if q.isdigit() and len(q) <= 6:
            code = q.zfill(6)
            fund = await get_fundamentals(code)
            merged[code] = {
                "code": code,
                "name": (fund or {}).get("name") or code,
                "former_names": (fund or {}).get("former_names") or [],
                "match_via": "code",
            }

        local = await search_local_stocks(q, limit=limit)
        for item in local:
            code = str(item.get("code") or "").zfill(6)
            if not code.isdigit():
                continue
            prev = merged.get(code)
            if not prev or (item.get("match_via") == "former" and prev.get("match_via") != "former"):
                merged[code] = item
            elif prev and not prev.get("former_names") and item.get("former_names"):
                prev["former_names"] = item["former_names"]

        try:
            remote = await self.client.search_stocks(q, limit=limit)
        except Exception:
            remote = []
        for item in remote:
            code = str(item.get("code") or "").zfill(6)
            if not code.isdigit():
                continue
            if code not in merged:
                merged[code] = {
                    "code": code,
                    "name": item.get("name") or code,
                    "former_names": [],
                    "match_via": "name",
                    "market": item.get("market") or "",
                }
            elif not merged[code].get("name") or merged[code]["name"] == code:
                merged[code]["name"] = item.get("name") or merged[code]["name"]

        # 补齐曾用名（本地缓存有则用）
        for code, item in list(merged.items()):
            if item.get("former_names"):
                continue
            fund = await get_fundamentals(code)
            if fund:
                if fund.get("former_names"):
                    item["former_names"] = fund["former_names"]
                if fund.get("name") and (not item.get("name") or item["name"] == code):
                    item["name"] = fund["name"]

        def _rank(it: dict[str, Any]) -> tuple:
            name = str(it.get("name") or "")
            former = it.get("former_names") or []
            code = str(it.get("code") or "")
            if code == q.zfill(6) and q.isdigit():
                return (0, code)
            if name == q:
                return (1, code)
            if q in former:
                return (2, code)
            if name.startswith(q):
                return (3, code)
            if any(str(fn).startswith(q) for fn in former):
                return (4, code)
            return (5, code)

        items = sorted(merged.values(), key=_rank)
        return items[:limit]

    async def get_stock_zt_history(
        self,
        q: str = "",
        code: str = "",
        ths_client: Any = None,
    ) -> dict[str, Any]:
        """个股历史涨停日期列表：连板数 + 涨停原因，供历史回溯搜索跳转。"""
        from .ttl_cache import ttl_cache, trading_ttl

        q = (q or "").strip()
        code = (code or "").strip()
        if not code and q:
            matches = await self.resolve_stock_query(q, limit=12)
            if not matches:
                return {"query": q, "matches": [], "stock": None, "items": [], "count": 0}
            # 唯一命中或精确代码/全名/曾用名 → 直接查；否则返回候选
            exact = [
                m
                for m in matches
                if (q.isdigit() and m["code"] == q.zfill(6))
                or m.get("name") == q
                or q in (m.get("former_names") or [])
            ]
            if len(exact) == 1:
                code = exact[0]["code"]
                stock_meta = exact[0]
            elif len(matches) == 1:
                code = matches[0]["code"]
                stock_meta = matches[0]
            else:
                return {
                    "query": q,
                    "matches": matches,
                    "stock": None,
                    "items": [],
                    "count": 0,
                    "need_select": True,
                }
        elif code:
            code = code.zfill(6)
            matches = await self.resolve_stock_query(code, limit=1)
            stock_meta = matches[0] if matches else {"code": code, "name": code, "former_names": []}
        else:
            return {"query": q, "matches": [], "stock": None, "items": [], "count": 0}

        cache_key = f"history_stock_zt:v4:{code}"
        cached = await ttl_cache.get(cache_key)
        if cached and isinstance(cached, dict) and cached.get("items") is not None:
            cached = {**cached, "query": q or cached.get("query") or ""}
            return cached

        local_rows = await list_zt_history_by_code(code)
        local_by_date = {str(r["trade_date"]): r for r in local_rows}

        try:
            em_rows = await self.client.fetch_stock_limitup_dates(code)
        except Exception:
            em_rows = []

        name = str(stock_meta.get("name") or code)
        first_seal: dict[str, str] = {}
        em_name: dict[str, str] = {}
        candidates: set[str] = set()
        rejected: set[str] = set()

        # 东财 DMSK：去掉 ST/*ST/退市（开盘啦梯队不含这些 5% 板）
        for r in em_rows:
            ds = str(r.get("trade_date") or "")
            if len(ds) != 8 or not ds.isdigit():
                continue
            hist_name = str(r.get("name") or "")
            em_name[ds] = hist_name
            if r.get("first_seal_time"):
                first_seal[ds] = str(r["first_seal_time"])
            if self._is_st_like_name(hist_name):
                rejected.add(ds)
                continue
            candidates.add(ds)

        # 本地仅保留「有涨停原因」的记录（来自开盘啦回写，可信）
        for ds, r in local_by_date.items():
            loc_name = str(r.get("name") or "")
            if self._is_st_like_name(loc_name):
                rejected.add(ds)
                continue
            if str(r.get("reason") or r.get("industry") or "").strip():
                candidates.add(ds)

        # 开盘啦日缓存：在池中 → 采纳；已加载但不在池中 → 剔除
        reason_map: dict[str, str] = {}
        trusted_board: dict[str, int] = {}
        for ds in list(candidates | rejected):
            hit = await ttl_cache.get(f"history_zt:kpl:v1:{ds}")
            if not isinstance(hit, dict) or int(hit.get("count") or 0) <= 0:
                continue
            found = None
            for s in hit.get("items") or []:
                if str(s.get("code") or "").zfill(6) == code:
                    found = s
                    break
            if found:
                candidates.add(ds)
                rejected.discard(ds)
                if found.get("reason") or found.get("industry"):
                    reason_map[ds] = str(found.get("reason") or found.get("industry") or "")
                if found.get("board_count"):
                    trusted_board[ds] = max(1, int(found.get("board_count") or 1))
            else:
                candidates.discard(ds)
                rejected.add(ds)

        # 本地原因回填（不信任本地 board_count，避免脏数据抬高连板）
        for ds, r in local_by_date.items():
            if ds not in candidates:
                continue
            if not reason_map.get(ds) and (r.get("reason") or r.get("industry")):
                reason_map[ds] = str(r.get("reason") or r.get("industry") or "")

        # 对仍缺校验的日期：用同花顺涨停池确认（与开盘啦口径更接近）
        pending = [ds for ds in sorted(candidates, reverse=True) if ds not in reason_map][:40]
        if pending and ths_client is not None:
            from ..collectors.ths import ThsClient

            ths = ths_client if isinstance(ths_client, ThsClient) else ThsClient()
            sem = asyncio.Semaphore(4)

            async def _probe_ths(ds: str) -> tuple[str, bool, str, int]:
                pool_key = f"ths_pool:{ds}"
                hit = await ttl_cache.get(pool_key)
                pool: list = hit if isinstance(hit, list) else []
                fetched = False
                if not isinstance(hit, list):
                    async with sem:
                        try:
                            pool = await ths.fetch_limit_up_pool(ds)
                            fetched = True
                        except Exception:
                            pool = []
                    await ttl_cache.set(
                        pool_key, pool, trading_ttl(120, 3600), kind="ths_pool"
                    )
                for row in pool:
                    if str(row.get("code") or "").zfill(6) != code:
                        continue
                    reason = str(row.get("reason_type") or "").strip()
                    board = _parse_board_count(0, row.get("high_days"))
                    return ds, True, reason, board
                # 成功拉到非空池但没有该股 → 当日未进涨停池
                if fetched and pool:
                    return ds, False, "", 0
                if isinstance(hit, list) and hit:
                    return ds, False, "", 0
                return ds, True, "", 0  # 无法确认时先保留，交给 K 线兜底

            results = await asyncio.gather(*[_probe_ths(ds) for ds in pending])
            for ds, keep, reason, board in results:
                if not keep:
                    candidates.discard(ds)
                    rejected.add(ds)
                    continue
                if reason:
                    reason_map[ds] = reason
                if board > trusted_board.get(ds, 1):
                    trusted_board[ds] = board

        # K 线兜底：剔除明显未触及普通涨停阈值的日期
        try:
            kline = await self.client.fetch_kline(code, limit=500)
            pct_map = self._kline_pct_map(list(kline.get("bars") or []))
        except Exception:
            pct_map = {}
        for ds in list(candidates):
            if ds not in pct_map:
                continue
            hist = em_name.get(ds) or str((local_by_date.get(ds) or {}).get("name") or name)
            # ST 日若仍混入，一律丢弃
            if self._is_st_like_name(hist):
                candidates.discard(ds)
                rejected.add(ds)
                continue
            thr = self._limit_thr_for(hist, code)
            if pct_map[ds] < thr - 0.2:
                candidates.discard(ds)
                rejected.add(ds)

        dates_desc = sorted(candidates, reverse=True)
        streak = self._compute_board_streaks(list(reversed(dates_desc)))
        board_map: dict[str, int] = dict(streak)
        for ds, bc in trusted_board.items():
            if ds in board_map and bc > board_map.get(ds, 1):
                board_map[ds] = bc

        items: list[dict[str, Any]] = []
        for ds in dates_desc:
            board = board_map.get(ds) or 1
            row_name = (
                em_name.get(ds)
                or str((local_by_date.get(ds) or {}).get("name") or "")
                or name
            )
            items.append(
                {
                    "date": ds,
                    "date_label": f"{ds[0:4]}-{ds[4:6]}-{ds[6:8]}",
                    "board_count": board,
                    "board_label": self._board_label(board),
                    "reason": reason_map.get(ds) or "",
                    "first_seal_time": first_seal.get(ds) or "",
                    "name": row_name,
                }
            )

        # 清理误写入的脏数据，并回写校验后的结果
        try:
            if rejected:
                await delete_zt_history_dates(code, sorted(rejected))
            for it in items:
                await upsert_zt_history(
                    it["date"],
                    [
                        {
                            "code": code,
                            "name": it.get("name") or name,
                            "board_count": it["board_count"],
                            "industry": it.get("reason") or "",
                            "reason": it.get("reason") or "",
                        }
                    ],
                )
        except Exception:
            pass

        payload = {
            "query": q,
            "stock": {
                "code": code,
                "name": name,
                "former_names": stock_meta.get("former_names") or [],
            },
            "matches": [],
            "items": items,
            "count": len(items),
            "need_select": False,
        }
        await ttl_cache.set(cache_key, payload, 30 * 60, kind="history_stock_zt")
        return payload

    async def history_backfill_worker(self, target_days: int = 120) -> None:
        """Gradually fill zt_history so year seal/board rates become meaningful."""
        await asyncio.sleep(15)
        while True:
            try:
                n = await count_history_dates()
                marker = await get_meta("history_backfill_done")
                if marker == "1" and n >= target_days:
                    await asyncio.sleep(3600)
                    continue
                async for ds, rows in self.client.iter_recent_zt_pools(target_days):
                    await upsert_zt_history(ds, rows)
                    await asyncio.sleep(1.0)  # 降低与实时池争抢
                await set_meta("history_backfill_done", "1")
            except Exception:
                pass
            await asyncio.sleep(3600)

    @staticmethod
    def format_money(v: float) -> str:
        return _fmt_money(v)


market_service = MarketService()
