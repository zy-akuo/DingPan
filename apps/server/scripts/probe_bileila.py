"""Probe Kaipanla 避雷啦 (BiLei) endpoints."""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx

HOSTS = [
    ("https://apphis.longhuvip.com/w1/api/index.php", "apphis.longhuvip.com"),
    ("https://apphwhq.longhuvip.com/w1/api/index.php", "apphwhq.longhuvip.com"),
    ("https://apphq.longhuvip.com/w1/api/index.php", "apphq.longhuvip.com"),
    ("https://applhb.longhuvip.com/w1/api/index.php", "applhb.longhuvip.com"),
    ("https://apparticle.longhuvip.com/w1/api/index.php", "apparticle.longhuvip.com"),
    ("https://apphwshhq.longhuvip.com/w1/api/index.php", "apphwshhq.longhuvip.com"),
    ("https://hq.longhuvip.com/w1/api/index.php", "hq.longhuvip.com"),
]

CS = [
    "BiLeiLa",
    "BiLei",
    "HomeBiLei",
    "HisBiLei",
    "BiLeiDingPan",
    "BiLeiHome",
    "RiskAlert",
    "YuJing",
    "Warning",
    "StockWarning",
    "STWarning",
    "TuiShi",
    "Delisting",
    "FuPanLa",
    "HomeDingPan",
    "HisHomeDingPan",
    "APPComplexData",
    "Index",
    "StockRisk",
    "Risk",
    "Thunder",
    "AvoidLei",
    "BLLa",
    "Bileila",
    "Stock",
    "User",
    "HomePage",
    "Complex",
    "News",
    "Article",
]

AS = [
    "GetList",
    "GetWarningList",
    "GetBiLeiList",
    "GetRiskList",
    "GetSTList",
    "GetTuiShiList",
    "GetChangeList",
    "GetNewList",
    "GetHistory",
    "GetDayList",
    "GetTimeline",
    "GetAlertList",
    "GetInfo",
    "GetData",
    "GetStockList",
    "GetWarning",
    "BiLeiList",
    "GetBLList",
    "GetLatest",
    "GetRemoveList",
    "GetAddList",
    "DailyBiLei",
    "GetBiLeiLaList",
    "GetBiLeiInfo",
    "GetRiskInfo",
    "GetYuJingList",
    "GetBiLeiLa",
    "GetRiskTag",
    "GetRiskTags",
    "GetStockRisk",
    "GetRiskStockList",
    "GetWarningChange",
    "GetWarningDay",
    "GetDayChange",
]


def _interesting(j: dict[str, Any]) -> bool:
    err = str(j.get("errcode", j.get("err", j.get("ErrorCode", ""))))
    if err in ("0", "0.0"):
        for k in ("list", "List", "info", "Info", "data", "Data", "tt", "TT", "Day", "days"):
            v = j.get(k)
            if v not in (None, "", [], {}, 0, "0"):
                return True
        # errcode 0 with other non-empty payload
        skip = {"errcode", "err", "ErrorCode", "t", "Time", "time"}
        for k, v in j.items():
            if k in skip:
                continue
            if v not in (None, "", [], {}, 0, "0"):
                return True
    for k in ("list", "List", "info", "Info"):
        v = j.get(k)
        if isinstance(v, list) and len(v) > 0:
            return True
        if isinstance(v, dict) and v:
            return True
    return False


async def try_one(
    client: httpx.AsyncClient,
    url: str,
    host: str,
    a: str,
    c: str,
    extra: dict[str, Any] | None = None,
) -> str | None:
    data: dict[str, Any] = {
        "PhoneOSNew": "1",
        "DeviceID": str(uuid.uuid4()),
        "VerSion": "5.21.0.2",
        "apiv": "w42",
        "a": a,
        "c": c,
        "Type": "0",
        "Index": "0",
        "st": "100",
        "Order": "0",
    }
    if extra:
        data.update(extra)
    headers = {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": (
            "Dalvik/2.1.0 (Linux; U; Android 9; SHARK PRS-A0 Build/PQ3A.190605.01141736)"
        ),
        "Host": host,
        "Accept-Encoding": "gzip",
    }
    try:
        r = await client.post(url, data=data, headers=headers)
        j = r.json()
        if not isinstance(j, dict) or not _interesting(j):
            return None
        preview = json.dumps(j, ensure_ascii=False)[:500]
        keys = list(j.keys())[:15]
        return f"HIT host={host} a={a} c={c} keys={keys} preview={preview}"
    except Exception:
        return None


async def main() -> None:
    hits: list[str] = []
    # focused first: BiLei* controllers
    focus_c = [c for c in CS if "BiLei" in c or "Lei" in c or "Risk" in c or "YuJing" in c or "Warning" in c or "TuiShi" in c]
    focus_a = AS[:20]
    async with httpx.AsyncClient(timeout=12, verify=False, follow_redirects=True) as client:
        tasks = []
        for url, host in HOSTS:
            for c in focus_c:
                for a in focus_a:
                    tasks.append(try_one(client, url, host, a, c))
                    # Type variants for latest/st/delist
                    for t in ("1", "2", "3"):
                        tasks.append(try_one(client, url, host, a, c, {"Type": t}))
        print(f"phase1 tasks={len(tasks)}")
        for i in range(0, len(tasks), 50):
            batch = tasks[i : i + 50]
            results = await asyncio.gather(*batch)
            for r in results:
                if r:
                    hits.append(r)
                    print(r)
            print(f"  done {min(i + 50, len(tasks))}/{len(tasks)} hits={len(hits)}")

        # phase2: broader if few hits
        if len(hits) < 3:
            tasks2 = []
            for url, host in HOSTS[:4]:
                for c in CS:
                    for a in ["GetList", "GetInfo", "GetData", "GetBiLeiList", "GetWarningList"]:
                        tasks2.append(try_one(client, url, host, a, c))
            print(f"phase2 tasks={len(tasks2)}")
            for i in range(0, len(tasks2), 50):
                batch = tasks2[i : i + 50]
                results = await asyncio.gather(*batch)
                for r in results:
                    if r and r not in hits:
                        hits.append(r)
                        print(r)
                print(f"  done {min(i + 50, len(tasks2))}/{len(tasks2)} hits={len(hits)}")

    print("=== TOTAL HITS", len(hits))
    out = "e:/个人/DingPan/apps/server/scripts/_bileila_hits.txt"
    with open(out, "w", encoding="utf-8") as f:
        for h in hits:
            f.write(h + "\n")
    print("wrote", out)


if __name__ == "__main__":
    asyncio.run(main())
