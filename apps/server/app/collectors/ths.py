from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

import httpx

from .eastmoney import EastMoneyClient, classify_risk_type

THS_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    ),
    "Referer": "https://data.10jqka.com.cn/datacenter/limit_up/",
}

THS_POOL_FIELDS = (
    "code,name,change_rate,latest,reason_type,reason_info,limit_up_suc_rate,"
    "currency_value,first_limit_up_time,last_limit_up_time,order_amount,"
    "order_volume_ratio,high,continue_num,change_tag,is_again_limit"
)

TAG_MAP = {
    "LIMIT_BACK": "回封板",
    "FIRST_LIMIT": "首板",
    "NATURAL_DRAW": "自然涨停",
    "ONE_WORD": "一字板",
    "T_WORD": "T字板",
}


class ThsClient:
    def __init__(self, timeout: float = 12.0) -> None:
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                headers=THS_HEADERS,
                timeout=self._timeout,
                follow_redirects=True,
                limits=httpx.Limits(max_connections=12, max_keepalive_connections=6),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def _get(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        client = await self._ensure_client()
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()

    async def fetch_limit_up_pool(self, date: str | None = None) -> list[dict[str, Any]]:
        """date: YYYYMMDD；返回含涨停原因、封单额等字段。"""
        params: dict[str, Any] = {
            "filter": "HS,GEM2STAR",
            "order_field": "first_limit_up_time",
            "order_type": "0",
            "limit": "200",
            "page": "1",
            "field": THS_POOL_FIELDS,
        }
        if date:
            params["date"] = date.replace("-", "")
        data = await self._get(
            "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool",
            params,
        )
        # THS 成功码为 0；部分失败返回 -1
        if data.get("status_code") not in (0, "0"):
            return []
        payload = data.get("data") or {}
        return list(payload.get("info") or [])

    async def fetch_block_top(self, date: str | None = None) -> list[dict[str, Any]]:
        """按概念板块聚合的涨停列表；历史日期未必支持，失败返回空。"""
        params: dict[str, Any] = {
            "filter": "HS,GEM2STAR",
            "order_field": "limit_up_num",
            "order_type": "1",
            "limit": "80",
            "page": "1",
        }
        if date:
            params["date"] = date.replace("-", "")
        try:
            data = await self._get(
                "https://data.10jqka.com.cn/dataapi/limit_up/block_top",
                params,
            )
        except Exception:
            return []
        if data.get("status_code") not in (0, "0", None):
            return []
        payload = data.get("data")
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            return list(payload.get("info") or payload.get("list") or [])
        return []

    async def fetch_lower_limit_pool(self, date: str | None = None) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "filter": "HS,GEM2STAR",
            "order_field": "first_limit_up_time",
            "order_type": "0",
            "limit": "200",
            "page": "1",
        }
        if date:
            params["date"] = date.replace("-", "")
        data = await self._get(
            "https://data.10jqka.com.cn/dataapi/limit_up/lower_limit_pool",
            params,
        )
        if data.get("status_code") not in (0, "0", None):
            return []
        payload = data.get("data") or {}
        return list(payload.get("info") or [])

    async def fetch_open_limit_pool(self, date: str | None = None) -> list[dict[str, Any]]:
        """打开涨停/炸板池。last_limit_up_time 为炸板时刻（unix 秒）。"""
        params: dict[str, Any] = {
            "filter": "HS,GEM2STAR",
            "order_field": "first_limit_up_time",
            "order_type": "0",
            "limit": "200",
            "page": "1",
            "field": (
                "code,name,change_rate,latest,first_limit_up_time,last_limit_up_time,"
                "open_num,change_tag,is_again_limit,currency_value,reason_type"
            ),
        }
        if date:
            params["date"] = date.replace("-", "")
        try:
            data = await self._get(
                "https://data.10jqka.com.cn/dataapi/limit_up/open_limit_pool",
                params,
            )
        except Exception:
            return []
        if data.get("status_code") not in (0, "0", None):
            return []
        payload = data.get("data") or {}
        return list(payload.get("info") or [])


