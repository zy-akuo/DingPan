from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

import httpx

from .eastmoney import EastMoneyClient

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


def _limit_threshold(code: str) -> float:
    if code.startswith(("300", "301", "688")):
        return 19.5
    return 9.5


def _tag_label(row: dict[str, Any]) -> str:
    if row.get("is_again_limit") in (1, "1", True):
        return "回封板"
    tag = str(row.get("change_tag") or "")
    return TAG_MAP.get(tag, tag or "涨停")


async def build_stock_radar(code: str, em: EastMoneyClient, ths: ThsClient) -> dict[str, Any]:
    """Assemble 涨停雷达: gene stats + price series + rise/limit details."""
    from ..services.ttl_cache import ttl_cache, trading_ttl

    code = code.zfill(6)
    cache_key = f"radar:{code}"
    cached = await ttl_cache.get(cache_key)
    if cached and isinstance(cached, dict) and cached.get("prices") is not None:
        return cached

    kline = await em.fetch_kline(code, limit=260)
    bars = kline.get("bars") or []
    name = kline.get("name") or ""

    thr = _limit_threshold(code)
    zt_idx: list[int] = []
    dt_idx: list[int] = []
    for i, b in enumerate(bars):
        pct = float(b.get("pct") or 0)
        if abs(pct) < 1e-6 and i > 0:
            prev = float(bars[i - 1].get("close") or 0)
            cur = float(b.get("close") or 0)
            if prev:
                pct = (cur - prev) / prev * 100
                b["pct"] = round(pct, 2)
        if pct >= thr:
            zt_idx.append(i)
        elif pct <= -thr:
            dt_idx.append(i)

    ths_by_date: dict[str, dict[str, Any]] = {}
    look_dates: list[str] = []
    for i in reversed(zt_idx[-40:]):
        d = str(bars[i].get("date") or "").replace("-", "")
        if d and d not in look_dates:
            look_dates.append(d)
    today = datetime.now().strftime("%Y%m%d")
    if today not in look_dates:
        look_dates.insert(0, today)
    look_dates = look_dates[:12]

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

    results = await asyncio.gather(*[_pool_for_date(ds) for ds in look_dates])
    for ds, pool in results:
        for row in pool:
            if str(row.get("code")) == code:
                ths_by_date[ds] = row
                if not name:
                    name = str(row.get("name") or name)
                break

    details: list[dict[str, Any]] = []
    for i in reversed(zt_idx + dt_idx):
        b = bars[i]
        date = str(b.get("date") or "")
        ds = date.replace("-", "")
        pct = float(b.get("pct") or 0)
        is_up = i in zt_idx
        ths_row = ths_by_date.get(ds) or {}
        close = float(b.get("close") or ths_row.get("latest") or 0)
        if ths_row.get("change_rate") is not None:
            pct = float(ths_row["change_rate"])
        seal = ths_row.get("order_amount")
        amount = None
        vol = float(b.get("volume") or 0)
        if vol and close:
            amount = vol * close
        seal_ratio = ths_row.get("order_volume_ratio")
        if seal_ratio is None and seal and amount and amount > 0:
            seal_ratio = round(float(seal) / amount * 100, 2)
        elif seal_ratio is not None:
            seal_ratio = round(float(seal_ratio) * 100, 2) if float(seal_ratio) <= 1 else round(float(seal_ratio), 2)

        details.append(
            {
                "date": date,
                "kind": "zt" if is_up else "dt",
                "tag": _tag_label(ths_row) if is_up else "跌停",
                "close": close,
                "change_pct": round(pct, 2),
                "seal_amount": float(seal) if seal is not None else None,
                "seal_ratio": seal_ratio,
                "reason": str(ths_row.get("reason_type") or "") or None,
                "reason_info": ths_row.get("reason_info"),
            }
        )

    details.sort(key=lambda x: x["date"], reverse=True)

    zt_n = len(zt_idx)
    dt_n = len(dt_idx)
    premium5 = 0
    next_red = 0
    next_n = 0
    consecutive = 0
    for i in zt_idx:
        if i + 1 >= len(bars):
            continue
        next_n += 1
        cur = float(bars[i].get("close") or 0)
        nxt = bars[i + 1]
        nxt_close = float(nxt.get("close") or 0)
        nxt_open = float(nxt.get("open") or nxt_close)
        if cur > 0:
            prem = max(nxt_open, nxt_close) / cur - 1
            if prem >= 0.05:
                premium5 += 1
        if nxt_close >= cur:
            next_red += 1
        if i + 1 in zt_idx:
            consecutive += 1

    suc_rates = [
        float(v["limit_up_suc_rate"])
        for v in ths_by_date.values()
        if v.get("limit_up_suc_rate") is not None
    ]
    zt_success_rate = round(sum(suc_rates) / len(suc_rates) * 100, 2) if suc_rates else (
        100.0 if zt_n and not dt_n else (round(zt_n / max(zt_n, 1) * 100, 2) if zt_n else None)
    )
    first_seal_rate = zt_success_rate
    next_red_rate = round(next_red / next_n * 100, 2) if next_n else None
    board_rate = round(consecutive / next_n * 100, 2) if next_n else None

    end_date = bars[-1]["date"] if bars else ""
    start_date = bars[0]["date"] if bars else ""

    prices = [{"date": b["date"], "close": float(b.get("close") or 0)} for b in bars]
    marks = []
    for i in zt_idx:
        marks.append({"date": bars[i]["date"], "close": float(bars[i].get("close") or 0), "kind": "zt"})
    for i in dt_idx:
        marks.append({"date": bars[i]["date"], "close": float(bars[i].get("close") or 0), "kind": "dt"})

    result = {
        "code": code,
        "name": name,
        "as_of": end_date,
        "range": {"start": start_date, "end": end_date},
        "gene": {
            "zt_days": zt_n,
            "dt_days": dt_n,
            "premium5_days": premium5,
            "zt_success_rate": zt_success_rate,
            "first_seal_rate": first_seal_rate,
            "next_red_rate": next_red_rate,
            "board_rate": board_rate,
        },
        "prices": prices,
        "marks": marks,
        "details": details[:60],
    }
    await ttl_cache.set(cache_key, result, trading_ttl(1800, 7200), kind="radar")
    return result
