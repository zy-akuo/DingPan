"""Audit 涨停基因: local radar vs EM limit-up history vs THS probe APIs."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import httpx

from app.collectors.eastmoney import EastMoneyClient
from app.collectors.ths import ThsClient, _limit_threshold, build_stock_radar

CODES = ["600630", "600825", "000564", "300059", "002261"]  # 龙头/新华传媒/供销大集/东方财富/北方长龙
THS_UA = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
    "Referer": "https://data.10jqka.com.cn/",
}


def recompute_from_bars(bars: list[dict], code: str) -> dict:
    thr = _limit_threshold(code)
    zt, dt = [], []
    for i, b in enumerate(bars):
        pct = float(b.get("pct") or 0)
        if abs(pct) < 1e-6 and i > 0:
            prev = float(bars[i - 1].get("close") or 0)
            cur = float(b.get("close") or 0)
            if prev:
                pct = (cur - prev) / prev * 100
        high = float(b.get("high") or 0)
        close = float(b.get("close") or 0)
        sealed = high > 0 and abs(close - high) / high < 0.002  # 收盘贴近最高
        if pct >= thr:
            zt.append((i, sealed, pct))
        elif pct <= -thr:
            dt.append((i, pct))

    premium5 = next_red = consecutive = next_n = 0
    # 口径A: max(开,收)/昨涨停收 >=5% （当前实现）
    # 口径B: 次日收盘溢价 >=5% （部分平台用收盘）
    prem_close5 = 0
    for i, _, _ in zt:
        if i + 1 >= len(bars):
            continue
        next_n += 1
        cur = float(bars[i].get("close") or 0)
        nxt = bars[i + 1]
        nxt_c = float(nxt.get("close") or 0)
        nxt_o = float(nxt.get("open") or nxt_c)
        if cur > 0:
            if max(nxt_o, nxt_c) / cur - 1 >= 0.05:
                premium5 += 1
            if nxt_c / cur - 1 >= 0.05:
                prem_close5 += 1
        if nxt_c >= cur:
            next_red += 1
        if any(j == i + 1 for j, _, _ in zt):
            consecutive += 1

    sealed_n = sum(1 for _, s, _ in zt if s)
    return {
        "thr": thr,
        "zt_days": len(zt),
        "zt_sealed_close_eq_high": sealed_n,
        "dt_days": len(dt),
        "premium5_max_oc": premium5,
        "premium5_close_only": prem_close5,
        "next_red_rate": round(next_red / next_n * 100, 2) if next_n else None,
        "board_rate": round(consecutive / next_n * 100, 2) if next_n else None,
        "next_n": next_n,
        "sample_zt_dates": [bars[i]["date"] for i, _, _ in zt[-5:]],
    }


async def probe_ths_gene(client: httpx.AsyncClient, code: str) -> dict:
    urls = [
        f"https://data.10jqka.com.cn/dataapi/limit_up/gene?code={code}",
        f"https://data.10jqka.com.cn/dataapi/limit_up/radar?code={code}",
        f"https://dq.10jqka.com.cn/fuyao/limit_up_pool_service/stock_limit_up/radar/v1/get?stock_code={code}",
        f"https://eq.10jqka.com.cn/open/api/limit_up_ladder_service/stock_limit_up/limit_up_radar/v1/get_limit_up_radar?stock_code={code}",
        f"https://dq.10jqka.com.cn/fuyao/stock_limit_up_service/stock_limit_up/radar/v1/get?stock_code={code}",
    ]
    out = []
    for url in urls:
        try:
            r = await client.get(url, headers=THS_UA)
            try:
                data = r.json()
            except Exception:
                data = {"raw": r.text[:200]}
            item = {"url": url.split("/")[-1][:60], "http": r.status_code}
            if isinstance(data, dict):
                item["api"] = data.get("status_code")
                item["msg"] = data.get("status_msg")
                d = data.get("data")
                if isinstance(d, dict):
                    item["keys"] = list(d.keys())[:25]
                    # keep numeric-ish fields
                    item["nums"] = {
                        k: d[k]
                        for k in d
                        if isinstance(d[k], (int, float, str)) and k
                    }
                elif isinstance(d, list):
                    item["len"] = len(d)
            out.append(item)
        except Exception as e:
            out.append({"url": url, "error": str(e)})
        await asyncio.sleep(0.1)
    return {"probes": out}


async def audit_one(em: EastMoneyClient, ths: ThsClient, http: httpx.AsyncClient, code: str) -> dict:
    radar = await build_stock_radar(code, em, ths)
    kline = await em.fetch_kline(code, limit=780)
    bars = kline.get("bars") or []
    recomputed = recompute_from_bars(bars, code)

    em_hist = []
    try:
        em_hist = await em.fetch_stock_limitup_dates(code)
    except Exception as e:
        em_hist = [{"error": str(e)}]

    # 近3年窗口：与 bars 日期对齐
    start = str(bars[0].get("date") or "").replace("-", "")[:8] if bars else ""
    end = str(bars[-1].get("date") or "").replace("-", "")[:8] if bars else ""
    em_in_range = [
        r
        for r in em_hist
        if isinstance(r, dict)
        and start <= str(r.get("trade_date") or "").replace("-", "")[:8] <= end
    ]

    ths_probe = await probe_ths_gene(http, code)

    gene = radar.get("gene") or {}
    return {
        "code": code,
        "name": radar.get("name") or kline.get("name"),
        "as_of": radar.get("as_of"),
        "range": radar.get("range"),
        "local_gene": gene,
        "recompute_same_bars": recomputed,
        "em_limitup_hist_total": len(em_hist) if isinstance(em_hist, list) else None,
        "em_limitup_in_3y_window": len(em_in_range),
        "em_limitup_sample": em_in_range[:5],
        "delta_zt_vs_em_hist": (gene.get("zt_days") or 0) - len(em_in_range),
        "ths_probe": ths_probe,
        "success_rate_note": (
            "zt_success_rate/first_seal_rate 来自抽样 THS 池 limit_up_suc_rate 均值，"
            "不是近3年触板封板率的严格统计"
        ),
    }


async def main():
    em = EastMoneyClient()
    ths = ThsClient()
    rows = []
    async with httpx.AsyncClient(timeout=25, follow_redirects=True) as http:
        for code in CODES:
            print("auditing", code, flush=True)
            try:
                rows.append(await audit_one(em, ths, http, code))
            except Exception as e:
                rows.append({"code": code, "error": str(e)})
    out = Path(__file__).with_name("audit_gene_report.json")
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", out)
    for r in rows:
        if r.get("error"):
            print(r["code"], "ERROR", r["error"])
            continue
        g = r["local_gene"]
        rc = r["recompute_same_bars"]
        print(
            f"{r['code']} {r.get('name')} | gene zt/dt={g.get('zt_days')}/{g.get('dt_days')} "
            f"prem5={g.get('premium5_days')} suc={g.get('zt_success_rate')} "
            f"red={g.get('next_red_rate')} board={g.get('board_rate')} | "
            f"em_hist_3y={r['em_limitup_in_3y_window']} delta={r['delta_zt_vs_em_hist']} | "
            f"recompute zt={rc['zt_days']} sealed={rc['zt_sealed_close_eq_high']} "
            f"prem_close5={rc['premium5_close_only']}"
        )


if __name__ == "__main__":
    asyncio.run(main())
