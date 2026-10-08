import asyncio
import json

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
    "Referer": "https://data.10jqka.com.cn/datacenter/limit_up/",
}
code = "600630"


async def main():
    async with httpx.AsyncClient(timeout=20, headers=HEADERS, follow_redirects=True) as c:
        # richer pool?
        for extra in [
            {},
            {"field": "code,name,change_rate,latest,reason_type,reason_info,limit_up_suc_rate,currency_value,first_limit_up_time,last_limit_up_time,order_amount,order_volume_ratio,high,continue_num,change_tag,is_again_limit"},
        ]:
            params = {
                "filter": "HS,GEM2STAR",
                "order_field": "first_limit_up_time",
                "order_type": "0",
                "limit": "200",
                "page": "1",
                "date": "20260918",
                **extra,
            }
            r = await c.get("https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool", params=params)
            info = (r.json().get("data") or {}).get("info") or []
            hit = next((x for x in info if x.get("code") == code), None)
            print("extra", bool(extra), "fields", list(hit.keys()) if hit else None)
            if hit:
                print(json.dumps(hit, ensure_ascii=False)[:600])

        # block tops reasons map
        r = await c.get(
            "https://data.10jqka.com.cn/dataapi/limit_up/block_top",
            params={"filter": "HS,GEM2STAR", "order_field": "limit_up_num", "order_type": "1", "limit": "50", "page": "1"},
        )
        blocks = r.json().get("data") or []
        reason = None
        for b in blocks:
            for s in b.get("stock_list") or []:
                if s.get("code") == code:
                    reason = {"block": b.get("name"), "reason_type": s.get("reason_type"), "change_tag": s.get("change_tag"), "high": s.get("high"), "change_rate": s.get("change_rate"), "latest": s.get("latest")}
                    break
            if reason:
                break
        print("reason from block_top", json.dumps(reason, ensure_ascii=False))

        # try stock timeline
        for url in [
            f"https://data.10jqka.com.cn/dataapi/limit_up/stock_limit_up_list?code={code}",
            f"https://data.10jqka.com.cn/dataapi/limit_up/limit_up_list?code={code}&filter=HS,GEM2STAR",
            f"https://data.10jqka.com.cn/dataapi/limit_up/year_limit?code={code}",
            f"https://data.10jqka.com.cn/dataapi/limit_up/limit_stats?code={code}",
        ]:
            rr = await c.get(url)
            print(url.split("limit_up/")[-1][:40], rr.status_code, rr.json().get("status_code"), rr.json().get("status_msg"))


asyncio.run(main())
