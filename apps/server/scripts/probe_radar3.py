import asyncio
import json
from pathlib import Path

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
    "Referer": "https://data.10jqka.com.cn/",
}
code = "600630"
out = Path(__file__).with_name("probe_radar3.json")


async def main():
    urls = [
        f"https://data.10jqka.com.cn/dataapi/limit_up/limit_detail?filter=HS,GEM2STAR&date=&stock_code={code}",
        f"https://data.10jqka.com.cn/dataapi/limit_up/stock_pool?filter=HS,GEM2STAR&order_field=first_limit_up_time&order_type=0&limit=200&page=1",
        f"https://data.10jqka.com.cn/dataapi/limit_up/lower_limit_pool?filter=HS,GEM2STAR&order_field=first_limit_up_time&order_type=0&limit=50&page=1",
        f"https://data.10jqka.com.cn/dataapi/limit_up/explosion_pool?filter=HS,GEM2STAR&order_field=first_limit_up_time&order_type=0&limit=50&page=1",
        f"https://data.10jqka.com.cn/dataapi/limit_up/continuous_limit_pool?filter=HS,GEM2STAR&order_field=continue_num&order_type=1&limit=50&page=1",
        f"https://data.10jqka.com.cn/dataapi/limit_up/get_calendar?filter=HS,GEM2STAR&stock={code}",
        f"https://data.10jqka.com.cn/dataapi/limit_up/history?filter=HS,GEM2STAR&code={code}",
        f"https://data.10jqka.com.cn/dataapi/limit_up/limit_list?filter=HS,GEM2STAR&code={code}",
        f"https://data.10jqka.com.cn/dataapi/limit_up/stock_limit_up?filter=HS,GEM2STAR&code={code}",
        f"https://data.10jqka.com.cn/dataapi/limit_up/gene?code={code}",
        f"https://data.10jqka.com.cn/dataapi/limit_up/radar?code={code}",
        f"https://data.10jqka.com.cn/dataapi/limit_up/get_stock_info?code={code}",
    ]
    rows = []
    async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=HEADERS) as c:
        for url in urls:
            try:
                r = await c.get(url)
                try:
                    data = r.json()
                except Exception:
                    data = {"raw": r.text[:300]}
                item = {"url": url, "status": r.status_code}
                if isinstance(data, dict):
                    item["status_code"] = data.get("status_code")
                    item["status_msg"] = data.get("status_msg")
                    d = data.get("data")
                    if isinstance(d, dict):
                        item["data_keys"] = list(d.keys())[:40]
                        item["sample"] = {k: d[k] for k in list(d.keys())[:20]}
                    elif isinstance(d, list):
                        item["len"] = len(d)
                        item["sample"] = d[0] if d else None
                        # find code
                        hit = next((x for x in d if isinstance(x, dict) and str(x.get("code")) == code), None)
                        item["hit"] = hit
                    else:
                        item["data"] = d
                rows.append(item)
            except Exception as e:
                rows.append({"url": url, "error": str(e)})
            await asyncio.sleep(0.15)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    for i, x in enumerate(rows):
        print(i, x.get("status"), x.get("status_code"), x.get("status_msg"), bool(x.get("sample") or x.get("hit")), x["url"].split("limit_up/")[-1][:50])


asyncio.run(main())
