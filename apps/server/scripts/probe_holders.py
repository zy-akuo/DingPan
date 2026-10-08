import asyncio
from collections import defaultdict

import httpx


async def main():
    async with httpx.AsyncClient(
        timeout=20,
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"},
    ) as c:
        r = await c.get(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            params={
                "reportName": "RPT_F10_EH_HOLDERS",
                "columns": "SECUCODE,END_DATE,HOLDER_RANK,HOLD_NUM_RATIO,HOLDER_NAME",
                "filter": '(SECUCODE="002713.SZ")',
                "pageNumber": "1",
                "pageSize": "100",
                "sortColumns": "END_DATE,HOLDER_RANK",
                "sortTypes": "-1,1",
                "source": "WEB",
                "client": "WEB",
            },
        )
        rows = (r.json().get("result") or {}).get("data") or []
        g = defaultdict(list)
        for x in rows:
            g[x["END_DATE"]].append(x)
        for d, items in list(g.items())[:6]:
            s = sum(float(i.get("HOLD_NUM_RATIO") or 0) for i in items)
            print(d, len(items), round(s, 2))


asyncio.run(main())
