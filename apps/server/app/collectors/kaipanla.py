from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from typing import Any

import httpx


def _day_label(date: str) -> str:
    """Normalize to YYYY-MM-DD required by Kaipanla history APIs."""
    raw = (date or "").replace("-", "").strip()
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
    if len(date or "") == 10 and date[4] == "-" and date[7] == "-":
        return date
    return datetime.now().strftime("%Y-%m-%d")


def _ts_to_hm(ts: Any) -> str:
    try:
        n = int(ts)
    except (TypeError, ValueError):
        return ""
    if n <= 0:
        return ""
    # Kaipanla uses unix seconds
    if n > 10_000_000_000:
        n //= 1000
    try:
        return datetime.fromtimestamp(n).strftime("%H:%M")
    except (OSError, OverflowError, ValueError):
        return ""


def _f(v: Any, default: float = 0.0) -> float:
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _i(v: Any, default: int = 0) -> int:
    try:
        if v is None or v == "":
            return default
        return int(v)
    except (TypeError, ValueError):
        return default


def _parse_stock_row(row: list[Any], board: int) -> dict[str, Any] | None:
    """Parse DailyLimitPerformance stock array."""
    if not isinstance(row, list) or len(row) < 16:
        return None
    code = str(row[0] or "").zfill(6)
    if not code.isdigit():
        return None
    reason = str(row[5] or "").strip()
    concepts_raw = str(row[12] or "").strip()
    concepts = [c.strip() for c in concepts_raw.replace("，", "、").split("、") if c.strip()]
    if reason and reason not in concepts:
        concepts = [reason] + concepts
    board_count = _i(row[15], board) or board
    tip = str(row[18] or "").strip() if len(row) > 18 else ""
    return {
        "code": code,
        "name": str(row[1] or code),
        "market": "沪" if code.startswith("6") else ("科" if code.startswith("688") else ("创" if code.startswith(("300", "301")) else "深")),
        "price": _f(row[21]) if len(row) > 21 else 0.0,
        "change_pct": _f(row[22]) if len(row) > 22 else _f(row[17] if len(row) > 17 else 0),
        "amount": _f(row[6]),
        "volume": 0.0,
        "float_mv": _f(row[7]),
        "total_mv": _f(row[13]),
        "turnover": _f(row[14]),
        "seal_amount": _f(row[11]),
        "first_seal_time": _ts_to_hm(row[4]),
        "last_seal_time": "",
        "board_count": board_count,
        "open_times": _i(row[16]),
        "industry": reason,
        "concepts": concepts[:8],
        "zt_stats": tip or (f"{board_count}连板" if board_count > 1 else "首板"),
        "reason": reason or concepts_raw,
        "board_shape": tip,
        "sector_code": str(row[19] or "") if len(row) > 19 else "",
    }