def ths_ts_to_hms(raw: Any) -> str:
    """同花顺封板/炸板时间：unix 秒 → HH:MM:SS。"""
    if raw is None or raw == "":
        return ""
    try:
        n = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        s = str(raw).strip()
        if ":" in s:
            return s if len(s) >= 5 else ""
        return ""
    if n <= 0:
        return ""
    if n > 10_000_000_000:
        n //= 1000
    try:
        return datetime.fromtimestamp(n).strftime("%H:%M:%S")
    except (OSError, OverflowError, ValueError):
        return ""


def _limit_threshold(code: str) -> float:
    """普通股跌停辅助判定阈值（基因不含 ST 5% 板）。"""
    if code.startswith(("300", "301", "688")):
        return 19.5
    return 9.5


def _norm_ds(raw: Any) -> str:
    s = str(raw or "").replace("-", "").replace(" ", "")[:8]
    return s if len(s) == 8 and s.isdigit() else ""


def _ds_to_label(ds: str) -> str:
    if len(ds) == 8:
        return f"{ds[0:4]}-{ds[4:6]}-{ds[6:8]}"
    return ds


def _is_st_name(name: str) -> bool:
    return classify_risk_type(name) in ("st", "delist")


def _tag_label(row: dict[str, Any]) -> str:
    if row.get("is_again_limit") in (1, "1", True):
        return "回封板"
    tag = str(row.get("change_tag") or "")
    return TAG_MAP.get(tag, tag or "涨停")


