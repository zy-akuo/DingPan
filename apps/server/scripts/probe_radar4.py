import asyncio
import json
from pathlib import Path

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
    "Referer": "https://data.10jqka.com.cn/datacenter/limit_up/",
}
out = Path(__file__).with_name("probe_radar4.json")


async def main():
    candidates = [
        "https://data.10jqka.com.cn/dataapi/limit_up/limit_pool?filter=HS,GEM2STAR&order_field=first_limit_up_time&order_type=0&limit=100&page=1",
        "https://data.10jqka.com.cn/dataapi/limit_up/up_pool?filter=HS,GEM2STAR&order_field=first_limit_up_time&order_type=0&limit=100&page=1",
        "https://data.10jqka.com.cn/dataapi/limit_up/pool?filter=HS,GEM2STAR&order_field=first_limit_up_time&order_type=0&limit=100&page=1",
        "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool?filter=HS,GEM2STAR&order_field=first_limit_up_time&order_type=0&limit=100&page=1",
        "https://data.10jqka.com.cn/v2/limit_up/limit_up_pool?filter=HS,GEM2STAR&order_field=first_limit_up_time&order_type=0&limit=100&page=1",
        "https://data.10jqka.com.cn/dataapi/limit_up/getLimitUpPool?filter=HS,GEM2STAR&page=1&limit=100",
        # continuous already works - sample fields
        "https://data.10jqka.com.cn/dataapi/limit_up/continuous_limit_pool?filter=HS,GEM2STAR&order_field=continue_num&order_type=1&limit=5&page=1",
        # maybe date based detail
        "https://data.10jqka.com.cn/dataapi/limit_up/limit_detail?filter=HS,GEM2STAR&date=2026-09-18",
        "https://data.10jqka.com.cn/dataapi/limit_up/limit_detail?date=20260918",
        "https://data.10jqka.com.cn/dataapi/limit_up/day_pool?date=2026-09-18&filter=HS,GEM2STAR",
    ]
    rows = []
    async with httpx.AsyncClient(timeout=20, headers=HEADERS, follow_redirects=True) as c:
        for url in candidates:
            try:
                r = await c.get(url)
                data = r.json()
                item = {
                    "url": url,
                    "http": r.status_code,
                    "api": data.get("status_code") if isinstance(data, dict) else None,
                    "msg": data.get("status_msg") if isinstance(data, dict) else None,
                }
                d = data.get("data") if isinstance(data, dict) else None
                if isinstance(d, list) and d:
                    item["len"] = len(d)
                    item["keys"] = list(d[0].keys()) if isinstance(d[0], dict) else None
                    item["sample"] = d[0]
                elif isinstance(d, dict):
                    item["keys"] = list(d.keys())[:30]
                    info = d.get("info") or d.get("list") or d.get("stock_list")
                    if isinstance(info, list) and info:
                        item["len"] = len(info)
                        item["sample"] = info[0]
                rows.append(item)
            except Exception as e:
                rows.append({"url": url, "error": str(e)})
            await asyncio.sleep(0.12)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    for i, x in enumerate(rows):
        print(i, x.get("http"), x.get("api"), x.get("msg"), x.get("len"), x.get("keys"), x["url"].split("limit_up/")[-1][:55])


asyncio.run(main())
