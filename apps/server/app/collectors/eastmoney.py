from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from datetime import datetime, time, timedelta
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


def infer_limit_up(code: str, name: str, prev_close: float) -> float:
    """按板块规则由昨收推算涨停价（腾讯 limit_up 偶发为空时兜底）。"""
    prev = float(prev_close or 0)
    if prev <= 0:
        return 0.0
    code = (code or "").zfill(6)
    risk = classify_risk_type(name or "")
    if risk in ("st", "delist"):
        ratio = 0.05
    elif code.startswith(("300", "301", "688", "689")):
        ratio = 0.20
    else:
        ratio = 0.10
    # A 股涨停价：四舍五入到分
    return round(prev * (1.0 + ratio) + 1e-8, 2)


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
        # 炸板池有涨停价 ztp（÷1000）；涨停池无此字段
        "limit_price": _price(row.get("ztp")) if row.get("ztp") not in (None, "") else 0.0,
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

    async def fetch_stock_limit_events(
        self,
        code: str,
        *,
        close_up: str | None = None,
    ) -> list[dict[str, Any]]:
        """个股触板/涨停事件（东财 RPT_DMSK_LIMITUP）。

        close_up:
          - \"1\": 收盘封住涨停（对齐同花顺涨停池）
          - \"0\": 曾触板但未收盘封住
          - None: 全部触板日
        返回按日期降序 [{trade_date, name, first_seal_time, sealed}, ...]。
        """
        code = (code or "").zfill(6)
        if not code.isdigit():
            return []
        filt = f'(SECURITY_CODE="{code}")'
        if close_up in ("0", "1"):
            filt += f'(IS_CLOSE_UP="{close_up}")'
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
                        "filter": filt,
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
                raw = td.replace("-", "").replace(" ", "")[:8]
                if len(raw) != 8 or not raw.isdigit():
                    continue
                first_t = str(r.get("FIRST_LIMITUP_TIME") or "")
                if first_t and ":" not in first_t:
                    first_t = _fmt_time(first_t)
                sealed_flag = str(r.get("IS_CLOSE_UP") or "")
                out.append(
                    {
                        "trade_date": raw,
                        "name": str(r.get("SECURITY_NAME_ABBR") or code),
                        "first_seal_time": first_t,
                        "sealed": sealed_flag in ("1", "1.0", "true", "True"),
                    }
                )
            total = int(result.get("count") or 0)
            if page * page_size >= total or len(rows) < page_size:
                break
            page += 1
        seen: set[str] = set()
        uniq: list[dict[str, Any]] = []
        for row in out:
            ds = row["trade_date"]
            if ds in seen:
                continue
            seen.add(ds)
            uniq.append(row)
        return uniq

    async def fetch_stock_limitup_dates(self, code: str) -> list[dict[str, Any]]:
        """个股历史收盘涨停日期（DMSK IS_CLOSE_UP=1）。"""
        return await self.fetch_stock_limit_events(code, close_up="1")

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

    @staticmethod
    def _norm_day_str(date: str | None) -> str:
        """Normalize to YYYY-MM-DD; empty if invalid."""
        raw = (date or "").replace("-", "").strip()
        if len(raw) == 8 and raw.isdigit():
            return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
        d = (date or "").strip()
        if len(d) >= 10 and d[4] == "-" and d[7] == "-":
            return d[:10]
        return ""

    async def fetch_trends(self, code: str, date: str | None = None) -> dict[str, Any]:
        """Intraday trend. Prefer today; before open / thin today → previous trading day.

        date: 指定交易日（YYYYMMDD / YYYY-MM-DD）时返回该日分时（历史回溯用）。
        """
        code = code.zfill(6)
        day = self._norm_day_str(date)
        if day:
            hist = await self._fetch_trends_on_date(code, day)
            if hist.get("points"):
                return hist
            return {
                "code": code,
                "name": str(hist.get("name") or ""),
                "pre_close": float(hist.get("pre_close") or 0),
                "points": [],
                "trade_date": day,
            }

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

    async def _fetch_trends_on_date(self, code: str, day: str) -> dict[str, Any]:
        """按指定交易日取分时：腾讯多日 → 东财 trends2 → 东财 1 分钟 K。"""
        code = code.zfill(6)
        day = self._norm_day_str(day)
        empty = {"code": code, "name": "", "pre_close": 0, "points": [], "trade_date": day}
        if not day:
            return empty

        # 1) 腾讯最近约 5 个交易日分时
        qq = await self._fetch_trends_tencent_days(code, prefer_day=day)
        if qq.get("points") and self._norm_day_str(str(qq.get("trade_date") or "")) == day:
            return qq

        # 2) 东财近几日 trends，精确匹配目标日
        em = await self._fetch_trends_eastmoney(code, prefer_day=day)
        if em.get("points") and self._norm_day_str(str(em.get("trade_date") or "")) == day:
            return em

        # 3) 东财 1 分钟 K（任意历史日，上游可用时）
        minute = await self._fetch_trends_minute_kline(code, day)
        if minute.get("points"):
            return minute

        # 带回名称（若有）
        for cand in (qq, em, minute):
            if cand and cand.get("name"):
                empty["name"] = cand["name"]
                break
        return empty

    async def _fetch_trends_minute_kline(self, code: str, day: str) -> dict[str, Any]:
        """用东财 1 分钟 K 拼分时（beg=end=指定日）。"""
        code = code.zfill(6)
        day = self._norm_day_str(day)
        compact = day.replace("-", "")
        empty = {"code": code, "name": "", "pre_close": 0, "points": [], "trade_date": day}
        if len(compact) != 8:
            return empty
        params = {
            "secid": to_secid(code),
            "klt": "1",
            "fqt": "1",
            "lmt": "300",
            "beg": compact,
            "end": compact,
            "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "ut": UT_QUOTE,
            "rtntype": "6",
        }
        data: dict[str, Any] = {}
        for base in (
            "https://push2his.eastmoney.com/api/qt/stock/kline/get",
            "https://push2delay.eastmoney.com/api/qt/stock/kline/get",
            "https://push2.eastmoney.com/api/qt/stock/kline/get",
        ):
            try:
                data = await self._get(base, params, referer="https://quote.eastmoney.com/")
                if (data.get("data") or {}).get("klines"):
                    break
            except Exception:
                continue
        payload = data.get("data") or {}
        raw_lines = payload.get("klines") or []
        if not raw_lines:
            return empty

        points: list[dict[str, Any]] = []
        cum_vol = 0.0
        cum_amt = 0.0
        for line in raw_lines:
            parts = str(line).split(",")
            if len(parts) < 6:
                continue
            dt = parts[0]
            time_label = dt.split(" ")[-1] if " " in dt else dt
            if len(time_label) >= 5:
                time_label = time_label[:5]
            try:
                close = float(parts[2] or parts[1] or 0)
                vol = float(parts[5] or 0)
                amt = float(parts[6] or 0) if len(parts) > 6 else 0.0
            except (TypeError, ValueError):
                continue
            cum_vol += vol
            cum_amt += amt
            avg = (cum_amt / cum_vol) if cum_vol > 0 else close
            pt: dict[str, Any] = {
                "time": time_label,
                "price": close,
                "avg": round(avg, 3),
                "volume": vol,
            }
            if amt > 0:
                pt["amount"] = amt
            points.append(pt)

        pre_close = 0.0
        try:
            daily = await self.fetch_kline(code, limit=10)
            bars = list(daily.get("bars") or [])
            for i, b in enumerate(bars):
                bd = self._norm_day_str(str(b.get("date") or ""))
                if bd == day and i > 0:
                    pre_close = float(bars[i - 1].get("close") or 0)
                    break
                if bd == day and i == 0 and len(bars) > 1:
                    # 目标日是窗口第一根时无法取昨收
                    pass
        except Exception:
            pass

        return {
            "code": code,
            "name": str(payload.get("name") or ""),
            "pre_close": pre_close,
            "points": points,
            "trade_date": day,
        }

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

    async def _fetch_trends_eastmoney(
        self, code: str, prefer_day: str | None = None
    ) -> dict[str, Any]:
        code = code.zfill(6)
        prefer = self._norm_day_str(prefer_day)
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
                day = self._norm_day_str(dt.split(" ")[0] if " " in dt else dt)
                time_label = dt.split(" ")[-1] if " " in dt else dt
                if len(time_label) >= 5:
                    time_label = time_label[:5]
                pt: dict[str, Any] = {
                    "time": time_label,
                    "price": float(parts[1] or 0),
                    "avg": float(parts[2] or 0),
                    "volume": float(parts[5] or 0) if len(parts) > 5 else 0,
                }
                # 东财 trends 常见: ...,量,额,...
                if len(parts) > 6 and parts[6] not in ("", None):
                    try:
                        pt["amount"] = float(parts[6])
                    except (TypeError, ValueError):
                        pass
                if day:
                    by_day[day].append(pt)

            if prefer and prefer in by_day and by_day[prefer]:
                return {
                    "code": code,
                    "name": str(payload.get("name") or ""),
                    "pre_close": float(payload.get("preClose") or payload.get("prePrice") or 0),
                    "points": by_day[prefer],
                    "trade_date": prefer,
                }

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

    async def _fetch_trends_tencent_days(
        self, code: str, prefer_day: str | None = None
    ) -> dict[str, Any]:
        code = code.zfill(6)
        prefer = self._norm_day_str(prefer_day)
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
                day = self._norm_day_str(d_raw)
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
                    cum_vol = float(parts[2] or 0) if len(parts) > 2 else prev_vol  # 手（累计）
                except (TypeError, ValueError):
                    cum_vol = prev_vol
                try:
                    cum_amt = float(parts[3] or 0) if len(parts) > 3 else 0.0
                except (TypeError, ValueError):
                    cum_amt = 0.0
                vol_hands = max(0.0, cum_vol - prev_vol)
                prev_vol = cum_vol
                avg = (cum_amt / (cum_vol * 100)) if cum_vol > 0 else price
                pt: dict[str, Any] = {
                    "time": time_label,
                    "price": price,
                    "avg": round(avg, 3),
                    "volume": vol_hands * 100,
                }
                if cum_amt > 0:
                    # 累计额差近似当分钟成交额
                    pass
                points.append(pt)
            if points and day:
                by_day[day] = points

        # 名称可从 qt 取
        qt = (node.get("qt") or {}).get(sym) or []
        if isinstance(qt, list) and len(qt) > 1:
            name = str(qt[1] or "")

        if prefer and prefer in by_day and by_day[prefer]:
            return {
                "code": code,
                "name": name,
                "pre_close": pre_by_day.get(prefer) or 0,
                "points": by_day[prefer],
                "trade_date": prefer,
            }

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

    async def fetch_kline(
        self, code: str, limit: int = 120, *, fqt: int = 1
    ) -> dict[str, Any]:
        """Daily K-line bars (Eastmoney first, Sina/Tencent fallback).

        fqt: 0=不复权, 1=前复权, 2=后复权。基因次日指标请用 0。
        """
        code = code.zfill(6)
        fqt_s = str(int(fqt)) if int(fqt) in (0, 1, 2) else "1"
        params = {
            "secid": to_secid(code),
            "klt": "101",
            "fqt": fqt_s,
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
            # 东财日K: 日期,开,收,高,低,量,额,振幅%,涨跌幅%,涨跌额,换手%
            bars.append(
                {
                    "date": parts[0],
                    "open": float(parts[1] or 0),
                    "close": float(parts[2] or 0),
                    "high": float(parts[3] or 0),
                    "low": float(parts[4] or 0),
                    "volume": float(parts[5] or 0),
                    "amount": float(parts[6] or 0) if len(parts) > 6 and parts[6] not in ("", "-") else None,
                    "amplitude": float(parts[7] or 0) if len(parts) > 7 and parts[7] not in ("", "-") else None,
                    "pct": float(parts[8] or 0) if len(parts) > 8 else 0,
                    "change": float(parts[9] or 0) if len(parts) > 9 and parts[9] not in ("", "-") else None,
                    "turnover": float(parts[10] or 0) if len(parts) > 10 and parts[10] not in ("", "-") else None,
                }
            )
        name = str(payload.get("name") or "")
        if not bars:
            data = await self._fetch_kline_sina(code, limit)
            bars = list(data.get("bars") or [])
            name = name or str(data.get("name") or "")
        if bars:
            bars = await self._merge_today_bar(code, bars, limit)
            bars = await self._enrich_kline_bars(code, bars)
            return {"code": code, "name": name, "bars": bars}
        return {"code": code, "name": name, "bars": []}

    async def _enrich_kline_bars(self, code: str, bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """补齐涨跌幅/额/振幅/成交额/换手率（东财不可用时用 OHLC+流通市值推算）。"""
        if not bars:
            return bars

        prev_close = 0.0
        for b in bars:
            o = float(b.get("open") or 0)
            h = float(b.get("high") or 0)
            l = float(b.get("low") or 0)
            c = float(b.get("close") or 0)
            vol = float(b.get("volume") or 0)

            if (not b.get("pct") or abs(float(b.get("pct") or 0)) < 1e-12) and prev_close > 0 and c > 0:
                b["pct"] = round((c - prev_close) / prev_close * 100, 2)
            if b.get("change") is None and prev_close > 0 and c > 0:
                b["change"] = round(c - prev_close, 2)
            if b.get("amplitude") is None and prev_close > 0 and h > 0 and l > 0:
                b["amplitude"] = round((h - l) / prev_close * 100, 2)
            if (b.get("amount") is None or float(b.get("amount") or 0) <= 0) and vol > 0 and c > 0:
                typ = (o + h + l + c) / 4.0 if o > 0 and h > 0 and l > 0 else c
                b["amount"] = round(vol * typ, 2)
            if c > 0:
                prev_close = c

        float_shares = 0.0
        last_close = float(bars[-1].get("close") or 0)
        float_mv = 0.0
        try:
            from ..db import get_fundamentals

            fund = await get_fundamentals(code)
            if fund:
                float_mv = float(fund.get("float_mv") or 0)
        except Exception:
            pass
        if float_mv <= 0:
            try:
                q = await self.fetch_quote(code)
                float_mv = float((q or {}).get("float_mv") or 0)
                if last_close <= 0:
                    last_close = float((q or {}).get("price") or 0)
            except Exception:
                pass
        if float_mv > 0 and last_close > 0:
            float_shares = float_mv / last_close

        if float_shares > 0:
            for b in bars:
                if b.get("turnover") is not None and float(b.get("turnover") or 0) > 0:
                    continue
                vol = float(b.get("volume") or 0)
                if vol > 0:
                    b["turnover"] = round(vol / float_shares * 100, 2)
        return bars

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
            "amount": None,
            "amplitude": None,
            "pct": float(q.get("change_pct") or 0),
            "change": float(q.get("change") or 0) if q.get("change") is not None else None,
            "turnover": None,
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
                    "amount": None,
                    "amplitude": None,
                    "pct": 0.0,
                    "change": None,
                    "turnover": None,
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
                    "amount": None,
                    "amplitude": None,
                    "pct": 0.0,
                    "change": None,
                    "turnover": None,
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
                    buy1 = float(parts[9] or 0) if len(parts) > 9 else 0.0
                    buy1_vol_hands = float(parts[10] or 0) if len(parts) > 10 else 0.0
                    sell1 = float(parts[19] or 0) if len(parts) > 19 else 0.0
                    sell1_vol_hands = float(parts[20] or 0) if len(parts) > 20 else 0.0
                    limit_up = float(parts[47] or 0) if len(parts) > 47 else 0.0
                    limit_down = float(parts[48] or 0) if len(parts) > 48 else 0.0
                    amount = 0.0
                    # index 35 形如 "现价/成交量(手)/成交额(元)"
                    if len(parts) > 35 and parts[35] and "/" in str(parts[35]):
                        try:
                            segs = str(parts[35]).split("/")
                            if len(segs) >= 3:
                                amount = float(segs[2] or 0)
                        except (TypeError, ValueError):
                            amount = 0.0
                    if amount <= 0 and len(parts) > 37 and parts[37] not in ("", None):
                        try:
                            # 备选：万元
                            amount = float(parts[37] or 0) * 10000
                        except (TypeError, ValueError):
                            amount = 0.0
                    seal_amount = 0.0
                    if buy1 > 0 and buy1_vol_hands > 0:
                        seal_amount = buy1_vol_hands * 100 * buy1
                    result[code] = {
                        "code": code,
                        "name": name,
                        "price": price,
                        "change_pct": change_pct,
                        "volume": vol_hands * 100,
                        "amount": amount,
                        "total_mv": total_yi * 1e8 if total_yi else 0.0,
                        "float_mv": float_yi * 1e8 if float_yi else 0.0,
                        "open": float(parts[5] or 0) if len(parts) > 5 else 0.0,
                        "high": float(parts[33] or 0) if len(parts) > 33 else 0.0,
                        "low": float(parts[34] or 0) if len(parts) > 34 else 0.0,
                        "prev_close": prev,
                        "buy1": buy1,
                        "buy1_vol": buy1_vol_hands * 100,
                        "sell1": sell1,
                        "sell1_vol": sell1_vol_hands * 100,
                        "limit_up": limit_up,
                        "limit_down": limit_down,
                        "seal_amount": seal_amount,
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

    async def fetch_equity_structure(self, code: str) -> dict[str, Any] | None:
        """Latest share structure: free-float / unlimited / total shares."""
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

            def _num(key: str) -> float | None:
                v = row.get(key)
                if v is None or v == "":
                    return None
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None

            return {
                "end_date": str(row.get("END_DATE") or "")[:10],
                "freeliqci_shares": _num("FREELIQCI_SHARES"),
                "unlimited_shares": _num("UNLIMITED_SHARES"),
                "total_shares": _num("TOTAL_SHARES"),
            }
        except Exception:
            return None

    async def fetch_free_float_shares(self, code: str) -> float | None:
        """Backward-compatible: free-float shares only (may be stale without holders)."""
        eq = await self.fetch_equity_structure(code)
        if not eq:
            return None
        return eq.get("freeliqci_shares") or eq.get("unlimited_shares")

    @staticmethod
    def _major_holder_stats(holders: list[dict[str, Any]]) -> tuple[float, float]:
        """Sum ratio/shares for holders with >=5% (official free-float exclusion)."""
        maj_pct = 0.0
        maj_shares = 0.0
        for h in holders or []:
            try:
                ratio = float(h.get("ratio") or 0)
            except (TypeError, ValueError):
                continue
            if ratio < 5.0:
                continue
            maj_pct += ratio
            try:
                sh = h.get("shares")
                if sh is not None and sh != "":
                    maj_shares += float(sh)
            except (TypeError, ValueError):
                pass
        return maj_pct, maj_shares

    @staticmethod
    def resolve_free_float_shares(
        *,
        freeliqci: float | None,
        unlimited: float | None,
        total: float | None,
        float_mv: float | None,
        price: float | None,
        major_pct: float,
        major_shares: float,
    ) -> float | None:
        """Resolve free-float shares.

        Official-ish A-share rule:
          free = circulating(unlimited) - >=5% holders' unrestricted shares.
        East Money FREELIQCI is preferred when it is not obviously stale/inflated
        (e.g. equals total shares on a fully-circulated name with large holders).
        """
        float_shares: float | None = None
        if float_mv and price and price > 0:
            float_shares = float(float_mv) / float(price)
        circ = unlimited or float_shares
        if circ is not None and circ <= 0:
            circ = None

        calc: float | None = None
        if circ is not None:
            if major_shares > 0:
                limited = 0.0
                if total and total > circ:
                    limited = float(total) - float(circ)
                major_in_float = max(0.0, float(major_shares) - limited)
                major_in_float = min(major_in_float, float(circ))
                calc = max(0.0, float(circ) - major_in_float)
            elif major_pct >= 5.0:
                calc = max(0.0, float(circ) * (1.0 - float(major_pct) / 100.0))
            else:
                calc = float(circ)

        em = float(freeliqci) if freeliqci and freeliqci > 0 else None
        # 自由流通不应超过流通股本（个别东财行 FREELIQCI>UNLIMITED）
        if em is not None and circ is not None:
            em = min(em, float(circ))
        if calc is not None and circ is not None:
            calc = min(calc, float(circ))
        if em is not None and calc is not None:
            # EM lower/equal → more refined exclusions; EM much higher → stale.
            if em <= calc * 1.05:
                return em
            return calc
        if em is not None:
            return em
        return calc

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

        async def _safe_equity():
            try:
                return await self.fetch_equity_structure(code)
            except Exception:
                return None

        quote, profile, concepts, holders_pack, equity = await asyncio.gather(
            _safe_quote(),
            _safe_profile(),
            _safe_concepts(),
            _safe_holders(),
            _safe_equity(),
        )

        price = float(quote.get("price") or 0)
        total_mv = float(quote.get("total_mv") or 0) or None
        float_mv = float(quote.get("float_mv") or 0) or None
        holders_list = (holders_pack or {}).get("holders") or []
        holders_pct = (holders_pack or {}).get("total_pct")
        holders_end = (holders_pack or {}).get("end_date") or ""
        maj_pct, maj_shares = self._major_holder_stats(holders_list)
        eq = equity or {}
        free_shares = self.resolve_free_float_shares(
            freeliqci=eq.get("freeliqci_shares"),
            unlimited=eq.get("unlimited_shares"),
            total=eq.get("total_shares"),
            float_mv=float_mv,
            price=price or None,
            major_pct=maj_pct,
            major_shares=maj_shares,
        )
        free_float_mv = (
            round(float(free_shares) * price, 2) if free_shares and price else None
        )
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

        former_names = profile.get("former_names") or []
        if not isinstance(former_names, list):
            former_names = []

        return {
            "code": code,
            "name": quote.get("name") or profile.get("name") or "",
            "price": price or None,
            "change_pct": quote.get("change_pct"),
            "total_mv": total_mv,
            "float_mv": float_mv,
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

    async def fetch_auction_limit_pool(self, date: str | None = None) -> list[dict[str, Any]]:
        """兼容旧名：转调全市场竞价观察池。"""
        return await self.fetch_auction_market_pool(limit=350)

    @staticmethod
    def em_auction_yizhi_fresh(auction_time: str, now: datetime | None = None) -> bool:
        """判断东财 jjyd 时间戳是否属于「当前竞价会话」，避免串入昨日 09:25 列表。

        - 09:15–09:24：仅接受时间落在 [09:15, 当前时刻] 的条目
        - ≥09:25：接受 09:25:xx（官方竞价一字板落定）
        """
        now = now or datetime.now()
        at = (auction_time or "").strip()
        if not at.startswith("09:"):
            return False
        parts = at.split(":")
        try:
            ath = int(parts[0])
            atm = int(parts[1]) if len(parts) > 1 else 0
            ats = int(parts[2]) if len(parts) > 2 else 0
        except (TypeError, ValueError):
            return False
        stamp = time(ath, atm, min(ats, 59))
        nt = now.time()
        if nt < time(9, 25):
            return time(9, 15) <= stamp <= nt
        return ath == 9 and atm >= 25

    async def fetch_em_auction_jjyd(
        self, *, sk: str = "0", limit: int = 150
    ) -> list[dict[str, Any]]:
        """东方财富集合竞价 jjyd 官方榜。

        - sk=0：按竞价涨幅(f7)降序的全市场竞价榜（对齐东财「集合竞价」涨幅排序）
        - sk=1：竞价一字板（涨停撮合且有未匹配额）
        字段：f6=未匹配额(元，一字有效)，f7=竞价涨幅%，f8=撮合价，f11=竞价成交额。
        """
        sk = str(sk or "0")
        limit = max(20, min(500, int(limit or 150)))
        data: dict[str, Any] = {}
        for base in (
            "https://push2dycalc.eastmoney.com/api/qt/jjyd/get",
            "https://push2dycalcl2.eastmoney.com/api/qt/jjyd/get",
        ):
            try:
                data = await self._get(
                    base,
                    {
                        "fltt": "2",
                        "fields": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11",
                        "sk": sk,
                        "mt": "109",
                        "new": "1",
                        "fid": "f7",
                        "po": "1",
                        "pi": "0",
                        "pz": str(limit),
                        "ut": UT_QUOTE,
                    },
                    referer="https://vipmoney.eastmoney.com/collect/watchstock/bidding.html",
                )
                if (data.get("data") or {}).get("jjyd") is not None:
                    break
            except Exception:
                continue
        rows = (data.get("data") or {}).get("jjyd") or []
        out: list[dict[str, Any]] = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            code = str(r.get("f2") or "").zfill(6)
            if not code.isdigit():
                continue
            name = str(r.get("f4") or code).strip()
            # 新股申购/上市首日（N/C 前缀）涨幅失真，不进竞价榜
            if name.startswith(("N", "C", "n", "c")):
                continue
            price = float(r.get("f8") or 0)
            noe = float(r.get("f6") or 0)
            pct = float(r.get("f7") or 0)
            amount = float(r.get("f11") or 0)
            # 北交所约 30%、主板 10%、双创 20%；>31 多为脏数据
            if abs(pct) > 31:
                continue
            # 非一字榜 f6 常与涨幅同量级，不可当未匹配额；仅 sk=1 信 seal
            is_yizhi = sk == "1" and noe > 0 and price > 0
            seal = noe if is_yizhi else 0.0
            nol_hands = (seal / price / 100.0) if is_yizhi and price > 0 else 0.0
            mkt = int(r.get("f3") or 0)
            out.append(
                {
                    "code": code,
                    "name": name or code,
                    "price": price,
                    "last_price": price,
                    "auction_pct": pct,
                    "change_pct": pct,
                    "amount": amount,
                    "seal_amount": seal,
                    "unmatched_vol": nol_hands,
                    "is_yizhi": is_yizhi,
                    "board_count": 1,
                    "industry": "",
                    "concepts": [],
                    "market": "沪" if mkt == 1 else "深",
                    "auction_time": str(r.get("f1") or ""),
                    "float_mv": 0.0,
                    "limit_up": price if is_yizhi and price > 0 else 0.0,
                }
            )
        if sk == "1":
            out.sort(key=lambda x: float(x.get("seal_amount") or 0), reverse=True)
        else:
            out.sort(key=lambda x: float(x.get("auction_pct") or 0), reverse=True)
        return out[:limit]

    async def fetch_em_auction_yizhi(self) -> list[dict[str, Any]]:
        """东方财富「集合竞价 → 竞价一字板」官方列表（jjyd sk=1）。"""
        return await self.fetch_em_auction_jjyd(sk="1", limit=100)

    async def fetch_em_auction_pct_rank(self, limit: int = 150) -> list[dict[str, Any]]:
        """东方财富集合竞价涨幅榜（jjyd sk=0），对齐东财 App 竞价涨幅排序。"""
        return await self.fetch_em_auction_jjyd(sk="0", limit=limit)

    async def _fetch_auction_rank_codes_sina(
        self, *, each: int = 80
    ) -> list[tuple[str, str]]:
        """新浪涨/跌幅榜候选（东财 clist 不稳定时的兜底）。"""
        each = max(20, min(120, int(each or 80)))
        client = await self._ensure_client()
        found: list[tuple[str, str]] = []
        seen: set[str] = set()
        for asc in ("0", "1"):  # 涨幅 / 跌幅
            try:
                resp = await client.get(
                    "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData",
                    params={
                        "page": "1",
                        "num": str(each),
                        "sort": "changepercent",
                        "asc": asc,
                        "node": "hs_a",
                        "symbol": "",
                        "_s_r_a": "init",
                    },
                    headers={
                        **HEADERS,
                        "Referer": "https://vip.stock.finance.sina.com.cn/mkt/#hs_a",
                    },
                )
                resp.raise_for_status()
                arr = resp.json()
            except Exception:
                continue
            if not isinstance(arr, list):
                continue
            for it in arr:
                if not isinstance(it, dict):
                    continue
                code = str(it.get("code") or "").zfill(6)
                if not code.isdigit() or code in seen:
                    continue
                seen.add(code)
                found.append((code, ""))
        return found

    async def fetch_auction_matched_amounts(
        self, codes: list[str], *, concurrency: int = 16
    ) -> dict[str, float]:
        """盘后回补竞价撮合额：取分时首根(约 09:30)成交额，即集合竞价已匹配额。"""
        out: dict[str, float] = {}
        codes = [str(c).zfill(6) for c in codes if c]
        if not codes:
            return out
        sem = asyncio.Semaphore(max(4, min(32, int(concurrency or 16))))

        async def _one(code: str) -> None:
            async with sem:
                try:
                    data = await self._get(
                        "https://push2his.eastmoney.com/api/qt/stock/trends2/get",
                        {
                            "secid": to_secid(code),
                            "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
                            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
                            "iscr": "0",
                            "ndays": "1",
                            "iscca": "1",
                        },
                        referer="https://quote.eastmoney.com/",
                    )
                except Exception:
                    return
                trends = (data.get("data") or {}).get("trends") or []
                if not trends:
                    return
                # "YYYY-MM-DD HH:MM,open,close,high,low,volume,amount,avg"
                parts = str(trends[0]).split(",")
                if len(parts) < 7:
                    return
                try:
                    amt = float(parts[6] or 0)
                except (TypeError, ValueError):
                    return
                if amt > 0:
                    out[code] = amt

        await asyncio.gather(*[_one(c) for c in codes])
        return out

    async def fetch_auction_market_pool(
        self,
        limit: int = 350,
        *,
        use_open: bool = False,
        fast: bool = False,
        seed_codes: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """早盘集合竞价观察池（全 A 候选，禁止涨停池）。

        口径（仅竞价 9:15–9:30，与盘中/收盘无关）：
        - 默认观察池约 350：涨/跌/额榜合并截断，保证含竞价一字与活跃非一字
        - 价格/涨幅：竞价中=撮合价；盘后 use_open=开盘价（=9:25 撮合结果）
        - amount=竞价已匹配成交额（竞价中=盘口累计额；盘后=分时首根额）
        - seal_amount=竞价未匹配额：触板时记买一额，否则 0
        - is_yizhi：竞价中=触板且有未匹配；盘后一字以东财 jjyd sk=1 为准
        - seed_codes：强制纳入（昨涨停 / 东财一字等），防止榜单接口丢涨停候选
        fast=True：竞价高频轮询，少翻页以压低单轮耗时。
        """
        limit = max(80, min(400, int(limit or 350)))
        codes: list[str] = []
        seen: set[str] = set()
        industry_map: dict[str, str] = {}

        # 种子代码优先，确保一字/昨板不会被榜单失败漏掉
        for raw in seed_codes or []:
            code = str(raw or "").zfill(6)
            if code.isdigit() and code not in seen:
                seen.add(code)
                codes.append(code)

        async def _pull(fid: str, po: str, pages: int = 5) -> list[tuple[str, str]]:
            found: list[tuple[str, str]] = []
            local_seen: set[str] = set()
            for pn in range(1, pages + 1):
                data: dict[str, Any] = {}
                for base in (
                    "https://push2.eastmoney.com/api/qt/clist/get",
                    "https://82.push2.eastmoney.com/api/qt/clist/get",
                    "https://40.push2.eastmoney.com/api/qt/clist/get",
                    "https://push2delay.eastmoney.com/api/qt/clist/get",
                ):
                    try:
                        data = await self._get(
                            base,
                            {
                                "pn": str(pn),
                                "pz": "100",
                                "po": po,
                                "np": "1",
                                "fltt": "2",
                                "invt": "2",
                                "fid": fid,
                                "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
                                "fields": "f12,f13,f14,f2,f3,f6,f17,f100",
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
                if not rows:
                    break
                for r in rows:
                    code = str(r.get("f12") or "").zfill(6)
                    if not code.isdigit() or code in local_seen:
                        continue
                    local_seen.add(code)
                    ind = str(r.get("f100") or "").strip()
                    found.append((code, ind))
            return found

        # 涨幅 / 跌幅 / 成交额 — 并行拉榜，压低竞价高频单轮耗时
        if fast:
            # 200 池：涨幅/跌幅/成交各少翻页，并行拉取
            pull_jobs = [
                _pull("f3", "1", 2),
                _pull("f3", "0", 1),
                _pull("f6", "1", 2),
            ]
        else:
            pull_jobs = [
                _pull("f3", "1", 3),
                _pull("f3", "0", 2),
                _pull("f6", "1", 3),
                _pull("f17", "1", 2),
            ]
        clist_n = 0
        for chunk in await asyncio.gather(*pull_jobs):
            for code, ind in chunk:
                clist_n += 1
                if code in seen:
                    continue
                seen.add(code)
                codes.append(code)
                if ind:
                    industry_map[code] = ind

        # 东财 clist 偶发断连：用新浪涨跌榜补候选，避免只剩跌停侧
        if clist_n < 30:
            try:
                sina_chunk = await self._fetch_auction_rank_codes_sina(each=100)
            except Exception:
                sina_chunk = []
            for code, ind in sina_chunk:
                if code in seen:
                    continue
                seen.add(code)
                codes.append(code)
                if ind:
                    industry_map[code] = ind

        quotes = await self.fetch_quotes_tencent_batch(codes[: max(limit * 2, 800)])
        out: list[dict[str, Any]] = []
        for code in codes:
            q = quotes.get(code)
            if not q:
                continue
            prev = float(q.get("prev_close") or 0)
            open_p = float(q.get("open") or 0)
            last = float(q.get("price") or 0)
            name = str(q.get("name") or code)
            if name.startswith(("N", "C", "n", "c")):
                continue
            live_pct = float(q.get("change_pct") or 0)
            if abs(live_pct) < 1e-12 and prev > 0 and last > 0:
                live_pct = round((last - prev) / prev * 100, 2)
            float_mv = float(q.get("float_mv") or 0)
            limit_up = float(q.get("limit_up") or 0)
            if limit_up <= 0 and prev > 0:
                limit_up = infer_limit_up(code, name, prev)
            buy1 = float(q.get("buy1") or 0)

            if use_open:
                price = open_p
                if price <= 0:
                    continue
                pct = (
                    round((price - prev) / prev * 100, 2) if prev > 0 else 0.0
                )
                if abs(pct) > 21:
                    continue
                seal = 0.0
                auction_amount = 0.0  # 下面批量回补
            else:
                price = last
                if price <= 0:
                    continue
                # 竞价涨幅必须用撮合价/昨收，不用盘后实时涨幅字段混用
                pct = (
                    round((price - prev) / prev * 100, 2) if prev > 0 else live_pct
                )
                if abs(pct) > 21:
                    continue
                # 触板：现价或买一贴近涨停价（竞价中买一即未匹配买盘）
                at_limit = limit_up > 0 and price > 0 and abs(price - limit_up) <= 0.015
                buy_at_limit = (
                    limit_up > 0 and buy1 > 0 and abs(buy1 - limit_up) <= 0.015
                )
                seal = float(q.get("seal_amount") or 0) if (at_limit or buy_at_limit) else 0.0
                # 竞价中盘口成交额即竞价累计撮合额
                auction_amount = float(q.get("amount") or 0)

            # 竞价一字 = 涨停价撮合 + 未匹配额>0
            at_limit = limit_up > 0 and price > 0 and abs(price - limit_up) <= 0.015
            buy_at_limit = (
                limit_up > 0 and buy1 > 0 and abs(buy1 - limit_up) <= 0.015
            )
            if not (at_limit or buy_at_limit):
                seal = 0.0
            # 一字：价在涨停且有封单；买一也在涨停时即使现价字段抖动仍算
            is_yizhi = bool(
                float(seal or 0) > 0 and (at_limit or (buy_at_limit and pct >= 9.0))
            )
            industry = industry_map.get(code) or ""
            out.append(
                {
                    "code": code,
                    "name": name,
                    "price": price,
                    "last_price": last if last > 0 else price,
                    "auction_pct": pct,
                    "change_pct": live_pct,
                    "amount": auction_amount,
                    "float_mv": float_mv,
                    "seal_amount": seal,
                    "board_count": 1,
                    "industry": industry,
                    "concepts": [industry] if industry else [],
                    "is_yizhi": is_yizhi,
                    "market": str(q.get("market") or ""),
                    "prev_close": prev,
                    "limit_up": limit_up,
                }
            )

        # 盘后：按 |竞价涨幅| 先截断再回补竞价撮合额，避免对全市场打分时接口
        out.sort(
            key=lambda x: (
                1 if x.get("is_yizhi") else 0,
                abs(float(x.get("auction_pct") or 0)),
                float(x.get("float_mv") or 0),
            ),
            reverse=True,
        )
        out = out[:limit]
        if use_open and out:
            # 只回补：全部竞价一字 + |涨幅| Top80，避免盘后接口被 500 次分时拖死
            ranked = sorted(
                out, key=lambda x: abs(float(x.get("auction_pct") or 0)), reverse=True
            )
            need: list[str] = []
            seen_amt: set[str] = set()
            for x in out:
                if x.get("is_yizhi"):
                    c = str(x["code"])
                    if c not in seen_amt:
                        seen_amt.add(c)
                        need.append(c)
            for x in ranked:
                c = str(x["code"])
                if c in seen_amt:
                    continue
                seen_amt.add(c)
                need.append(c)
                if len(need) >= max(80, len([r for r in out if r.get("is_yizhi")]) + 80):
                    break
            amap = await self.fetch_auction_matched_amounts(need, concurrency=24)
            for x in out:
                amt = float(amap.get(str(x["code"]), 0) or 0)
                if amt > 0:
                    x["amount"] = amt

        out.sort(
            key=lambda x: (
                float(x.get("seal_amount") or 0),
                abs(float(x.get("auction_pct") or 0)),
                float(x.get("amount") or 0),
            ),
            reverse=True,
        )
        return out

    async def fetch_speed_rank(self, limit: int = 50) -> list[dict[str, Any]]:
        """A-share intraday speed ranking (东财涨速榜, fid=f22)。

        clist 多节点重试；仍空时用涨幅榜+腾讯盘口估算涨速兜底，避免前端长时间空白。
        """
        limit = max(1, min(100, int(limit or 50)))
        data: dict[str, Any] = {}
        for base in (
            "https://push2.eastmoney.com/api/qt/clist/get",
            "https://82.push2.eastmoney.com/api/qt/clist/get",
            "https://40.push2.eastmoney.com/api/qt/clist/get",
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
        if out:
            return out
        # 东财涨速榜失败：涨幅榜候选 + 腾讯行情，speed 暂用涨跌幅占位，保证有数据可看
        return await self._fetch_speed_rank_fallback(limit)

    async def _fetch_speed_rank_fallback(self, limit: int) -> list[dict[str, Any]]:
        """clist f22 失败时的兜底：新浪涨幅榜 + 腾讯盘口。"""
        try:
            seeds = await self._fetch_auction_rank_codes_sina(each=max(limit, 80))
        except Exception:
            seeds = []
        codes = [c for c, _ in seeds][: max(limit * 2, 80)]
        if not codes:
            return []
        try:
            quotes = await self.fetch_quotes_tencent_batch(codes)
        except Exception:
            quotes = {}
        out: list[dict[str, Any]] = []
        for code in codes:
            q = quotes.get(code)
            if not q:
                continue
            name = str(q.get("name") or code)
            if name.startswith(("N", "C", "n", "c")):
                continue
            pct = float(q.get("change_pct") or 0)
            out.append(
                {
                    "code": code,
                    "name": name,
                    "market": str(q.get("market") or _market_prefix(code)),
                    "price": float(q.get("price") or 0),
                    "change_pct": pct,
                    # 无分钟涨速时用涨跌幅近似，避免整榜空白
                    "speed": pct,
                    "amount": float(q.get("amount") or 0),
                    "volume": float(q.get("volume") or 0),
                    "turnover": 0.0,
                    "total_mv": float(q.get("total_mv") or 0),
                    "float_mv": float(q.get("float_mv") or 0),
                    "industry": "",
                    "concepts": [],
                    "board_count": 1,
                    "open_times": 0,
                }
            )
        out.sort(key=lambda x: float(x.get("speed") or 0), reverse=True)
        return out[:limit]

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
