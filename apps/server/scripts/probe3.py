import asyncio
import json
from pathlib import Path

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/sz002713.html",
}


async def main():
    async with httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=True) as c:
        r = await c.get(
            "https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax",
            params={"code": "SZ002713"},
        )
        jbzl = r.json().get("jbzl") or []
        row = jbzl[0] if jbzl else {}
        keys_of_interest = [k for k in row.keys() if any(x in k.upper() for x in ("PROV", "CITY", "AREA", "REGION", "ADDRESS", "EM2016", "INDUSTRY"))]
        print(json.dumps({k: row.get(k) for k in keys_of_interest}, ensure_ascii=False, indent=2))

        # quote alternatives
        for url, params in [
            ("https://push2.eastmoney.com/api/qt/ulist.np/get", {"fltt": "2", "secids": "0.002713", "fields": "f2,f12,f14,f20,f21,f84,f85"}),
            ("https://push2delay.eastmoney.com/api/qt/ulist.np/get", {"fltt": "2", "secids": "0.002713", "fields": "f2,f12,f14,f20,f21"}),
            ("https://qt.gtimg.cn/q=sz002713", None),
            ("https://hq.sinajs.cn/list=sz002713", None),
        ]:
            try:
                rr = await c.get(url, params=params, headers={**HEADERS, "Referer": "https://finance.sina.com.cn"})
                text = rr.text[:300] if "sinajs" in url or "gtimg" in url else json.dumps(rr.json(), ensure_ascii=False)[:400]
                print("\n", url, "=>", text)
            except Exception as e:
                print("\n", url, "ERR", e)

        # holders sum latest date
        rr = await c.get(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            params={
                "reportName": "RPT_F10_EH_HOLDERS",
                "columns": "ALL",
                "filter": '(SECUCODE="002713.SZ")',
                "pageNumber": "1",
                "pageSize": "50",
                "sortColumns": "END_DATE,HOLDER_RANK",
                "sortTypes": "-1,1",
                "source": "WEB",
                "client": "WEB",
            },
        )
        rows = ((rr.json().get("result") or {}).get("data")) or []
        if rows:
            end = rows[0]["END_DATE"]
            top = [x for x in rows if x["END_DATE"] == end][:10]
            s = sum(float(x.get("HOLD_NUM_RATIO") or 0) for x in top)
            print("\nTOP10 sum", end, s, len(top))

        # equity free float
        rr = await c.get(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            params={
                "reportName": "RPT_F10_EH_EQUITY",
                "columns": "ALL",
                "filter": '(SECUCODE="002713.SZ")',
                "pageNumber": "1",
                "pageSize": "1",
                "sortColumns": "END_DATE",
                "sortTypes": "-1",
                "source": "WEB",
                "client": "WEB",
            },
        )
        eq = ((rr.json().get("result") or {}).get("data") or [None])[0]
        print("FREELIQCI_SHARES", eq.get("FREELIQCI_SHARES") if eq else None, "UNLIMITED", eq.get("UNLIMITED_SHARES") if eq else None)


asyncio.run(main())
