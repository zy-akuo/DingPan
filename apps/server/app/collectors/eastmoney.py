from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

import httpx


_FORMER_NAME_SPLIT = re.compile(r"(?:→|->|=>|[、，,;；/])+")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/ztb/detail",
}

UT = "7eea3edcaed734bea9cbfc24409ed989"
UT_QUOTE = "fa5fd1943c7b386f172d6893dbfba10b"


def classify_risk_type(name: str) -> str | None:
    """Return st / delist based on A-share risk warning name prefix."""
    raw = (name or "").strip()
    if not raw:
        return None
    # full-width ST variants
    n = raw.replace("ＳＴ", "ST").replace("＊", "*")
    if n.startswith("*ST") or n.startswith("ST*") or n.startswith("退市"):
        return "delist"
    if n.startswith("ST"):
        return "st"
    return None


def risk_hint_for(risk_type: str) -> str:
    if risk_type == "delist":
        return "退市风险警示"
    if risk_type == "st":
        return "其他风险警示"
    if risk_type == "warn":
        return "潜在风险"
    return "风险提示"


def today_yyyymmdd() -> str:
    return datetime.now().strftime("%Y%m%d")


def to_secid(code: str) -> str:
    code = code.zfill(6)
    return f"1.{code}" if code.startswith("6") else f"0.{code}"


def to_em_f10_code(code: str) -> str:
    code = code.zfill(6)
    return f"SH{code}" if code.startswith("6") else f"SZ{code}"


def to_secucode(code: str) -> str:
    code = code.zfill(6)
    return f"{code}.SH" if code.startswith("6") else f"{code}.SZ"


def _fmt_time(raw: Any) -> str:
    if raw is None or raw == "":
        return ""
    s = str(raw).zfill(6)
    if len(s) >= 6 and s.isdigit():
        return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"
    return str(raw)


def _market_prefix(code: str, market_flag: int | None = None) -> str:
    if code.startswith("688"):
        return "科"
    if code.startswith("300") or code.startswith("301"):
        return "创"
    if market_flag == 1 or code.startswith("6"):
        return "沪"
    return "深"


def _price(raw: Any) -> float:
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if v > 1000:
        return round(v / 1000, 2)
    return round(v, 2)


def _parse_zt_stats(raw: Any) -> str:
    if isinstance(raw, dict):
        days = raw.get("days")
        ct = raw.get("ct")
        if days is not None and ct is not None:
            return f"{days}/{ct}"
    return str(raw or "")


def normalize_pool_row(row: dict[str, Any], pool: str = "zt") -> dict[str, Any]:
    code = str(row.get("c") or row.get("code") or "")
    name = str(row.get("n") or row.get("name") or "")
    market_flag = row.get("m")
    board = int(row.get("lbc") or row.get("continuous") or 1)
    open_times = int(row.get("zbc") or row.get("open_times") or 0)
    industry = str(row.get("hybk") or row.get("industry") or "")
    return {
        "code": code.zfill(6) if code.isdigit() else code,
        "name": name,
        "market": _market_prefix(code, market_flag if isinstance(market_flag, int) else None),
        "price": _price(row.get("p") or row.get("price")),
        "change_pct": float(row.get("zdp") or row.get("change_pct") or 0),
        "amount": float(row.get("amount") or 0),
        "volume": float(row.get("volume") or row.get("vol") or 0),
        "float_mv": float(row.get("ltsz") or row.get("float_mv") or 0),
        "total_mv": float(row.get("tshare") or row.get("total_mv") or 0),
        "turnover": float(row.get("hs") or row.get("turnover") or 0),
        "seal_amount": float(row.get("fund") or row.get("seal_amount") or 0),
        "first_seal_time": _fmt_time(row.get("fbt") or row.get("first_zt_time")),
        "last_seal_time": _fmt_time(row.get("lbt") or row.get("last_zt_time")),
        "board_count": board,
        "open_times": open_times,
        "industry": industry,
        "concepts": [industry] if industry else [],
        "zt_stats": _parse_zt_stats(row.get("zttj")),
        "pool": pool,
    }