def _bar_map(bars: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for b in bars:
        ds = _norm_ds(b.get("date"))
        if ds:
            out[ds] = b
    return out


def _bar_index(bars: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for i, b in enumerate(bars):
        ds = _norm_ds(b.get("date"))
        if ds:
            out[ds] = i
    return out


def _bar_pct(bars: list[dict[str, Any]], i: int) -> float:
    b = bars[i]
    pct = float(b.get("pct") or 0)
    if abs(pct) >= 1e-6:
        return pct
    if i <= 0:
        return 0.0
    prev = float(bars[i - 1].get("close") or 0)
    cur = float(b.get("close") or 0)
    if prev <= 0:
        return 0.0
    return (cur - prev) / prev * 100


def _near_price(a: float, b: float, tol: float = 0.002) -> bool:
    if b <= 0 or a <= 0:
        return False
    return abs(a - b) / b <= tol


async def build_stock_radar(
    code: str,
    em: EastMoneyClient,
    ths: ThsClient,
    lookback: str = "1y",
) -> dict[str, Any]:
    """涨停基因/雷达：优先对齐同花顺/东财「收盘涨停」次数。

    lookback: \"1y\" | \"3y\"（默认一年）
    - 涨停日：未复权日 K 收盘封住涨停价（与同花顺涨停池一致；不信任 DMSK IS_CLOSE_UP）
    - 触板未封：最高价触及涨停价但收盘未封，用于成功率
    - 次日溢价/红盘/连板：未复权日 K
    - 明细封单/原因：同花顺涨停池 + 本地史补充
    """
    from ..db import list_zt_history_by_code
    from ..services.ttl_cache import ttl_cache, trading_ttl

    lb = str(lookback or "1y").strip().lower()
    if lb in ("3", "3y", "three", "year3"):
        lb = "3y"
    else:
        lb = "1y"
    # 一年用足交易日余量，避免窗口裁切漏计
    LOOKBACK_BARS = 780 if lb == "3y" else 270
    THS_POOL_LIMIT = 36 if lb == "1y" else 24

    code = code.zfill(6)
    cache_key = f"radar:v5kline:{code}:{lb}"
    cached = await ttl_cache.get(cache_key)
    if cached and isinstance(cached, dict) and cached.get("prices") is not None:
        return cached

    kline_qfq, kline_raw = await asyncio.gather(
        em.fetch_kline(code, limit=LOOKBACK_BARS, fqt=1),
        em.fetch_kline(code, limit=LOOKBACK_BARS, fqt=0),
    )
    bars = kline_qfq.get("bars") or []
    raw_bars = kline_raw.get("bars") or bars
    name = str(kline_qfq.get("name") or kline_raw.get("name") or "")

    if not bars:
        empty = {
            "code": code,
            "name": name,
            "as_of": "",
            "lookback": lb,
            "methodology": "kline_v5",
            "range": {"start": "", "end": ""},
            "gene": {
                "zt_days": 0,
                "dt_days": 0,
                "premium5_days": 0,
                "zt_success_rate": None,
                "first_seal_rate": None,
                "next_red_rate": None,
                "board_rate": None,
            },
            "prices": [],
            "marks": [],
            "details": [],
        }
        return empty

    # 一年窗口按自然日 365 天截断，与东财/同花顺「近一年」一致；三年用全部 K 线
    end_ds = _norm_ds(bars[-1].get("date"))
    if lb == "1y" and len(end_ds) == 8:
        try:
            from datetime import timedelta

            end_dt = datetime.strptime(end_ds, "%Y%m%d")
            start_cut = (end_dt - timedelta(days=365)).strftime("%Y%m%d")
        except ValueError:
            start_cut = _norm_ds(bars[0].get("date"))
    else:
        start_cut = _norm_ds(bars[0].get("date"))
    # 裁剪展示用 bars 到窗口内（保留一根窗口前 K 以便算首日涨跌幅）
    raw_full = list(raw_bars)
    qfq_full = list(bars)
    cut_i = 0
    for i, b in enumerate(qfq_full):
        if _norm_ds(b.get("date")) >= start_cut:
            cut_i = i
            break
    bars = qfq_full[cut_i:]
    # raw 与 qfq 日期对齐裁剪
    raw_bars = [b for b in raw_full if _norm_ds(b.get("date")) >= start_cut]
    if not raw_bars:
        raw_bars = raw_full[cut_i:] if cut_i < len(raw_full) else raw_full

    start_ds = _norm_ds(bars[0].get("date")) if bars else start_cut
    end_ds = _norm_ds(bars[-1].get("date")) if bars else end_ds
    qfq_by_ds = _bar_map(bars)
    raw_by_ds = _bar_map(raw_bars)
    idx_by_ds = _bar_index(bars)
    trade_days = [_norm_ds(b.get("date")) for b in bars if _norm_ds(b.get("date"))]
    prev_trade: dict[str, str] = {}
    for i in range(1, len(trade_days)):
        prev_trade[trade_days[i]] = trade_days[i - 1]

    thr = _limit_threshold(code)
    # —— 涨停/跌停/炸板：未复权日 K（权威次数）；DMSK 仅作时间戳补充 ——
    sealed_dates: list[str] = []
    broken_dates: list[str] = []
    dt_dates: list[str] = []
    for i, b in enumerate(raw_bars):
        ds = _norm_ds(b.get("date"))
        if not ds or ds < start_ds or ds > end_ds:
            continue
        pct = _bar_pct(raw_bars, i)
        close = float(b.get("close") or 0)
        high = float(b.get("high") or 0)
        low = float(b.get("low") or 0)
        # 收盘涨停：涨幅到位且收盘贴近最高价（对齐同花顺涨停池）
        if pct >= thr - 0.05 and _near_price(close, high):
            sealed_dates.append(ds)
            continue
        if pct <= -(thr - 0.05) and _near_price(close, low):
            dt_dates.append(ds)
            continue
        # 触板未封：最高价触及涨停价，收盘未封
        if i > 0:
            prev_c = float(raw_bars[i - 1].get("close") or 0)
            if prev_c > 0 and high > 0:
                lim = round(prev_c * (1 + thr / 100.0), 2)
                if high + 1e-9 >= lim - 0.01 and close + 1e-9 < lim - 0.005:
                    broken_dates.append(ds)

    sealed_set = set(sealed_dates)
    broken_set = set(broken_dates) - sealed_set
    dt_set = set(dt_dates) - sealed_set

    # DMSK：补封板时间 / 名称（不覆盖涨停日判定）
    event_seal_time: dict[str, str] = {}
    try:
        events = await em.fetch_stock_limit_events(code, close_up=None)
    except Exception:
        events = []
    for ev in events:
        ds = _norm_ds(ev.get("trade_date"))
        if not ds or ds < start_ds or ds > end_ds:
            continue
        nm = str(ev.get("name") or "")
        if _is_st_name(nm):
            continue
        if not name and nm:
            name = nm
        t = str(ev.get("first_seal_time") or "")
        if t:
            event_seal_time[ds] = t

    # 本地原因 / 连板
    local_reason: dict[str, str] = {}
    local_board: dict[str, int] = {}
    try:
        for row in await list_zt_history_by_code(code):
            ds = _norm_ds(row.get("trade_date"))
            if not ds:
                continue
            reason = str(row.get("reason") or "").strip()
            if reason:
                local_reason[ds] = reason
            bc = int(row.get("board_count") or 0)
            if bc > 0:
                local_board[ds] = bc
    except Exception:
        pass

    # 近端同花顺池：板型 / 封单 / 原因（不做涨停日权威源）
    ths_by_date: dict[str, dict[str, Any]] = {}
    look_dates: list[str] = []
    for ds in sorted(sealed_set, reverse=True):
        look_dates.append(ds)
    today = datetime.now().strftime("%Y%m%d")
    if today not in look_dates:
        look_dates.insert(0, today)
    missing = [d for d in look_dates if d not in local_reason]
    recent = look_dates[:12]
    ordered: list[str] = []
    for d in missing + recent:
        if d not in ordered:
            ordered.append(d)
    look_dates = ordered[:THS_POOL_LIMIT]

    sem = asyncio.Semaphore(4)

    async def _pool_for_date(ds: str) -> tuple[str, list[dict[str, Any]]]:
        pool_key = f"ths_pool:{ds}"
        hit = await ttl_cache.get(pool_key)
        if isinstance(hit, list):
            return ds, hit
        async with sem:
            try:
                pool = await ths.fetch_limit_up_pool(ds)
            except Exception:
                pool = []
        await ttl_cache.set(pool_key, pool, trading_ttl(120, 3600), kind="ths_pool")
        return ds, pool

    if look_dates:
        results = await asyncio.gather(*[_pool_for_date(ds) for ds in look_dates])
        for ds, pool in results:
            for row in pool:
                if str(row.get("code")).zfill(6) == code:
                    ths_by_date[ds] = row
                    if not name:
                        name = str(row.get("name") or name)
                    break

    # —— 基因指标（未复权次日）——
    premium5 = 0
    next_red = 0
    next_n = 0
    consecutive = 0
    for ds in sealed_dates:
        i = idx_by_ds.get(ds)
        if i is None or i + 1 >= len(bars):
            # 用未复权序列定位次日
            raw_i = None
            for j, b in enumerate(raw_bars):
                if _norm_ds(b.get("date")) == ds:
                    raw_i = j
                    break
            if raw_i is None or raw_i + 1 >= len(raw_bars):
                continue
            cur_b = raw_bars[raw_i]
            nxt_b = raw_bars[raw_i + 1]
        else:
            # 次日收益一律走未复权
            nxt_ds = _norm_ds(bars[i + 1].get("date")) if i + 1 < len(bars) else ""
            cur_b = raw_by_ds.get(ds) or qfq_by_ds.get(ds) or {}
            nxt_b = raw_by_ds.get(nxt_ds) or (bars[i + 1] if i + 1 < len(bars) else {})
            if not nxt_b:
                continue
        next_n += 1
        cur = float(cur_b.get("close") or 0)
        nxt_close = float(nxt_b.get("close") or 0)
        if cur > 0 and nxt_close / cur - 1 >= 0.05:
            premium5 += 1
        if nxt_close >= cur:
            next_red += 1
        nxt_ds2 = _norm_ds(nxt_b.get("date"))
        if nxt_ds2 in sealed_set:
            consecutive += 1

    touch_n = len(sealed_set) + len(broken_set)
    zt_success_rate = (
        round(len(sealed_set) / touch_n * 100, 2) if touch_n > 0 else None
    )

    # 首板封板率：上一交易日未收盘涨停的触板日
    first_sealed = 0
    first_touch = 0
    for ds in sorted(sealed_set | broken_set):
        prev = prev_trade.get(ds)
        if prev and prev in sealed_set:
            continue
        first_touch += 1
        if ds in sealed_set:
            first_sealed += 1
    first_seal_rate = (
        round(first_sealed / first_touch * 100, 2) if first_touch > 0 else None
    )
    next_red_rate = round(next_red / next_n * 100, 2) if next_n else None
    board_rate = round(consecutive / next_n * 100, 2) if next_n else None

    # —— 明细 ——
    details: list[dict[str, Any]] = []
    detail_dates = sorted(sealed_set | dt_set, reverse=True)
    for ds in detail_dates:
        is_up = ds in sealed_set
        ths_row = ths_by_date.get(ds) or {}
        raw_b = raw_by_ds.get(ds) or {}
        qfq_b = qfq_by_ds.get(ds) or {}
        close = float(
            ths_row.get("latest")
            or raw_b.get("close")
            or qfq_b.get("close")
            or 0
        )
        pct = float(ths_row.get("change_rate") or raw_b.get("pct") or qfq_b.get("pct") or 0)
        seal = ths_row.get("order_amount")
        vol = float(raw_b.get("volume") or qfq_b.get("volume") or 0)
        amount = vol * close if vol and close else None
        seal_ratio = ths_row.get("order_volume_ratio")
        if seal_ratio is None and seal and amount and amount > 0:
            seal_ratio = round(float(seal) / amount * 100, 2)
        elif seal_ratio is not None:
            seal_ratio = (
                round(float(seal_ratio) * 100, 2)
                if float(seal_ratio) <= 1
                else round(float(seal_ratio), 2)
            )
        reason = str(ths_row.get("reason_type") or "").strip() or local_reason.get(ds) or None
        if is_up:
            tag = _tag_label(ths_row) if ths_row else ""
            if not tag and local_board.get(ds, 0) >= 2:
                tag = f"{local_board[ds]}连板"
            if not tag:
                tag = "涨停"
        else:
            tag = "跌停"
        details.append(
            {
                "date": _ds_to_label(ds),
                "kind": "zt" if is_up else "dt",
                "tag": tag,
                "close": close,
                "change_pct": round(pct, 2),
                "seal_amount": float(seal) if seal is not None else None,
                "seal_ratio": seal_ratio,
                "reason": reason,
                "reason_info": ths_row.get("reason_info"),
                "first_seal_time": event_seal_time.get(ds) or "",
            }
        )

    prices = [{"date": b["date"], "close": float(b.get("close") or 0)} for b in bars]
    marks: list[dict[str, Any]] = []
    for ds in sealed_dates:
        b = qfq_by_ds.get(ds) or raw_by_ds.get(ds)
        if not b:
            continue
        marks.append(
            {
                "date": str(b.get("date") or _ds_to_label(ds)),
                "close": float(b.get("close") or 0),
                "kind": "zt",
            }
        )
    for ds in dt_dates:
        b = qfq_by_ds.get(ds) or raw_by_ds.get(ds)
        if not b:
            continue
        marks.append(
            {
                "date": str(b.get("date") or _ds_to_label(ds)),
                "close": float(b.get("close") or 0),
                "kind": "dt",
            }
        )

    end_date = str(bars[-1].get("date") or "")
    start_date = str(bars[0].get("date") or "")
    result = {
        "code": code,
        "name": name,
        "as_of": end_date,
        "lookback": lb,
        "methodology": "kline_v5",
        "methodology_label": "未复权收盘涨停（对齐同花顺/东财次数，不含ST）",
        "range": {"start": start_date, "end": end_date},
        "gene": {
            "zt_days": len(sealed_set),
            "dt_days": len(dt_set),
            "premium5_days": premium5,
            "zt_success_rate": zt_success_rate,
            "first_seal_rate": first_seal_rate,
            "next_red_rate": next_red_rate,
            "board_rate": board_rate,
            "touch_days": touch_n,
            "broken_days": len(broken_set),
        },
        "prices": prices,
        "marks": marks,
        "details": details,
    }
    await ttl_cache.set(cache_key, result, trading_ttl(1800, 7200), kind="radar")
    return result
