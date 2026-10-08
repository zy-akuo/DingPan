from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .collectors.ths import ThsClient, build_stock_radar
from .config import settings
from .db import init_db, load_user_config, update_field_config, update_watchlist
from .models import AVAILABLE_FIELDS, FieldConfig
from .services.market import market_service
from .services.ttl_cache import ttl_cache, trading_ttl

ths_client = ThsClient()


def _kline_cache_stale(hit: dict) -> bool:
    """盘中若缓存最后一根不是今天，视为过期。"""
    now = datetime.now()
    if now.weekday() >= 5:
        return False
    if now.hour < 9 or (now.hour == 9 and now.minute < 25):
        return False
    bars = hit.get("bars") or []
    if not bars:
        return True
    last = str((bars[-1] or {}).get("date") or "")[:10].replace("-", "")
    return last < now.strftime("%Y%m%d")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await ttl_cache.init()
    poll_task = asyncio.create_task(
        market_service.poll_loop(settings.poll_interval_sec, settings.idle_poll_interval_sec)
    )
    fund_task = asyncio.create_task(market_service.fund_worker())
    history_task = asyncio.create_task(market_service.history_backfill_worker(120))
    risk_task = asyncio.create_task(market_service.risk_worker(600))
    cache_task = asyncio.create_task(ttl_cache.cleanup_loop(600))
    yield
    for t in (poll_task, fund_task, history_task, risk_task, cache_task):
        t.cancel()
    for t in (poll_task, fund_task, history_task, risk_task, cache_task):
        try:
            await t
        except asyncio.CancelledError:
            pass
    try:
        await market_service.client.aclose()
    except Exception:
        pass
    try:
        await ths_client.aclose()
    except Exception:
        pass


app = FastAPI(title="DingPan", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"ok": True, "updated_at": market_service.snapshot.updated_at}


@app.get("/api/market")
async def get_market():
    return market_service.snapshot


@app.get("/api/stocks/search")
async def stock_search(q: str = "", limit: int = 12):
    q = (q or "").strip()
    if not q:
        return {"items": []}
    items = await market_service.client.search_stocks(q, limit=limit)
    return {"items": items}


@app.get("/api/market/speed")
async def market_speed(limit: int = 50):
    limit = max(1, min(100, int(limit or 50)))
    items = await market_service.get_speed_rank(limit=limit)
    return {
        "items": [s.model_dump() for s in items],
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }


@app.get("/api/market/history")
async def market_history(date: str = ""):
    """历史涨停回溯（开盘啦）：连板梯队 + 概念分类。"""
    try:
        return await market_service.get_zt_history(date)
    except Exception as e:
        return {
            "date": (date or "").replace("-", ""),
            "count": 0,
            "items": [],
            "concept_groups": [],
            "board_groups": [],
            "error": str(e),
        }


@app.get("/api/market/history/stock")
async def market_history_stock(q: str = "", code: str = ""):
    """个股历史涨停日期：支持现用名 / 曾用名 / 代码；含连板数与涨停原因。"""
    try:
        return await market_service.get_stock_zt_history(
            q=q, code=code, ths_client=ths_client
        )
    except Exception as e:
        return {
            "query": q,
            "stock": None,
            "matches": [],
            "items": [],
            "count": 0,
            "error": str(e),
        }


@app.get("/api/market/risk")
async def market_risk(tab: str = "latest"):
    """避雷啦：最新预警 / ST预警 / 退市预警。"""
    try:
        return await market_service.get_risk_alerts(tab)
    except Exception as e:
        return {
            "tab": tab or "latest",
            "days": [],
            "current": [],
            "count": 0,
            "error": str(e),
        }


@app.post("/api/market/risk/refresh")
async def market_risk_refresh():
    try:
        return await market_service.refresh_risk(force=True)
    except Exception as e:
        return {"count": 0, "error": str(e)}


@app.get("/api/stocks/batch")
async def stocks_batch(codes: str = ""):
    code_list = [c.strip().zfill(6) for c in (codes or "").split(",") if c.strip()]
    code_list = [c for c in code_list if c.isdigit() and len(c) == 6]
    seen: set[str] = set()
    uniq: list[str] = []
    for c in code_list:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    items = await market_service.get_stocks_by_codes(uniq)
    return {"items": [s.model_dump() for s in items]}


@app.get("/api/stock/{code}/fundamentals")
async def stock_fundamentals(code: str):
    return await market_service.get_stock_detail(code)


