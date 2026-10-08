import asyncio
import json

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
    "Referer": "https://data.10jqka.com.cn/datacenter/limit_up/",
}


async def main():
    async with httpx.AsyncClient(timeout=20, headers=HEADERS, follow_redirects=True) as c:
        r = await c.get(
            "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool",
            params={
                "filter": "HS,GEM2STAR",
                "order_field": "first_limit_up_time",
                "order_type": "0",
                "limit": "200",
                "page": "1",
            },
        )
        data = r.json()["data"]
        info = data.get("info") or []
        print("date", data.get("date"), "count", len(info), "limit_up_count", data.get("limit_up_count"))
        if info:
            print("fields", list(info[0].keys()))
            print(json.dumps(info[0], ensure_ascii=False, indent=2)[:1500])
        hit = next((x for x in info if x.get("code") == "600630"), None)
        print("hit 600630", json.dumps(hit, ensure_ascii=False)[:800] if hit else None)

        # try date history pool
        for date in ["2026-09-18", "20260918", "2026-09-17"]:
            rr = await c.get(
                "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool",
                params={
                    "filter": "HS,GEM2STAR",
                    "order_field": "first_limit_up_time",
                    "order_type": "0",
                    "limit": "50",
                    "page": "1",
                    "date": date,
                },
            )
            dd = rr.json()
            d2 = dd.get("data") or {}
            print("date param", date, "api", dd.get("status_code"), "resp_date", d2.get("date") if isinstance(d2, dict) else None, "n", len(d2.get("info") or []) if isinstance(d2, dict) else None)


asyncio.run(main())