class EastMoneyClient:
    def __init__(self, timeout: float = 12.0) -> None:
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                headers=HEADERS,
                timeout=self._timeout,
                follow_redirects=True,
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def _get(self, url: str, params: dict[str, Any] | None = None, referer: str | None = None) -> dict[str, Any]:
        client = await self._ensure_client()
        headers = dict(HEADERS)
        if referer:
            headers["Referer"] = referer
        resp = await client.get(url, params=params, headers=headers)
        resp.raise_for_status()
        return resp.json()

    async def fetch_zt_pool(self, date: str | None = None) -> list[dict[str, Any]]:
        date = date or today_yyyymmdd()
        data = await self._get(
            "https://push2ex.eastmoney.com/getTopicZTPool",
            {
                "ut": UT,
                "dpt": "wz.ztzt",
                "Pageindex": "0",
                "pagesize": "5000",
                "sort": "fbt:asc",
                "date": date,
            },
        )
        pool = (data.get("data") or {}).get("pool") or []
        return [normalize_pool_row(r, "zt") for r in pool]

    async def fetch_zt_pool_dmsk(self, date: str | None = None) -> list[dict[str, Any]]:
        """东财数据中心涨停历史（可回溯多年）。date: YYYYMMDD。

        实时池 getTopicZTPool 仅保留约最近数周；往日请用本接口。
        """
        ds = (date or today_yyyymmdd()).replace("-", "")
        if len(ds) != 8 or not ds.isdigit():
            return []
        day = f"{ds[0:4]}-{ds[4:6]}-{ds[6:8]}"
        out: list[dict[str, Any]] = []
        page = 1
        page_size = 500
        while page <= 5:
            try:
                data = await self._get(
                    "https://datacenter-web.eastmoney.com/api/data/v1/get",
                    {
                        "reportName": "RPT_DMSK_LIMITUP",
                        "columns": "ALL",
                        "filter": f"(TRADE_DATE='{day}')(IS_CLOSE_UP=\"1\")",
                        "pageNumber": str(page),
                        "pageSize": str(page_size),
                        "sortTypes": "1",
                        "sortColumns": "FIRST_LIMITUP_TIME",
                        "source": "WEB",
                        "client": "WEB",
                    },
                    referer="https://data.eastmoney.com/ztzu/",
                )
            except Exception:
                break
            if data.get("code") not in (0, "0", None):
                break
            result = data.get("result") or {}
            rows = result.get("data") or []
            if not rows:
                break
            for r in rows:
                code = str(r.get("SECURITY_CODE") or "").zfill(6)
                if not code.isdigit():
                    continue
                sec = str(r.get("SECUCODE") or "")
                market_flag = 1 if sec.endswith(".SH") or code.startswith("6") else 0
                first_t = str(r.get("FIRST_LIMITUP_TIME") or "")
                last_t = str(r.get("LAST_LIMITUP_TIME") or "")
                # FIRST_LIMITUP_TIME 已是 HH:MM:SS；兼容纯数字
                if first_t and ":" not in first_t:
                    first_t = _fmt_time(first_t)
                if last_t and ":" not in last_t:
                    last_t = _fmt_time(last_t)
                out.append(
                    {
                        "code": code,
                        "name": str(r.get("SECURITY_NAME_ABBR") or code),
                        "market": _market_prefix(code, market_flag),
                        "price": 0.0,
                        "change_pct": 0.0,
                        "amount": 0.0,
                        "volume": float(r.get("LAST_LIMITUP_NUM") or 0),
                        "float_mv": 0.0,
                        "total_mv": 0.0,
                        "turnover": 0.0,
                        "seal_amount": 0.0,
                        "first_seal_time": first_t,
                        "last_seal_time": last_t,
                        "board_count": 1,
                        "open_times": 0,
                        "industry": "",
                        "concepts": [],
                        "zt_stats": "",
                        "pool": "zt",
                    }
                )
            total = int(result.get("count") or 0)
            if page * page_size >= total or len(rows) < page_size:
                break
            page += 1
        return out

    async def fetch_stock_limitup_dates(self, code: str) -> list[dict[str, Any]]:
        """个股历史涨停日期（东财 RPT_DMSK_LIMITUP，按代码过滤）。

        返回按日期降序的 [{trade_date, name, first_seal_time}, ...]。
        """
        code = (code or "").zfill(6)
        if not code.isdigit():
            return []
        out: list[dict[str, Any]] = []
        page = 1
        page_size = 500
        while page <= 20:
            try:
                data = await self._get(
                    "https://datacenter-web.eastmoney.com/api/data/v1/get",
                    {
                        "reportName": "RPT_DMSK_LIMITUP",
                        "columns": "ALL",
                        "filter": f'(SECURITY_CODE="{code}")(IS_CLOSE_UP="1")',
                        "pageNumber": str(page),
                        "pageSize": str(page_size),
                        "sortTypes": "-1",
                        "sortColumns": "TRADE_DATE",
                        "source": "WEB",
                        "client": "WEB",
                    },
                    referer="https://data.eastmoney.com/ztzu/",
                )
            except Exception:
                break
            if data.get("code") not in (0, "0", None):
                break
            result = data.get("result") or {}
            rows = result.get("data") or []
            if not rows:
                break
            for r in rows:
                td = str(r.get("TRADE_DATE") or "")
                # "2024-02-21 00:00:00" -> 20240221
                raw = td.replace("-", "").replace(" ", "")[:8]
                if len(raw) != 8 or not raw.isdigit():
                    continue
                first_t = str(r.get("FIRST_LIMITUP_TIME") or "")
                if first_t and ":" not in first_t:
                    first_t = _fmt_time(first_t)
                out.append(
                    {
                        "trade_date": raw,
                        "name": str(r.get("SECURITY_NAME_ABBR") or code),
                        "first_seal_time": first_t,
                    }
                )
            total = int(result.get("count") or 0)
            if page * page_size >= total or len(rows) < page_size:
                break
            page += 1
        # de-dup keep first (newest-first already)
        seen: set[str] = set()
        uniq: list[dict[str, Any]] = []
        for row in out:
            ds = row["trade_date"]
            if ds in seen:
                continue
            seen.add(ds)
            uniq.append(row)
        return uniq

    async def fetch_zb_pool(self, date: str | None = None) -> list[dict[str, Any]]:
        date = date or today_yyyymmdd()
        data = await self._get(
            "https://push2ex.eastmoney.com/getTopicZBPool",
            {
                "ut": UT,
                "dpt": "wz.ztzt",
                "Pageindex": "0",
                "pagesize": "5000",
                "sort": "fbt:asc",
                "date": date,
            },
        )
        pool = (data.get("data") or {}).get("pool") or []
        return [normalize_pool_row(r, "zb") for r in pool]

    async def fetch_dt_pool(self, date: str | None = None) -> list[dict[str, Any]]:
        date = date or today_yyyymmdd()
        data = await self._get(
            "https://push2ex.eastmoney.com/getTopicDTPool",
            {
                "ut": UT,
                "dpt": "wz.ztzt",
                "Pageindex": "0",
                "pagesize": "5000",
                "sort": "fund:asc",
                "date": date,
            },
        )
        pool = (data.get("data") or {}).get("pool") or []
        return [normalize_pool_row(r, "dt") for r in pool]

    async def fetch_quote(self, code: str) -> dict[str, Any]:
        """Realtime/last quote: price, total_mv, float_mv."""
        code = code.zfill(6)
        try:
            data = await self._get(
                "https://push2.eastmoney.com/api/qt/ulist.np/get",
                {
                    "fltt": "2",
                    "secids": to_secid(code),
                    "fields": "f2,f3,f5,f6,f12,f14,f20,f21",
                    "ut": UT_QUOTE,
                },
                referer=f"https://quote.eastmoney.com/{'sh' if code.startswith('6') else 'sz'}{code}.html",
            )
            diff = ((data.get("data") or {}).get("diff")) or []
            if diff:
                row = diff[0]
                price = float(row.get("f2") or 0)
                if price:
                    return {
                        "code": code,
                        "name": str(row.get("f14") or ""),
                        "price": price,
                        "change_pct": float(row.get("f3") or 0),
                        "volume": float(row.get("f5") or 0),
                        "amount": float(row.get("f6") or 0),
                        "total_mv": float(row.get("f20") or 0),
                        "float_mv": float(row.get("f21") or 0),
                    }
        except Exception:
            pass
        return await self._fetch_quote_tencent(code)

    async def fetch_quotes_batch(self, codes: list[str]) -> dict[str, dict[str, Any]]:
        """Batch quotes via ulist; fallback per-code on failure."""
        result: dict[str, dict[str, Any]] = {}
        codes = [c.zfill(6) for c in codes if c]
        if not codes:
            return result

        def _parse_diff(diff: Any) -> list[dict[str, Any]]:
            if not diff:
                return []
            if isinstance(diff, dict):
                return [v for v in diff.values() if isinstance(v, dict)]
            if isinstance(diff, list):
                return [v for v in diff if isinstance(v, dict)]
            return []

        # eastmoney ulist accepts comma-separated secids
        for i in range(0, len(codes), 50):
            chunk = codes[i : i + 50]
            try:
                data = await self._get(
                    "https://push2.eastmoney.com/api/qt/ulist.np/get",
                    {
                        "fltt": "2",
                        "secids": ",".join(to_secid(c) for c in chunk),
                        "fields": "f2,f3,f5,f6,f12,f14",
                        "ut": UT_QUOTE,
                    },
                )
                for row in _parse_diff(((data.get("data") or {}).get("diff"))):
                    code = str(row.get("f12") or "").zfill(6)
                    if not code or code == "000000":
                        continue
                    try:
                        price = float(row.get("f2") or 0)
                    except (TypeError, ValueError):
                        price = 0.0
                    try:
                        change_pct = float(row.get("f3") or 0)
                    except (TypeError, ValueError):
                        change_pct = 0.0
                    result[code] = {
                        "code": code,
                        "name": str(row.get("f14") or ""),
                        "price": price,
                        "change_pct": change_pct,
                        "volume": float(row.get("f5") or 0) if row.get("f5") not in ("-", None) else 0,
                        "amount": float(row.get("f6") or 0) if row.get("f6") not in ("-", None) else 0,
                    }
            except Exception:
                pass
            missing = [c for c in chunk if c not in result]
            if missing:
                sem = asyncio.Semaphore(10)

                async def _fill(code: str) -> None:
                    async with sem:
                        try:
                            q = await self.fetch_quote(code)
                            if q:
                                result[code] = q
                        except Exception:
                            pass

                await asyncio.gather(*[_fill(c) for c in missing])
        return result

    async def fetch_trends(self, code: str) -> dict[str, Any]:
        """Intraday trend. Prefer today; before open / thin today → previous trading day."""
        code = code.zfill(6)
        # 1) 东财（可能不稳定）
        em = await self._fetch_trends_eastmoney(code)
        if self._trends_usable(em):
            return em
        # 2) 腾讯多日分时（盘前/东财挂掉时主力）
        qq = await self._fetch_trends_tencent_days(code)
        if self._trends_usable(qq):
            return qq
        # 3) 新浪 1 分钟
        sina = await self._fetch_trends_sina(code)
        if self._trends_usable(sina):
            return sina
        # 返回「最像样」的一份（可能仍为空）
        for cand in (qq, em, sina):
            if cand and (cand.get("points") or []):
                return cand
        return {"code": code, "name": "", "pre_close": 0, "points": [], "trade_date": ""}

    @staticmethod
    def _trends_usable(payload: dict[str, Any] | None) -> bool:
        if not payload:
            return False
        points = payload.get("points") or []
        if len(points) >= 30:
            return True
        # 盘中刚开盘也可能只有少量点
        now = datetime.now()
        mins = now.hour * 60 + now.minute
        if 9 * 60 + 30 <= mins <= 15 * 60 + 5 and len(points) >= 1:
            trade_date = str(payload.get("trade_date") or "")
            today = now.strftime("%Y-%m-%d")
            return trade_date == today or trade_date.replace("-", "") == now.strftime("%Y%m%d")
        return False

    async def _fetch_trends_eastmoney(self, code: str) -> dict[str, Any]:
        code = code.zfill(6)
        best: dict[str, Any] = {"code": code, "name": "", "pre_close": 0, "points": [], "trade_date": ""}
        for ndays in (1, 2, 5):
            params = {
                "secid": to_secid(code),
                "ndays": str(ndays),
                "iscr": "0",
                "iscca": "0",
                "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
                "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
                "ut": UT_QUOTE,
            }
            data: dict[str, Any] = {}
            for base in (
                "https://push2.eastmoney.com/api/qt/stock/trends2/get",
                "https://push2his.eastmoney.com/api/qt/stock/trends2/get",
                "https://push2delay.eastmoney.com/api/qt/stock/trends2/get",
            ):
                try:
                    data = await self._get(base, params, referer="https://quote.eastmoney.com/")
                    if (data.get("data") or {}).get("trends"):
                        break
                except Exception:
                    continue
            payload = data.get("data") or {}
            raw_lines = payload.get("trends") or []
            if not raw_lines:
                continue
            by_day: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for line in raw_lines:
                parts = str(line).split(",")
                if len(parts) < 5:
                    continue
                dt = parts[0]
                day = dt.split(" ")[0] if " " in dt else ""
                time_label = dt.split(" ")[-1] if " " in dt else dt
                by_day[day].append(
                    {
                        "time": time_label,
                        "price": float(parts[1] or 0),
                        "avg": float(parts[2] or 0),
                        "volume": float(parts[5] or 0) if len(parts) > 5 else 0,
                    }
                )
            picked = self._pick_trend_day(by_day)
            if not picked:
                continue
            day, points = picked
            cand = {
                "code": code,
                "name": str(payload.get("name") or ""),
                "pre_close": float(payload.get("preClose") or payload.get("prePrice") or 0),
                "points": points,
                "trade_date": day,
            }
            if self._trends_usable(cand):
                return cand
            if len(cand["points"]) > len(best.get("points") or []):
                best = cand
        return best

    async def _fetch_trends_tencent_days(self, code: str) -> dict[str, Any]:
        code = code.zfill(6)
        sym = self._to_qq_symbol(code)
        headers = dict(HEADERS)
        headers["Referer"] = "https://finance.qq.com/"
        try:
            client = await self._ensure_client()
            resp = await client.get(
                "https://web.ifzq.gtimg.cn/appstock/app/day/query",
                params={"code": sym},
                headers=headers,
                timeout=10.0,
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception:
            return {"code": code, "name": "", "pre_close": 0, "points": [], "trade_date": ""}

        node = ((payload.get("data") or {}).get(sym)) or {}
        days_raw = node.get("data") or []
        by_day: dict[str, list[dict[str, Any]]] = {}
        pre_by_day: dict[str, float] = {}
        name = ""
        for item in days_raw:
            if not isinstance(item, dict):
                continue
            d_raw = str(item.get("date") or "")
            if len(d_raw) == 8 and d_raw.isdigit():
                day = f"{d_raw[:4]}-{d_raw[4:6]}-{d_raw[6:8]}"
            else:
                day = d_raw
            try:
                pre_by_day[day] = float(item.get("prec") or 0)
            except (TypeError, ValueError):
                pre_by_day[day] = 0.0
            points: list[dict[str, Any]] = []
            prev_vol = 0.0
            for line in item.get("data") or []:
                parts = str(line).split()
                if len(parts) < 2:
                    continue
                t_raw = parts[0]
                if len(t_raw) == 4 and t_raw.isdigit():
                    time_label = f"{t_raw[:2]}:{t_raw[2:]}"
                else:
                    time_label = t_raw
                try:
                    price = float(parts[1] or 0)
                except (TypeError, ValueError):
                    continue
                try:
                    cum_vol = float(parts[2] or 0)  # 手（累计）
                except (TypeError, ValueError):
                    cum_vol = prev_vol
                try:
                    cum_amt = float(parts[3] or 0)
                except (TypeError, ValueError):
                    cum_amt = 0.0
                vol_hands = max(0.0, cum_vol - prev_vol)
                prev_vol = cum_vol
                avg = (cum_amt / (cum_vol * 100)) if cum_vol > 0 else price
                points.append(
                    {
                        "time": time_label,
                        "price": price,
                        "avg": round(avg, 3),
                        "volume": vol_hands * 100,
                    }
                )
            if points:
                by_day[day] = points

        # 名称可从 qt 取
        qt = (node.get("qt") or {}).get(sym) or []
        if isinstance(qt, list) and len(qt) > 1:
            name = str(qt[1] or "")

        picked = self._pick_trend_day(by_day)
        if not picked:
            return {"code": code, "name": name, "pre_close": 0, "points": [], "trade_date": ""}
        day, points = picked
        return {
            "code": code,
            "name": name,
            "pre_close": pre_by_day.get(day) or 0,
            "points": points,
            "trade_date": day,
        }

    async def _fetch_trends_sina(self, code: str) -> dict[str, Any]:
        code = code.zfill(6)
        prefix = "sh" if code.startswith("6") else "sz"
        headers = dict(HEADERS)
        headers["Referer"] = "https://finance.sina.com.cn"
        try:
            client = await self._ensure_client()
            resp = await client.get(
                "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData",
                params={"symbol": f"{prefix}{code}", "scale": "1", "ma": "no", "datalen": "500"},
                headers=headers,
                timeout=10.0,
            )
            resp.raise_for_status()
            rows = resp.json()
        except Exception:
            return {"code": code, "name": "", "pre_close": 0, "points": [], "trade_date": ""}
        if not isinstance(rows, list) or not rows:
            return {"code": code, "name": "", "pre_close": 0, "points": [], "trade_date": ""}

        by_day: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            day_full = str(row.get("day") or "")
            if " " not in day_full:
                continue
            day, time_label = day_full.split(" ", 1)
            time_label = time_label[:5]
            try:
                price = float(row.get("close") or row.get("open") or 0)
            except (TypeError, ValueError):
                continue
            try:
                volume = float(row.get("volume") or 0)
            except (TypeError, ValueError):
                volume = 0.0
            by_day[day].append(
                {
                    "time": time_label,
                    "price": price,
                    "avg": price,
                    "volume": volume,
                }
            )
        picked = self._pick_trend_day(dict(by_day))
        if not picked:
            return {"code": code, "name": "", "pre_close": 0, "points": [], "trade_date": ""}
        day, points = picked
        # 昨收：取上一日收盘
        days_sorted = sorted(by_day.keys())
        pre_close = 0.0
        if day in days_sorted:
            idx = days_sorted.index(day)
            if idx > 0:
                prev_pts = by_day[days_sorted[idx - 1]]
                if prev_pts:
                    pre_close = float(prev_pts[-1].get("price") or 0)
        return {
            "code": code,
            "name": "",
            "pre_close": pre_close,
            "points": points,
            "trade_date": day,
        }

    def _pick_trend_day(
        self, by_day: dict[str, list[dict[str, Any]]]
    ) -> tuple[str, list[dict[str, Any]]] | None:
        if not by_day:
            return None
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        today2 = now.strftime("%Y%m%d")
        mins = now.hour * 60 + now.minute
        before_open = now.weekday() >= 5 or mins < 9 * 60 + 30

        def norm_day(d: str) -> str:
            d = str(d or "")
            if len(d) == 8 and d.isdigit():
                return f"{d[:4]}-{d[4:6]}-{d[6:8]}"
            return d[:10]

        items = sorted(
            ((norm_day(d), pts) for d, pts in by_day.items() if pts),
            key=lambda x: x[0],
        )
        if not items:
            return None

        def is_today(day: str) -> bool:
            return day == today or day.replace("-", "") == today2

        today_item = next((x for x in items if is_today(x[0])), None)
        prev_items = [x for x in items if not is_today(x[0])]

        # 未开盘 / 休市：优先上一交易日完整分时
        if before_open:
            if prev_items:
                return prev_items[-1]
            return items[-1]

        # 已开盘：今日有足够点用今日，否则回退昨日
        if today_item and len(today_item[1]) >= 5:
            return today_item
        if prev_items:
            return prev_items[-1]
        return today_item or items[-1]

    async def fetch_kline(self, code: str, limit: int = 120) -> dict[str, Any]:
        """Daily K-line bars (Eastmoney first, Sina/Tencent fallback)."""
        code = code.zfill(6)
        params = {
            "secid": to_secid(code),
            "klt": "101",
            "fqt": "1",
            "lmt": str(limit),
            "beg": "0",
            "end": "20500101",
            "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "ut": UT_QUOTE,
            "rtntype": "6",
        }
        data: dict[str, Any] = {}
        for base in (
            "https://push2his.eastmoney.com/api/qt/stock/kline/get",
            "https://push2.eastmoney.com/api/qt/stock/kline/get",
            "https://push2delay.eastmoney.com/api/qt/stock/kline/get",
        ):
            try:
                data = await self._get(base, params, referer="https://quote.eastmoney.com/")
                if (data.get("data") or {}).get("klines"):
                    break
            except Exception:
                continue
        payload = data.get("data") or {}
        bars = []
        for line in payload.get("klines") or []:
            parts = str(line).split(",")
            if len(parts) < 6:
                continue
            bars.append(
                {
                    "date": parts[0],
                    "open": float(parts[1] or 0),
                    "close": float(parts[2] or 0),
                    "high": float(parts[3] or 0),
                    "low": float(parts[4] or 0),
                    "volume": float(parts[5] or 0),
                    "pct": float(parts[8] or 0) if len(parts) > 8 else 0,
                }
            )
        if bars:
            bars = await self._merge_today_bar(code, bars, limit)
            return {
                "code": code,
                "name": str(payload.get("name") or ""),
                "bars": bars,
            }
        data = await self._fetch_kline_sina(code, limit)
        data["bars"] = await self._merge_today_bar(code, list(data.get("bars") or []), limit)
        return data

    async def _merge_today_bar(
        self, code: str, bars: list[dict[str, Any]], limit: int
    ) -> list[dict[str, Any]]:
        """历史日K不含当日未收盘K线，用实时行情补上今天。"""
        now = datetime.now()
        if now.weekday() >= 5:
            return bars
        today = now.strftime("%Y-%m-%d")
        today_compact = now.strftime("%Y%m%d")
        # 开盘前仍只有上一交易日
        if now.hour < 9 or (now.hour == 9 and now.minute < 25):
            return bars
        try:
            q = await self._fetch_quote_tencent_one(code)
        except Exception:
            return bars
        if not q or not q.get("price"):
            return bars
        qdate = str(q.get("quote_date") or "")
        if qdate and qdate != today_compact:
            return bars
        price = float(q.get("price") or 0)
        bar = {
            "date": today,
            "open": float(q.get("open") or 0) or price,
            "close": price,
            "high": float(q.get("high") or 0) or price,
            "low": float(q.get("low") or 0) or price,
            "volume": float(q.get("volume") or 0),
            "pct": float(q.get("change_pct") or 0),
        }
        if bars and str(bars[-1].get("date") or "")[:10] == today:
            bars[-1] = bar
        else:
            bars.append(bar)
        if limit and len(bars) > limit:
            bars = bars[-limit:]
        return bars

    async def _fetch_kline_sina(self, code: str, limit: int = 120) -> dict[str, Any]:
        code = code.zfill(6)
        prefix = "sh" if code.startswith("6") else "sz"
        headers = dict(HEADERS)
        headers["Referer"] = "https://finance.sina.com.cn"
        try:
            async with httpx.AsyncClient(headers=headers, timeout=self._timeout, follow_redirects=True) as client:
                resp = await client.get(
                    "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData",
                    params={"symbol": f"{prefix}{code}", "scale": "240", "ma": "5", "datalen": str(limit)},
                )
                resp.raise_for_status()
                rows = resp.json()
        except Exception:
            return await self._fetch_kline_tencent(code, limit)
        if not isinstance(rows, list) or not rows:
            return await self._fetch_kline_tencent(code, limit)
        bars = []
        for row in rows:
            o = float(row.get("open") or 0)
            c = float(row.get("close") or 0)
            bars.append(
                {
                    "date": str(row.get("day") or ""),
                    "open": o,
                    "close": c,
                    "high": float(row.get("high") or 0),
                    "low": float(row.get("low") or 0),
                    "volume": float(row.get("volume") or 0),
                    "pct": 0.0,
                }
            )
        return {"code": code, "name": "", "bars": bars}

    async def _fetch_kline_tencent(self, code: str, limit: int = 120) -> dict[str, Any]:
        code = code.zfill(6)
        prefix = "sh" if code.startswith("6") else "sz"
        headers = dict(HEADERS)
        headers["Referer"] = "https://finance.qq.com/"
        try:
            async with httpx.AsyncClient(headers=headers, timeout=self._timeout, follow_redirects=True) as client:
                resp = await client.get(
                    "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
                    params={"param": f"{prefix}{code},day,,,{limit},qfq"},
                )
                resp.raise_for_status()
                data = resp.json()
        except Exception:
            return {"code": code, "name": "", "bars": []}
        node = ((data.get("data") or {}).get(f"{prefix}{code}")) or {}
        rows = node.get("qfqday") or node.get("day") or []
        bars = []
        for row in rows:
            if not isinstance(row, list) or len(row) < 5:
                continue
            # date, open, close, high, low, volume
            bars.append(
                {
                    "date": str(row[0]),
                    "open": float(row[1] or 0),
                    "close": float(row[2] or 0),
                    "high": float(row[3] or 0),
                    "low": float(row[4] or 0),
                    "volume": float(row[5] or 0) if len(row) > 5 else 0,
                    "pct": 0.0,
                }
            )
        return {"code": code, "name": "", "bars": bars}

    async def _fetch_quote_tencent(self, code: str) -> dict[str, Any]:
        """Fallback quote from qt.gtimg.cn — fields include price and 市值(亿)."""
        batch = await self.fetch_quotes_tencent_batch([code])
        return batch.get(code.zfill(6)) or {}

    @staticmethod
    def _to_qq_symbol(code: str) -> str:
        code = code.zfill(6)
        if code.startswith("6"):
            return f"sh{code}"
        if code.startswith(("8", "4")) or code.startswith("92"):
            return f"bj{code}"
        return f"sz{code}"

    async def fetch_quotes_tencent_batch(self, codes: list[str]) -> dict[str, dict[str, Any]]:
        """Fast multi-quote via qt.gtimg.cn (primary path for ladder fails)."""
        result: dict[str, dict[str, Any]] = {}
        codes = [c.zfill(6) for c in codes if c]
        if not codes:
            return result

        headers = dict(HEADERS)
        headers["Referer"] = "https://finance.qq.com/"
        client = await self._ensure_client()

        for i in range(0, len(codes), 40):
            chunk = codes[i : i + 40]
            url = "https://qt.gtimg.cn/q=" + ",".join(self._to_qq_symbol(c) for c in chunk)
            try:
                resp = await client.get(url, headers=headers, timeout=8.0)
                resp.raise_for_status()
                text = resp.text
            except Exception:
                # 失败时逐只兜底，避免整批丢失
                for c in chunk:
                    try:
                        one = await self._fetch_quote_tencent_one(c)
                        if one:
                            result[c] = one
                    except Exception:
                        pass
                continue

            for line in text.split(";"):
                line = line.strip()
                if not line or "~" not in line or "=" not in line:
                    continue
                try:
                    payload = line.split("=", 1)[1].strip().strip('";\n ')
                    parts = payload.split("~")
                    if len(parts) < 5:
                        continue
                    code = str(parts[2] or "").zfill(6)
                    if not code.isdigit():
                        continue
                    price = float(parts[3] or 0)
                    prev = float(parts[4] or 0)
                    name = parts[1]
                    # 优先用腾讯自带涨跌幅（约 index 32），否则用昨收推算
                    change_pct = 0.0
                    if len(parts) > 32 and parts[32] not in ("", None):
                        try:
                            change_pct = float(parts[32])
                        except (TypeError, ValueError):
                            change_pct = 0.0
                    if abs(change_pct) < 1e-12 and prev > 0 and price > 0:
                        change_pct = round((price - prev) / prev * 100, 2)
                    vol_hands = float(parts[6] or 0) if len(parts) > 6 else 0.0
                    float_yi = float(parts[44]) if len(parts) > 44 and parts[44] else 0.0
                    total_yi = float(parts[45]) if len(parts) > 45 and parts[45] else 0.0
                    if not price and not change_pct:
                        continue
                    result[code] = {
                        "code": code,
                        "name": name,
                        "price": price,
                        "change_pct": change_pct,
                        "volume": vol_hands * 100,
                        "total_mv": total_yi * 1e8 if total_yi else 0.0,
                        "float_mv": float_yi * 1e8 if float_yi else 0.0,
                        "open": float(parts[5] or 0) if len(parts) > 5 else 0.0,
                        "high": float(parts[33] or 0) if len(parts) > 33 else 0.0,
                        "low": float(parts[34] or 0) if len(parts) > 34 else 0.0,
                        "quote_date": str(parts[30])[:8] if len(parts) > 30 else "",
                    }
                except Exception:
                    continue
        return result

    async def _fetch_quote_tencent_one(self, code: str) -> dict[str, Any]:
        code = code.zfill(6)
        url = f"https://qt.gtimg.cn/q={self._to_qq_symbol(code)}"
        headers = dict(HEADERS)
        headers["Referer"] = "https://finance.qq.com/"
        try:
            client = await self._ensure_client()
            resp = await client.get(url, headers=headers, timeout=6.0)
            resp.raise_for_status()
            text = resp.text
        except Exception:
            return {}
        if "~" not in text or "=" not in text:
            return {}
        try:
            payload = text.split("=", 1)[1].strip().strip('";\n ')
            parts = payload.split("~")
            price = float(parts[3] or 0)
            name = parts[1]
            float_yi = float(parts[44]) if len(parts) > 44 and parts[44] else 0.0
            total_yi = float(parts[45]) if len(parts) > 45 and parts[45] else 0.0
            vol_hands = float(parts[6] or 0) if len(parts) > 6 else 0.0
            prev = float(parts[4] or 0)
            change_pct = 0.0
            if len(parts) > 32 and parts[32] not in ("", None):
                try:
                    change_pct = float(parts[32])
                except (TypeError, ValueError):
                    change_pct = 0.0
            if abs(change_pct) < 1e-12 and prev > 0 and price > 0:
                change_pct = round((price - prev) / prev * 100, 2)
            return {
                "code": code,
                "name": name,
                "price": price,
                "change_pct": change_pct,
                "volume": vol_hands * 100,
                "total_mv": total_yi * 1e8 if total_yi else 0.0,
                "float_mv": float_yi * 1e8 if float_yi else 0.0,
                "open": float(parts[5] or 0) if len(parts) > 5 else 0.0,
                "high": float(parts[33] or 0) if len(parts) > 33 else 0.0,
                "low": float(parts[34] or 0) if len(parts) > 34 else 0.0,
                "quote_date": str(parts[30])[:8] if len(parts) > 30 else "",
            }
        except Exception:
            return {}

    @staticmethod
    def _parse_former_names(raw: Any, current: str = "") -> list[str]:
        """Split East Money FORMERNAME (通常用顿号分隔) into unique historical names."""
        text = str(raw or "").strip()
        if not text:
            return []
        current = (current or "").strip()
        out: list[str] = []
        seen: set[str] = set()
        for part in _FORMER_NAME_SPLIT.split(text):
            name = part.strip()
            if not name or name == current or name in seen:
                continue
            seen.add(name)
            out.append(name)
        return out

    async def fetch_company_profile(self, code: str) -> dict[str, Any]:
        data = await self._get(
            "https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax",
            {"code": to_em_f10_code(code)},
            referer="https://emweb.securities.eastmoney.com/",
        )
        jbzl = data.get("jbzl") or []
        row = jbzl[0] if isinstance(jbzl, list) and jbzl else {}
        if not isinstance(row, dict):
            return {}
        industry = ""
        em2016 = str(row.get("EM2016") or "")
        if em2016:
            industry = em2016.split("-")[-1].strip()
        name = str(row.get("SECURITY_NAME_ABBR") or "")
        return {
            "name": name,
            "region": str(row.get("PROVINCE") or ""),
            "industry": industry or str(row.get("INDUSTRYCSRC1") or ""),
            "address": str(row.get("ADDRESS") or ""),
            "former_names": self._parse_former_names(row.get("FORMERNAME"), name),
        }

    async def fetch_stock_concepts(self, code: str) -> list[str]:
        names: list[str] = []
        try:
            data = await self._get(
                "https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax",
                {"code": to_em_f10_code(code)},
                referer="https://emweb.securities.eastmoney.com/",
            )
            for key in ("ssbk", "hxtc"):
                blocks = data.get(key) or []
                if not isinstance(blocks, list):
                    continue
                for b in blocks:
                    if not isinstance(b, dict):
                        continue
                    n = b.get("BOARD_NAME") or b.get("KEYWORD")
                    # skip long business scope text
                    if key == "hxtc" and b.get("KEY_CLASSIF") == "经营范围":
                        continue
                    if n and str(n) not in names and len(str(n)) <= 20:
                        names.append(str(n))
        except Exception:
            pass
        if names:
            return names[:8]
        try:
            data = await self._get(
                "https://push2.eastmoney.com/api/qt/slist/get",
                {
                    "spt": "3",
                    "pi": "0",
                    "pz": "30",
                    "po": "1",
                    "np": "1",
                    "fltt": "2",
                    "invt": "2",
                    "secid": to_secid(code),
                    "fields": "f12,f14",
                    "ut": UT_QUOTE,
                },
            )
            diff = ((data.get("data") or {}).get("diff")) or []
            for b in diff:
                n = b.get("f14")
                if n and str(n) not in names:
                    names.append(str(n))
        except Exception:
            return names[:8]
        return names[:8]

    async def fetch_top10_holders(self, code: str) -> dict[str, Any] | None:
        """Latest top-10 holders with name / ratio / shares; prefer complete disclosure dates."""
        try:
            data = await self._get(
                "https://datacenter-web.eastmoney.com/api/data/v1/get",
                {
                    "reportName": "RPT_F10_EH_HOLDERS",
                    "columns": (
                        "END_DATE,HOLDER_RANK,HOLDER_NAME,HOLD_NUM,"
                        "HOLD_NUM_RATIO,HOLD_NUM_CHANGE,SHARES_TYPE"
                    ),
                    "filter": f'(SECUCODE="{to_secucode(code)}")',
                    "pageNumber": "1",
                    "pageSize": "100",
                    "sortColumns": "END_DATE,HOLDER_RANK",
                    "sortTypes": "-1,1",
                    "source": "WEB",
                    "client": "WEB",
                },
                referer="https://data.eastmoney.com/",
            )
            rows = ((data.get("result") or {}).get("data")) or []
            if not rows:
                return None
            grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in rows:
                if not isinstance(row, dict):
                    continue
                end = str(row.get("END_DATE") or "")[:10]
                if not end:
                    continue
                grouped[end].append(row)
            # prefer dates with >=8 holders (complete top10 disclosure)
            candidates = sorted(grouped.items(), key=lambda x: x[0], reverse=True)
            chosen_date = ""
            chosen_rows: list[dict[str, Any]] = []
            for end, items in candidates:
                if len(items) >= 8:
                    chosen_date, chosen_rows = end, items
                    break
            if not chosen_rows and candidates:
                chosen_date, chosen_rows = candidates[0]

            holders: list[dict[str, Any]] = []
            for row in sorted(
                chosen_rows,
                key=lambda r: int(r.get("HOLDER_RANK") or 999),
            )[:10]:
                ratio = row.get("HOLD_NUM_RATIO")
                shares = row.get("HOLD_NUM")
                change = row.get("HOLD_NUM_CHANGE")
                holders.append(
                    {
                        "rank": int(row.get("HOLDER_RANK") or len(holders) + 1),
                        "name": str(row.get("HOLDER_NAME") or "").strip(),
                        "ratio": round(float(ratio), 4) if ratio is not None else None,
                        "shares": float(shares) if shares is not None else None,
                        "change": str(change).strip() if change not in (None, "") else "",
                        "shares_type": str(row.get("SHARES_TYPE") or "").strip(),
                    }
                )
            if not holders:
                return None
            total = sum(float(h["ratio"] or 0) for h in holders)
            return {
                "end_date": chosen_date,
                "total_pct": round(min(total, 100.0), 2),
                "holders": holders,
            }
        except Exception:
            return None

    async def fetch_holders_pct(self, code: str) -> float | None:
        """Sum of top-10 holder ratios on the latest report date that has ~10 holders."""
        data = await self.fetch_top10_holders(code)
        if not data:
            return None
        pct = data.get("total_pct")
        return float(pct) if pct is not None else None

    async def fetch_free_float_shares(self, code: str) -> float | None:
        try:
            data = await self._get(
                "https://datacenter-web.eastmoney.com/api/data/v1/get",
                {
                    "reportName": "RPT_F10_EH_EQUITY",
                    "columns": "END_DATE,FREELIQCI_SHARES,UNLIMITED_SHARES,TOTAL_SHARES",
                    "filter": f'(SECUCODE="{to_secucode(code)}")',
                    "pageNumber": "1",
                    "pageSize": "1",
                    "sortColumns": "END_DATE",
                    "sortTypes": "-1",
                    "source": "WEB",
                    "client": "WEB",
                },
                referer="https://data.eastmoney.com/",
            )
            rows = ((data.get("result") or {}).get("data")) or []
            if not rows:
                return None
            row = rows[0]
            shares = row.get("FREELIQCI_SHARES") or row.get("UNLIMITED_SHARES")
            return float(shares) if shares is not None else None
        except Exception:
            return None

    async def fetch_region(self, code: str) -> str:
        profile = await self.fetch_company_profile(code)
        return profile.get("region") or ""

    async def fetch_fundamentals(self, code: str) -> dict[str, Any]:
        """Aggregate fundamentals for detail drawer / list enrichment."""
        code = code.zfill(6)

        async def _safe_quote():
            try:
                return await self.fetch_quote(code)
            except Exception:
                return {}

        async def _safe_profile():
            try:
                return await self.fetch_company_profile(code)
            except Exception:
                return {}

        async def _safe_concepts():
            try:
                return await self.fetch_stock_concepts(code)
            except Exception:
                return []

        async def _safe_holders():
            try:
                return await self.fetch_top10_holders(code)
            except Exception:
                return None

        async def _safe_free():
            try:
                return await self.fetch_free_float_shares(code)
            except Exception:
                return None

        quote, profile, concepts, holders_pack, free_shares = await asyncio.gather(
            _safe_quote(),
            _safe_profile(),
            _safe_concepts(),
            _safe_holders(),
            _safe_free(),
        )

        price = float(quote.get("price") or 0)
        free_float_mv = round(free_shares * price, 2) if free_shares and price else None
        industry = profile.get("industry") or ""
        if not concepts and industry:
            concepts = [industry]
        seen: set[str] = set()
        uniq: list[str] = []
        for c in concepts:
            if c not in seen:
                seen.add(c)
                uniq.append(c)
        concepts = uniq[:8]

        holders_list = (holders_pack or {}).get("holders") or []
        holders_pct = (holders_pack or {}).get("total_pct")
        holders_end = (holders_pack or {}).get("end_date") or ""
        former_names = profile.get("former_names") or []
        if not isinstance(former_names, list):
            former_names = []

        return {
            "code": code,
            "name": quote.get("name") or profile.get("name") or "",
            "price": price or None,
            "change_pct": quote.get("change_pct"),
            "total_mv": quote.get("total_mv") or None,
            "float_mv": quote.get("float_mv") or None,
            "free_float_mv": free_float_mv,
            "top10_holder_pct": holders_pct,
            "top10_holders": holders_list,
            "top10_holders_date": holders_end,
            "former_names": former_names,
            "concepts": concepts,
            "region": profile.get("region") or "",
            "industry": industry,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }

    async def search_stocks(self, q: str, limit: int = 12) -> list[dict[str, Any]]:
        """Fuzzy search by code / name / pinyin via East Money suggest API."""
        q = (q or "").strip()
        if not q:
            return []
        limit = max(1, min(30, int(limit or 12)))
        try:
            data = await self._get(
                "https://searchapi.eastmoney.com/api/suggest/get",
                {
                    "input": q,
                    "type": "14",
                    "token": "D43BF458C8F90027E856599EC71075A3",
                    "count": str(limit),
                },
                referer="https://so.eastmoney.com/",
            )
        except Exception:
            return []
        rows = ((data.get("QuotationCodeTable") or {}).get("Data")) or []
        out: list[dict[str, Any]] = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            code = str(r.get("Code") or r.get("UnifiedCode") or "").zfill(6)
            if not code.isdigit() or len(code) != 6:
                continue
            # 仅 A 股（含创业/科创/北交）
            classify = str(r.get("Classify") or "")
            sec_type = str(r.get("SecurityTypeName") or "")
            if classify and classify not in ("AStock", "BJStock"):
                # 部分结果无 Classify，靠代码规则兜底
                if not (
                    code.startswith(("0", "3", "6", "8", "9"))
                    or sec_type.endswith("A")
                ):
                    continue
            mkt_num = r.get("MktNum")
            try:
                mkt_flag = int(mkt_num) if mkt_num is not None else None
            except (TypeError, ValueError):
                mkt_flag = None
            out.append(
                {
                    "code": code,
                    "name": str(r.get("Name") or code),
                    "market": _market_prefix(code, mkt_flag),
                    "pinyin": str(r.get("PinYin") or ""),
                }
            )
            if len(out) >= limit:
                break
        return out

    async def fetch_risk_warning_board(self) -> list[dict[str, Any]]:
        """风险警示股列表（ST / *ST）。

        优先东财风险警示板；失败时回退新浪 A 股列表按简称过滤。
        开盘啦「避雷啦」公开接口暂不可用时用此近似。
        """
        rows = await self._fetch_risk_board_eastmoney()
        if rows:
            return rows
        return await self._fetch_risk_board_sina()

    async def _fetch_risk_board_eastmoney(self) -> list[dict[str, Any]]:
        fields = "f12,f13,f14,f2,f3"
        bases = (
            "https://82.push2.eastmoney.com/api/qt/clist/get",
            "https://push2.eastmoney.com/api/qt/clist/get",
            "https://40.push2.eastmoney.com/api/qt/clist/get",
            "https://push2delay.eastmoney.com/api/qt/clist/get",
        )
        out: list[dict[str, Any]] = []
        total = 0
        base_ok = ""
        for base in bases:
            try:
                data = await self._get(
                    base,
                    {
                        "pn": "1",
                        "pz": "100",
                        "po": "1",
                        "np": "1",
                        "fltt": "2",
                        "invt": "2",
                        "fid": "f3",
                        "fs": "m:0 f:4,m:1 f:4",
                        "fields": fields,
                        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                    },
                    referer="https://quote.eastmoney.com/center/gridlist.html#st_board",
                )
                diff = (data.get("data") or {}).get("diff") or []
                if isinstance(diff, dict):
                    diff = list(diff.values())
                if not diff:
                    continue
                total = int((data.get("data") or {}).get("total") or len(diff))
                base_ok = base
                out.extend(diff)
                break
            except Exception:
                continue
        if not base_ok:
            return []

        page = 2
        while len(out) < total and page <= 20:
            try:
                data = await self._get(
                    base_ok,
                    {
                        "pn": str(page),
                        "pz": "100",
                        "po": "1",
                        "np": "1",
                        "fltt": "2",
                        "invt": "2",
                        "fid": "f3",
                        "fs": "m:0 f:4,m:1 f:4",
                        "fields": fields,
                        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                    },
                    referer="https://quote.eastmoney.com/center/gridlist.html#st_board",
                )
                diff = (data.get("data") or {}).get("diff") or []
                if isinstance(diff, dict):
                    diff = list(diff.values())
                if not diff:
                    break
                out.extend(diff)
                page += 1
            except Exception:
                break

        return self._normalize_risk_rows(
            [
                {
                    "code": str(r.get("f12") or "").zfill(6),
                    "name": str(r.get("f14") or ""),
                    "price": r.get("f2") or 0,
                    "change_pct": r.get("f3") or 0,
                }
                for r in out
            ]
        )

    async def _fetch_risk_board_sina(self) -> list[dict[str, Any]]:
        """Scan Sina hs_a pages and keep ST / *ST / 退市 names."""
        client = await self._ensure_client()
        raw: list[dict[str, Any]] = []
        for page in range(1, 80):
            try:
                resp = await client.get(
                    "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData",
                    params={
                        "page": str(page),
                        "num": "80",
                        "sort": "symbol",
                        "asc": "1",
                        "node": "hs_a",
                        "symbol": "",
                        "_s_r_a": "page",
                    },
                    headers={
                        **HEADERS,
                        "Referer": "https://vip.stock.finance.sina.com.cn/mkt/#hs_a",
                    },
                )
                resp.raise_for_status()
                arr = resp.json()
            except Exception:
                break
            if not isinstance(arr, list) or not arr:
                break
            for it in arr:
                name = str(it.get("name") or "")
                if not classify_risk_type(name):
                    continue
                code = str(it.get("code") or "").zfill(6)
                try:
                    price = float(it.get("trade") or 0)
                except (TypeError, ValueError):
                    price = 0.0
                try:
                    change_pct = float(it.get("changepercent") or 0)
                except (TypeError, ValueError):
                    change_pct = 0.0
                raw.append(
                    {
                        "code": code,
                        "name": name,
                        "price": price,
                        "change_pct": change_pct,
                    }
                )
        return self._normalize_risk_rows(raw)

    def _normalize_risk_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for r in rows:
            code = str(r.get("code") or "").zfill(6)
            name = str(r.get("name") or code)
            if not code.isdigit() or code in seen:
                continue
            risk_type = classify_risk_type(name)
            if not risk_type:
                continue
            seen.add(code)
            try:
                price = float(r.get("price") or 0)
            except (TypeError, ValueError):
                price = 0.0
            try:
                change_pct = float(r.get("change_pct") or 0)
            except (TypeError, ValueError):
                change_pct = 0.0
            out.append(
                {
                    "code": code,
                    "name": name,
                    "market": "沪" if code.startswith("6") else "深",
                    "price": price,
                    "change_pct": change_pct,
                    "risk_type": risk_type,
                    "risk_tags": [risk_type],
                    "risk_hint": risk_hint_for(risk_type),
                }
            )
        return out

    async def fetch_speed_rank(self, limit: int = 50) -> list[dict[str, Any]]:
        """A-share intraday speed ranking (东财涨速榜, fid=f22)."""
        limit = max(1, min(100, int(limit or 50)))
        data: dict[str, Any] = {}
        for base in (
            "https://push2.eastmoney.com/api/qt/clist/get",
            "https://82.push2.eastmoney.com/api/qt/clist/get",
            "https://push2delay.eastmoney.com/api/qt/clist/get",
        ):
            try:
                data = await self._get(
                    base,
                    {
                        "pn": "1",
                        "pz": str(limit),
                        "po": "1",
                        "np": "1",
                        "fltt": "2",
                        "invt": "2",
                        "fid": "f22",
                        "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
                        "fields": "f12,f13,f14,f2,f3,f5,f6,f8,f20,f21,f22,f100",
                        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                    },
                    referer="https://quote.eastmoney.com/center/gridlist.html#hs_a_board",
                )
                if (data.get("data") or {}).get("diff") is not None:
                    break
            except Exception:
                continue

        diff = (data.get("data") or {}).get("diff") or []
        if isinstance(diff, dict):
            rows = [v for v in diff.values() if isinstance(v, dict)]
        elif isinstance(diff, list):
            rows = [v for v in diff if isinstance(v, dict)]
        else:
            rows = []

        out: list[dict[str, Any]] = []
        for r in rows:
            code = str(r.get("f12") or "").zfill(6)
            if not code.isdigit():
                continue
            try:
                mkt_flag = int(r.get("f13")) if r.get("f13") is not None else None
            except (TypeError, ValueError):
                mkt_flag = None
            industry = str(r.get("f100") or "")
            # f5 成交量：手 → 股
            vol_hands = float(r.get("f5") or 0) if r.get("f5") not in ("-", None) else 0.0
            out.append(
                {
                    "code": code,
                    "name": str(r.get("f14") or code),
                    "market": _market_prefix(code, mkt_flag),
                    "price": float(r.get("f2") or 0) if r.get("f2") not in ("-", None) else 0.0,
                    "change_pct": float(r.get("f3") or 0) if r.get("f3") not in ("-", None) else 0.0,
                    "speed": float(r.get("f22") or 0) if r.get("f22") not in ("-", None) else 0.0,
                    "amount": float(r.get("f6") or 0) if r.get("f6") not in ("-", None) else 0.0,
                    "volume": vol_hands * 100,
                    "turnover": float(r.get("f8") or 0) if r.get("f8") not in ("-", None) else 0.0,
                    "total_mv": float(r.get("f20") or 0) if r.get("f20") not in ("-", None) else 0.0,
                    "float_mv": float(r.get("f21") or 0) if r.get("f21") not in ("-", None) else 0.0,
                    "industry": industry,
                    "concepts": [industry] if industry else [],
                    "board_count": 1,
                    "open_times": 0,
                }
            )
            if len(out) >= limit:
                break
        return out

    async def fetch_quotes_rich_batch(self, codes: list[str]) -> dict[str, dict[str, Any]]:
        """Batch quotes with amount/volume/mv for watchlist."""
        result: dict[str, dict[str, Any]] = {}
        codes = [c.zfill(6) for c in codes if c]
        if not codes:
            return result

        def _parse_diff(diff: Any) -> list[dict[str, Any]]:
            if not diff:
                return []
            if isinstance(diff, dict):
                return [v for v in diff.values() if isinstance(v, dict)]
            if isinstance(diff, list):
                return [v for v in diff if isinstance(v, dict)]
            return []

        for i in range(0, len(codes), 50):
            chunk = codes[i : i + 50]
            try:
                data = await self._get(
                    "https://push2.eastmoney.com/api/qt/ulist.np/get",
                    {
                        "fltt": "2",
                        "secids": ",".join(to_secid(c) for c in chunk),
                        "fields": "f2,f3,f5,f6,f8,f12,f13,f14,f20,f21,f100",
                        "ut": UT_QUOTE,
                    },
                    referer="https://quote.eastmoney.com/",
                )
                for row in _parse_diff(((data.get("data") or {}).get("diff"))):
                    code = str(row.get("f12") or "").zfill(6)
                    if not code or code == "000000":
                        continue
                    try:
                        mkt_flag = int(row.get("f13")) if row.get("f13") is not None else None
                    except (TypeError, ValueError):
                        mkt_flag = None
                    industry = str(row.get("f100") or "")
                    vol_hands = float(row.get("f5") or 0) if row.get("f5") not in ("-", None) else 0.0
                    result[code] = {
                        "code": code,
                        "name": str(row.get("f14") or ""),
                        "market": _market_prefix(code, mkt_flag),
                        "price": float(row.get("f2") or 0) if row.get("f2") not in ("-", None) else 0.0,
                        "change_pct": float(row.get("f3") or 0) if row.get("f3") not in ("-", None) else 0.0,
                        "volume": vol_hands * 100,
                        "amount": float(row.get("f6") or 0) if row.get("f6") not in ("-", None) else 0.0,
                        "turnover": float(row.get("f8") or 0) if row.get("f8") not in ("-", None) else 0.0,
                        "total_mv": float(row.get("f20") or 0) if row.get("f20") not in ("-", None) else 0.0,
                        "float_mv": float(row.get("f21") or 0) if row.get("f21") not in ("-", None) else 0.0,
                        "industry": industry,
                        "concepts": [industry] if industry else [],
                    }
            except Exception:
                pass
            missing = [c for c in chunk if c not in result]
            if missing:
                basic = await self.fetch_quotes_batch(missing)
                for code, q in basic.items():
                    result[code] = {
                        "code": code,
                        "name": q.get("name") or "",
                        "market": _market_prefix(code),
                        "price": float(q.get("price") or 0),
                        "change_pct": float(q.get("change_pct") or 0),
                        "volume": float(q.get("volume") or 0),
                        "amount": float(q.get("amount") or 0),
                        "turnover": 0.0,
                        "total_mv": float(q.get("total_mv") or 0),
                        "float_mv": float(q.get("float_mv") or 0),
                        "industry": "",
                        "concepts": [],
                    }
        return result

    async def iter_recent_zt_pools(self, trading_days: int = 120):
        """Yield (date, rows) for recent trading days that have zt data."""
        got = 0
        d = datetime.now().date()
        # look back enough calendar days to cover weekends/holidays
        for _ in range(trading_days * 2 + 30):
            d = d - timedelta(days=1)
            if d.weekday() >= 5:
                continue
            ds = d.strftime("%Y%m%d")
            try:
                rows = await self.fetch_zt_pool(ds)
            except Exception:
                continue
            if not rows:
                continue
            yield ds, rows
            got += 1
            if got >= trading_days:
                break