class KaipanlaClient:
    """开盘啦（longhuvip）历史/实时涨停数据。"""

    HIST_URL = "https://apphis.longhuvip.com/w1/api/index.php"
    LIVE_URL = "https://apphwhq.longhuvip.com/w1/api/index.php"

    def __init__(self, timeout: float = 20.0) -> None:
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def _ensure(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self._timeout,
                follow_redirects=True,
                verify=False,
                limits=httpx.Limits(max_connections=12, max_keepalive_connections=6),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def _post(self, url: str, host: str, payload: dict[str, Any]) -> dict[str, Any]:
        client = await self._ensure()
        data = {
            "PhoneOSNew": "1",
            "DeviceID": str(uuid.uuid4()),
            "VerSion": "5.21.0.2",
            "apiv": "w42",
            **payload,
        }
        headers = {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": (
                "Dalvik/2.1.0 (Linux; U; Android 9; SHARK PRS-A0 "
                "Build/PQ3A.190605.01141736)"
            ),
            "Host": host,
            "Accept-Encoding": "gzip",
            "Connection": "Keep-Alive",
        }
        resp = await client.post(url, data=data, headers=headers)
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _is_recent_calendar_date(date: str, within_days: int = 4) -> bool:
        """近期日历日：历史库可能尚未入库，需尝试实时接口。"""
        day = _day_label(date)
        try:
            d = datetime.strptime(day, "%Y-%m-%d").date()
        except ValueError:
            return True
        return abs((datetime.now().date() - d).days) <= within_days

    async def fetch_board_level(
        self,
        date: str,
        pid_type: int,
        *,
        source: str = "hist",
    ) -> list[dict[str, Any]]:
        """PidType: 1=首板, 2=2连板, ...

        source=hist → 历史库 HisHomeDingPan（按日准确，当日盘后可能尚未入库）
        source=live → 实时库 HomeDingPan（约 15:05 起有当日复盘，Day 参数无效、始终最新交易日）
        """
        day = _day_label(date)
        if source == "live":
            url, host, ctrl = self.LIVE_URL, "apphwhq.longhuvip.com", "HomeDingPan"
            payload = {
                "a": "DailyLimitPerformance",
                "c": ctrl,
                "Order": "0",
                "st": "2000",
                "Index": "0",
                "PidType": str(pid_type),
                "Type": "4",
            }
        else:
            url, host, ctrl = self.HIST_URL, "apphis.longhuvip.com", "HisHomeDingPan"
            payload = {
                "a": "DailyLimitPerformance",
                "c": ctrl,
                "Order": "0",
                "st": "2000",
                "Index": "0",
                "PidType": str(pid_type),
                "Type": "4",
                "Day": day,
            }
        try:
            raw = await self._post(url, host, payload)
        except Exception:
            return []
        if str(raw.get("errcode")) not in ("0", "0.0"):
            return []
        info = raw.get("info") or []
        if not isinstance(info, list) or not info:
            return []
        rows = info[0] if isinstance(info[0], list) else []
        out: list[dict[str, Any]] = []
        for row in rows:
            parsed = _parse_stock_row(row, pid_type)
            if parsed:
                out.append(parsed)
        return out

    async def _assemble_limit_ladder(
        self,
        date: str,
        max_board: int,
        source: str,
    ) -> dict[str, Any]:
        day = _day_label(date)
        tasks = [
            self.fetch_board_level(day, pid, source=source)
            for pid in range(1, max_board + 1)
        ]
        results = await asyncio.gather(*tasks)

        ladder: dict[int, list[dict[str, Any]]] = {}
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        empty_streak = 0
        for pid, rows in enumerate(results, start=1):
            if not rows:
                empty_streak += 1
                if pid >= 4 and empty_streak >= 2:
                    break
                continue
            empty_streak = 0
            ladder[pid] = rows
            for r in rows:
                if r["code"] in seen:
                    continue
                seen.add(r["code"])
                items.append(r)

        concept_map: dict[str, list[dict[str, Any]]] = {}
        for s in items:
            key = (s.get("reason") or s.get("industry") or "其他").strip() or "其他"
            concept_map.setdefault(key, []).append(s)

        concept_groups: list[dict[str, Any]] = []
        for name, stocks in concept_map.items():
            amount = sum(float(x.get("amount") or 0) for x in stocks)
            avg_chg = (
                round(sum(float(x.get("change_pct") or 0) for x in stocks) / len(stocks), 2)
                if stocks
                else 0.0
            )
            concept_groups.append(
                {
                    "key": f"concept-{name}",
                    "label": name,
                    "count": len(stocks),
                    "amount": amount,
                    "avg_change_pct": avg_chg,
                    "stocks": stocks,
                }
            )
        concept_groups.sort(key=lambda g: (-g["count"], -g["amount"], g["label"]))

        board_groups: list[dict[str, Any]] = []
        for bc in sorted(ladder.keys(), reverse=True):
            stocks = ladder[bc]
            avg_chg = (
                round(sum(float(x.get("change_pct") or 0) for x in stocks) / len(stocks), 2)
                if stocks
                else 0.0
            )
            label = "首板" if bc <= 1 else f"{bc}连板"
            board_groups.append(
                {
                    "key": f"board-{bc}",
                    "label": label,
                    "board_count": bc,
                    "count": len(stocks),
                    "avg_change_pct": avg_chg,
                    "stocks": stocks,
                }
            )

        # 情绪统计仅历史库有；实时源时仍尽量按日取 hist
        expr = await self.fetch_expression(day)
        zt_count = len(items)

        return {
            "date": day.replace("-", ""),
            "date_label": day,
            "count": zt_count,
            "zt_count": zt_count,
            "dt_count": int(expr.get("dt_count") or 0),
            "expression": expr,
            "items": items,
            "board_groups": board_groups,
            "concept_groups": concept_groups,
            "source": "kaipanla_live" if source == "live" else "kaipanla",
        }

    async def fetch_limit_ladder(self, date: str, max_board: int = 12) -> dict[str, Any]:
        """Fetch all board levels for a day. Returns ladder + flat items + concept groups.

        开盘啦官方：个股/板块复盘约 15:05 更新。历史库 HisHomeDingPan 当日常延后入库
        （周末/节假请求日历日会 err）；近期日期历史为空时回退实时 HomeDingPan。
        注意：实时接口忽略 Day，始终返回最新交易日，仅可在近期日期上作为回退。
        """
        hist = await self._assemble_limit_ladder(date, max_board, "hist")
        if int(hist.get("count") or 0) > 0:
            return hist
        if self._is_recent_calendar_date(date):
            live = await self._assemble_limit_ladder(date, max_board, "live")
            if int(live.get("count") or 0) > 0:
                return live
        return hist

    async def fetch_expression(self, date: str) -> dict[str, Any]:
        day = _day_label(date)
        try:
            raw = await self._post(
                self.HIST_URL,
                "apphis.longhuvip.com",
                {"a": "ZhangTingExpression", "c": "HisHomeDingPan", "Day": day},
            )
        except Exception:
            return {}
        info = raw.get("info") or []
        if not isinstance(info, list) or len(info) < 4:
            return {}
        # [首板, 2连, 3连, 4连以上, 连板率?, ...]
        return {
            "first": _i(info[0]),
            "board2": _i(info[1]),
            "board3": _i(info[2]),
            "board4_plus": _i(info[3]),
            "raw": info,
        }

    async def fetch_bileila(self, risk_type: int = 0) -> dict[str, Any] | None:
        """开盘啦避雷啦（若官方接口可用则返回原始结构）。

        公开渠道暂无稳定 a/c；探测失败时返回 None，由上层回退东财风险警示板。
        risk_type: 0=最新, 1=ST, 2=退市（约定，待抓包确认）。
        """
        hosts = [
            (self.LIVE_URL, "apphwhq.longhuvip.com"),
            (self.HIST_URL, "apphis.longhuvip.com"),
            ("https://apphq.longhuvip.com/w1/api/index.php", "apphq.longhuvip.com"),
        ]
        # 候选参数：抓到真实接口后优先替换为单一组合
        candidates = [
            {"a": "GetList", "c": "BiLeiLa", "Type": str(risk_type)},
            {"a": "GetDayList", "c": "BiLeiLa", "Type": str(risk_type)},
            {"a": "GetChangeList", "c": "BiLeiLa", "Type": str(risk_type)},
            {"a": "GetBiLeiList", "c": "HomeDingPan", "Type": str(risk_type)},
        ]
        for url, host in hosts:
            for payload in candidates:
                try:
                    raw = await self._post(url, host, payload)
                except Exception:
                    continue
                if str(raw.get("errcode")) not in ("0", "0.0"):
                    continue
                # 需含列表类字段才算命中
                for key in ("list", "List", "info", "Info", "DayList", "Add", "Remove"):
                    val = raw.get(key)
                    if val not in (None, "", [], {}):
                        return {"host": host, "payload": payload, "raw": raw}
        return None
