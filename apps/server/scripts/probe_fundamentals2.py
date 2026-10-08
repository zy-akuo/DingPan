import asyncio
import json
from pathlib import Path

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
}
out = Path(__file__).with_name("probe_out2.json")


async def safe_get(client, url, params=None):
    try:
        r = await client.get(url, params=params)
        data = r.json()
        return {"url": url, "status": r.status_code, "data": data}
    except Exception as e:
        return {"url": url, "error": str(e)}


async def main():
    results = []
    async with httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=True) as c:
        for code in ["SZ002713", "002713.SZ", "0.002713"]:
            results.append(
                await safe_get(
                    c,
                    "https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax",
                    {"code": code if not code.startswith("0.") else "SZ002713"},
                )
            )
            await asyncio.sleep(0.2)

        # quote via qt.gtimg / sina / eastmoney alternative
        results.append(
            await safe_get(
                c,
                "https://push2delay.eastmoney.com/api/qt/stock/get",
                {
                    "secid": "0.002713",
                    "fields": "f43,f57,f58,f116,f117,f20,f21,f84,f85",
                    "ut": "fa5fd1943c7b386f172d6893dbfba10b",
                    "fltt": "2",
                },
            )
        )
        await asyncio.sleep(0.2)
        results.append(
            await safe_get(
                c,
                "https://82.push2.eastmoney.com/api/qt/stock/get",
                {
                    "secid": "0.002713",
                    "fields": "f43,f57,f58,f116,f117,f20,f21,f84,f85",
                    "ut": "fa5fd1943c7b386f172d6893dbfba10b",
                    "fltt": "2",
                },
            )
        )
        await asyncio.sleep(0.2)
        # concepts via board
        results.append(
            await safe_get(
                c,
                "https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax",
                {"code": "SZ002713"},
            )
        )
        await asyncio.sleep(0.2)
        results.append(
            await safe_get(
                c,
                "https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax",
                {"code": "SZ002713"},
            )
        )
        await asyncio.sleep(0.2)
        # industry/region from company
        # free float mv calc: free_shares * price
        # also try RPT_DMSK_TS_STOCKBASIC or similar
        results.append(
            await safe_get(
                c,
                "https://datacenter-web.eastmoney.com/api/data/v1/get",
                {
                    "reportName": "RPT_F10_INFO_ORGPROFILE",
                    "columns": "ALL",
                    "filter": '(SECUCODE="002713.SZ")',
                    "pageNumber": "1",
                    "pageSize": "1",
                    "source": "WEB",
                    "client": "WEB",
                },
            )
        )
        await asyncio.sleep(0.2)
        results.append(
            await safe_get(
                c,
                "https://datacenter-web.eastmoney.com/api/data/v1/get",
                {
                    "reportName": "RPT_F10_INFO_SECURITY",
                    "columns": "ALL",
                    "filter": '(SECUCODE="002713.SZ")',
                    "pageNumber": "1",
                    "pageSize": "1",
                    "source": "WEB",
                    "client": "WEB",
                },
            )
        )

    # compact write
    compact = []
    for r in results:
        if "error" in r:
            compact.append(r)
            continue
        data = r.get("data")
        item = {"url": r["url"], "status": r["status"]}
        if isinstance(data, dict):
            item["keys"] = list(data.keys())
            if data.get("status") == -1:
                item["message"] = data.get("message")
            elif "result" in data and isinstance(data["result"], dict):
                rows = data["result"].get("data") or []
                item["sample"] = rows[0] if rows else None
            else:
                # dump small
                item["preview"] = {k: (v if not isinstance(v, (list, dict)) else (f"list[{len(v)}]" if isinstance(v, list) else list(v.keys())[:15])) for k, v in list(data.items())[:20]}
                for k in ("jbzl", "zxzb", "ssbk", "hxtc", "sdgd", "gdrs", "data"):
                    if k in data:
                        v = data[k]
                        if isinstance(v, list) and v:
                            item[k + "_sample"] = v[0]
                        elif isinstance(v, dict):
                            item[k] = v
        compact.append(item)

    out.write_text(json.dumps(compact, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", out)
    for i, x in enumerate(compact):
        print(i, x.get("message") or x.get("error") or list(x.keys()))


if __name__ == "__main__":
    asyncio.run(main())
