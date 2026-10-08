import asyncio
import json
from pathlib import Path

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36",
    "Referer": "https://data.eastmoney.com/",
}
out = Path(__file__).with_name("probe_radar.json")
code = "600630"  # 龙头股份 from screenshot


async def get(c, url, params=None, referer=None):
    h = dict(HEADERS)
    if referer:
        h["Referer"] = referer
    try:
        r = await c.get(url, params=params, headers=h)
        try:
            data = r.json()
        except Exception:
            return {"url": url, "status": r.status_code, "text": r.text[:400]}
        return {"url": url, "status": r.status_code, "data": data}
    except Exception as e:
        return {"url": url, "error": str(e)}


async def main():
    results = []
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
        # 同花顺涨停揭秘
        results.append(
            await get(
                c,
                "https://data.10jqka.com.cn/public/index.php",
                {"path": "api/limit_up/get_limit_up_pool", "limit": 100},
                "https://data.10jqka.com.cn/",
            )
        )
        results.append(
            await get(
                c,
                f"https://dq.10jqka.com.cn/fuyao/limit_up_ladder_service/stock_limit_up/limit_up_radar/v1/get_limit_up_radar?stock_code={code}",
                None,
                "https://eq.10jqka.com.cn/",
            )
        )
        results.append(
            await get(
                c,
                f"https://eq.10jqka.com.cn/open/api/limit_up_ladder/v1/stock_limit_up_radar?code={code}",
                None,
                "https://eq.10jqka.com.cn/",
            )
        )
        # ths another
        for url in [
            f"https://data.10jqka.com.cn/dataapi/limit_up/limit_up_radar?code={code}",
            f"https://data.10jqka.com.cn/dataapi/limit_up/getStockLimitUp?code={code}",
            f"https://dq.10jqka.com.cn/fuyao/stock_limit_up_service/stock_limit_up/radar/v1/get?stock_code={code}",
        ]:
            results.append(await get(c, url, None, "https://data.10jqka.com.cn/"))
            await asyncio.sleep(0.2)

        # 东财异动/涨停原因
        results.append(
            await get(
                c,
                "https://push2ex.eastmoney.com/getTopicZTPool",
                {
                    "ut": "7eea3edcaed734bea9cbfc24409ed989",
                    "dpt": "wz.ztzt",
                    "Pageindex": "0",
                    "pagesize": "20",
                    "sort": "fbt:asc",
                    "date": "20260918",
                },
            )
        )
        # 涨停原因池
        results.append(
            await get(
                c,
                "https://push2ex.eastmoney.com/getTopicZTPool",
                {
                    "ut": "7eea3edcaed734bea9cbfc24409ed989",
                    "dpt": "wz.ztzt",
                    "Pageindex": "0",
                    "pagesize": "500",
                    "sort": "fbt:asc",
                    "date": "20260918",
                },
            )
        )
        # datacenter limit related
        for report in [
            "RPT_LIMITUP_REASON",
            "RPT_MUTUAL_STOCKLIMIT",
            "RPTA_APP_STOCKLIMIT",
            "RPT_F10_LIMIT_UP",
        ]:
            results.append(
                await get(
                    c,
                    "https://datacenter-web.eastmoney.com/api/data/v1/get",
                    {
                        "reportName": report,
                        "columns": "ALL",
                        "filter": f'(SECURITY_CODE="{code}")',
                        "pageNumber": "1",
                        "pageSize": "20",
                        "source": "WEB",
                        "client": "WEB",
                    },
                )
            )
            await asyncio.sleep(0.15)

        # quote volume f5
        results.append(
            await get(
                c,
                "https://push2.eastmoney.com/api/qt/ulist.np/get",
                {
                    "fltt": "2",
                    "secids": f"1.{code}",
                    "fields": "f2,f3,f5,f6,f8,f12,f14,f20,f21",
                    "ut": "fa5fd1943c7b386f172d6893dbfba10b",
                },
                "https://quote.eastmoney.com/",
            )
        )

    # compact
    compact = []
    for r in results:
        item = {"url": r.get("url"), "status": r.get("status"), "error": r.get("error")}
        d = r.get("data")
        if isinstance(d, dict):
            item["keys"] = list(d.keys())[:20]
            if d.get("data") is not None:
                dd = d["data"]
                if isinstance(dd, dict):
                    item["data_keys"] = list(dd.keys())[:30]
                    if "pool" in dd and isinstance(dd["pool"], list):
                        hit = [x for x in dd["pool"] if str(x.get("c")) == code]
                        item["hit"] = hit[0] if hit else None
                    else:
                        item["sample"] = {k: dd[k] for k in list(dd.keys())[:12]}
                elif isinstance(dd, list) and dd:
                    item["sample"] = dd[0]
            if d.get("result") and isinstance(d["result"], dict):
                rows = d["result"].get("data") or []
                item["result_len"] = len(rows) if isinstance(rows, list) else None
                item["sample"] = rows[0] if rows else None
            if "diff" in str(d.get("data")):
                pass
        compact.append(item)

    out.write_text(json.dumps(compact, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", out)
    for i, x in enumerate(compact):
        print(i, x.get("error") or x.get("status"), (x.get("url") or "")[:70], x.get("result_len"), bool(x.get("hit") or x.get("sample")))


asyncio.run(main())
