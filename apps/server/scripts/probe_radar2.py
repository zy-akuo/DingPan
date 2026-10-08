import asyncio
import json
from pathlib import Path

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    "Referer": "https://eq.10jqka.com.cn/",
}
code = "600630"
out = Path(__file__).with_name("probe_radar2.json")


async def try_urls(c, urls):
    rows = []
    for url in urls:
        try:
            r = await c.get(url, headers=HEADERS, follow_redirects=True, timeout=15)
            text = r.text[:500]
            try:
                data = r.json()
            except Exception:
                data = None
            rows.append({"url": url, "status": r.status_code, "data": data, "text": text if data is None else None})
        except Exception as e:
            rows.append({"url": url, "error": str(e)})
        await asyncio.sleep(0.2)
    return rows


async def main():
    urls = [
        f"https://data.10jqka.com.cn/dataapi/limit_up/block_top?filter=HS,GEM2STAR&order_field=limit_up_type&order_type=0&limit=200&page=1",
        f"https://data.10jqka.com.cn/dataapi/limit_up/getInfo?stock_code={code}",
        f"https://data.10jqka.com.cn/dataapi/limit_up/stock_detail?filter=HS,GEM2STAR&code={code}",
        f"https://dq.10jqka.com.cn/fuyao/limit_up_pool_service/stock_limit_up/radar/v1/get?stock_code={code}",
        f"https://dq.10jqka.com.cn/fuyao/limit_up_pool_service/limit_up_radar/v1/get?stock_code={code}",
        f"https://eq.10jqka.com.cn/open/api/limit_up_ladder_service/stock_limit_up/limit_up_radar/v1/get_limit_up_radar?stock_code={code}",
        f"https://eq.10jqka.com.cn/open/api/limit_up_ladder_service/v1/limit_up_radar?code={code}",
        # eastmoney stock changes
        f"https://push2ex.eastmoney.com/getStockChanges?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wzchanges&pageindex=0&pagesize=50&types=8201,8202&code={code}",
        f"https://push2ex.eastmoney.com/getAllStockChanges?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wzchanges&pageindex=0&pagesize=20&date=20260918",
        # 开盘啦风格
        f"https://apphwhq.longhuvip.com/w1/api/index.php?Order=0&a=GetPlateInfo&st=30&c=ZhiShuL2Data&PhoneOSNew=1&DeviceID=x&VerSion=192.168.0.2&Index=0&apiv=w31&Type=3&Filter=0",
    ]
    async with httpx.AsyncClient() as c:
        rows = await try_urls(c, urls)
        # quote volume via tencent
        r = await c.get(f"https://qt.gtimg.cn/q=sh{code}", headers={"User-Agent": "Mozilla/5.0"})
        rows.append({"url": "tencent", "text": r.text[:250]})

    compact = []
    for r in rows:
        item = {k: r.get(k) for k in ("url", "status", "error", "text")}
        d = r.get("data")
        if isinstance(d, dict):
            item["keys"] = list(d.keys())[:25]
            # dive
            for key in ("data", "result", "stock_list", "info", "status_code"):
                if key in d:
                    v = d[key]
                    if isinstance(v, dict):
                        item[key + "_keys"] = list(v.keys())[:30]
                        item[key + "_sample"] = {kk: v[kk] for kk in list(v.keys())[:15]}
                    elif isinstance(v, list) and v:
                        item[key + "_len"] = len(v)
                        item[key + "_sample"] = v[0]
                    else:
                        item[key] = v
        compact.append(item)
    out.write_text(json.dumps(compact, ensure_ascii=False, indent=2), encoding="utf-8")
    print("done")
    for i, x in enumerate(compact):
        print(i, x.get("status") or x.get("error"), (x.get("url") or "")[:75])


asyncio.run(main())