@app.get("/api/stock/{code}/radar")
async def stock_radar(code: str):
    try:
        return await build_stock_radar(code, market_service.client, ths_client)
    except Exception as e:
        return {
            "code": code,
            "name": "",
            "gene": {},
            "prices": [],
            "marks": [],
            "details": [],
            "error": str(e),
        }


@app.get("/api/stock/{code}/trends")
async def stock_trends(code: str):
    code = code.zfill(6)
    key = f"trends:{code}"
    hit = await ttl_cache.get(key)
    # 空结果不命中缓存，避免盘前空数据挡住上一交易日回退
    if (
        hit
        and isinstance(hit, dict)
        and isinstance(hit.get("points"), list)
        and len(hit.get("points") or []) > 0
    ):
        hit = dict(hit)
        hit["_cache_hit"] = True
        return hit
    try:
        data = await market_service.client.fetch_trends(code)
    except Exception:
        data = {"code": code, "name": "", "pre_close": 0, "points": [], "trade_date": ""}
    points = data.get("points") or []
    # 有数据：盘中短缓存；空：极短缓存避免打爆上游
    ttl = trading_ttl(20, 180) if points else 8
    await ttl_cache.set(key, data, ttl, kind="trends")
    data = dict(data)
    data["_cache_hit"] = False
    return data


@app.get("/api/stock/{code}/kline")
async def stock_kline(code: str, limit: int = 120):
    code = code.zfill(6)
    key = f"kline:{code}:{limit}"
    hit = await ttl_cache.get(key)
    if hit and isinstance(hit, dict) and hit.get("bars") is not None and not _kline_cache_stale(hit):
        hit = dict(hit)
        hit["_cache_hit"] = True
        return hit
    try:
        data = await market_service.client.fetch_kline(code, limit=limit)
    except Exception:
        data = {"code": code, "name": "", "bars": []}
    await ttl_cache.set(key, data, trading_ttl(30, 3600), kind="kline")
    data = dict(data)
    data["_cache_hit"] = False
    return data


@app.get("/api/config")
async def get_config():
    cfg = load_user_config()
    return {
        "config": cfg.model_dump(),
        "available_fields": AVAILABLE_FIELDS,
    }


@app.put("/api/config/fields")
async def put_fields(fields: FieldConfig):
    # clamp poll interval
    try:
        fields.poll_interval_sec = max(1.0, min(30.0, float(fields.poll_interval_sec or 2.5)))
    except Exception:
        fields.poll_interval_sec = 2.5
    try:
        fields.speed_poll_interval_sec = max(
            0.5, min(10.0, float(fields.speed_poll_interval_sec or 1.5))
        )
    except Exception:
        fields.speed_poll_interval_sec = 1.5
    cfg = update_field_config(fields)
    return cfg.model_dump()


class WatchlistBody(BaseModel):
    codes: list[str] = Field(default_factory=list)


@app.get("/api/watchlist")
async def get_watchlist():
    cfg = load_user_config()
    return {"codes": list(cfg.watchlist or [])}


@app.put("/api/watchlist")
async def put_watchlist(body: WatchlistBody):
    cfg = update_watchlist(body.codes)
    return {"codes": list(cfg.watchlist or [])}


@app.websocket("/ws/market")
async def ws_market(ws: WebSocket):
    await ws.accept()
    q = market_service.subscribe()
    try:
        await ws.send_json(market_service.snapshot.model_dump())
        while True:
            payload = await q.get()
            await ws.send_json(payload)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        market_service.unsubscribe(q)


def mount_static(application: FastAPI) -> None:
    candidates = [
        Path(__file__).resolve().parents[1] / "web_dist",
        Path(__file__).resolve().parents[3] / "apps" / "web" / "dist",
        Path(__file__).resolve().parents[2] / "web_dist",
    ]
    static_dir = next((p for p in candidates if p.exists()), None)
    if not static_dir:
        return

    assets = static_dir / "assets"
    if assets.exists():
        application.mount("/assets", StaticFiles(directory=assets), name="assets")

    @application.get("/")
    async def index():
        return FileResponse(static_dir / "index.html")

    @application.get("/{full_path:path}")
    async def spa(full_path: str):
        target = static_dir / full_path
        if target.exists() and target.is_file():
            return FileResponse(target)
        return FileResponse(static_dir / "index.html")


mount_static(app)
