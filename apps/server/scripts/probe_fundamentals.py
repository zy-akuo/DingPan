import asyncio
import json
from pathlib import Path

import httpx

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    "Referer": "https://data.eastmoney.com/",
}
code = "002713"
out = Path(__file__).with_name("probe_out.json")


async def safe_get(client, url, params=None):
    try:
        r = await client.get(url, params=params)
        try:
            data = r.json()
        except Exception:
            return {"url": url, "status": r.status_code, "text": r.text[:500]}
        summary = {"url": url, "status": r.status_code}
        if isinstance(data, dict):
            summary["keys"] = list(data.keys())
            detail = {}
            for k, v in data.items():
                if isinstance(v, list):
                    detail[k] = {"len": len(v), "sample": v[0] if v else None}
                elif isinstance(v, dict):
                    # truncate big dicts
                    if "data" in v and isinstance(v["data"], dict):
                        detail[k] = {
                            "keys": list(v.keys()),
                            "data_keys": list(v["data"].keys())[:40],
                            "data_sample": {kk: v["data"][kk] for kk in list(v["data"].keys())[:25]},
                        }
                    elif "data" in v and isinstance(v["data"], list):
                        detail[k] = {
                            "keys": list(v.keys()),
                            "data_len": len(v["data"]),
                            "sample": v["data"][0] if v["data"] else None,
                        }
                    else:
                        detail[k] = {"keys": list(v.keys())[:40], "sample": {kk: v[kk] for kk in list(v.keys())[:20]}}
                else:
                    detail[k] = v
            summary["detail"] = detail
        else:
            summary["data"] = data
        return summary
    except Exception as e:
        return {"url": url, "error": str(e)}


async def main():
    results = []
    async with httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=True) as c:
        # 1 realtime quote
        results.append(
            await safe_get(
                c,
                "https://push2.eastmoney.com/api/qt/stock/get",
                {
                    "secid": "0.002713",
                    "fields": "f43,f57,f58,f116,f117,f162,f167,f168,f169,f170,f46,f44,f45,f47,f48,f60,f71,f50,f86,f127,f172,f152,f84,f85,f189,f20,f21",
                    "ut": "fa5fd1943c7b386f172d6893dbfba10b",
                    "fltt": "2",
                    "invt": "2",
                },
            )
        )
        await asyncio.sleep(0.3)
        # 2 company survey
        results.append(
            await safe_get(
                c,
                "https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax",
                {"code": code},
            )
        )
        await asyncio.sleep(0.3)
        # 3 shareholders
        results.append(
            await safe_get(
                c,
                "https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax",
                {"code": code},
            )
        )
        await asyncio.sleep(0.3)
        # 4 concepts
        results.append(
            await safe_get(
                c,
                "https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax",
                {"code": code},
            )
        )
        await asyncio.sleep(0.3)
        # 5 datacenter top10 holders
        results.append(
            await safe_get(
                c,
                "https://datacenter-web.eastmoney.com/api/data/v1/get",
                {
                    "reportName": "RPT_F10_EH_HOLDERS",
                    "columns": "ALL",
                    "filter": '(SECUCODE="002713.SZ")',
                    "pageNumber": "1",
                    "pageSize": "20",
                    "sortColumns": "END_DATE,HOLDER_RANK",
                    "sortTypes": "-1,1",
                    "source": "WEB",
                    "client": "WEB",
                },
            )
        )
        await asyncio.sleep(0.3)
        # 6 free holders
        results.append(
            await safe_get(
                c,
                "https://datacenter-web.eastmoney.com/api/data/v1/get",
                {
                    "reportName": "RPT_F10_EH_FREEHOLDERS",
                    "columns": "ALL",
                    "filter": '(SECUCODE="002713.SZ")',
                    "pageNumber": "1",
                    "pageSize": "20",
                    "sortColumns": "END_DATE,HOLDER_RANK",
                    "sortTypes": "-1,1",
                    "source": "WEB",
                    "client": "WEB",
                },
            )
        )
        await asyncio.sleep(0.3)
        # 7 capital structure / free float shares
        results.append(
            await safe_get(
                c,
                "https://datacenter-web.eastmoney.com/api/data/v1/get",
                {
                    "reportName": "RPT_F10_EH_EQUITY",
                    "columns": "ALL",
                    "filter": '(SECUCODE="002713.SZ")',
                    "pageNumber": "1",
                    "pageSize": "5",
                    "sortColumns": "END_DATE",
                    "sortTypes": "-1",
                    "source": "WEB",
                    "client": "WEB",
                },
            )
        )
        await asyncio.sleep(0.3)
        # 8 board list for concepts via stock boards
        results.append(
            await safe_get(
                c,
                "https://push2.eastmoney.com/api/qt/slist/get",
                {
                    "spt": "3",
                    "pi": "0",
                    "pz": "50",
                    "po": "1",
                    "np": "1",
                    "fltt": "2",
                    "invt": "2",
                    "secid": "0.002713",
                    "fields": "f12,f14",
                    "ut": "fa5fd1943c7b386f172d6893dbfba10b",
                },
            )
        )

    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", out, "items", len(results))
    for i, r in enumerate(results):
        print(i, r.get("url", "")[:70], "err" if "error" in r else r.get("status"), r.get("keys") or r.get("error"))


if __name__ == "__main__":
    asyncio.run(main())
