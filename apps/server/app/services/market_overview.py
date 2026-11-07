"""上证分时与沪深A股成交概览：累计成交额按同分钟对齐，禁止按指数价格估算成交额。"""
from __future__ import annotations
import asyncio
from datetime import datetime
import time
from typing import Any
import httpx


def parse_days(node: dict) -> dict[str, list[dict]]:
    result = {}
    for day in node.get('data', []):
        points = {}
        for line in day.get('data', []):
            cells = str(line).split()
            if len(cells) < 4:
                continue
            try:
                hm = cells[0]
                if len(hm) != 4 or not hm.isdigit() or not '0930' <= hm <= '1500':
                    continue
                points[hm] = {'time': hm[:2] + ':' + hm[2:], 'price': float(cells[1]),
                              'volume': float(cells[2]) * 100, 'amount': float(cells[3])}
            except (ValueError, TypeError):
                continue
        if points:
            result[str(day['date'])] = [points[key] for key in sorted(points)]
    return result


def build_overview(days: dict[str, dict], quote: list[str]) -> dict[str, Any]:
    common = set(days['sh000001']) & set(days['sh000002']) & set(days['sz399107'])
    if not common:
        raise ValueError('未取得同一交易日的大盘数据')
    date = max(common)
    index_points = days['sh000001'][date]
    maps = [{p['time']: p for p in days[symbol][date]} for symbol in ('sh000002', 'sz399107')]
    times = set(maps[0]) & set(maps[1])
    if not times:
        raise ValueError('沪深成交数据时间未对齐')
    cutoff = max(times)
    amount = sum(m[cutoff]['amount'] for m in maps)
    volume = sum(m[cutoff]['volume'] for m in maps)
    previous_dates = sorted(d for d in common if d < date)
    previous_date = previous_dates[-1] if previous_dates else None
    previous_amount = None
    if previous_date:
        previous_maps = [{p['time']: p for p in days[symbol][previous_date]} for symbol in ('sh000002', 'sz399107')]
        # 必须同分钟有值，不能以昨日收盘或更早分钟冒充同期。
        if all(cutoff in m for m in previous_maps):
            previous_amount = sum(m[cutoff]['amount'] for m in previous_maps)
    quote_matches = len(quote) > 32 and quote[30][:8] == date
    last = float(quote[3]) if quote_matches else index_points[-1]['price']
    if quote_matches:
        previous_close = float(quote[4])
        quote_time = quote[30][8:10] + ':' + quote[30][10:12] + ':' + quote[30][12:14]
    elif previous_date:
        previous_close = days['sh000001'][previous_date][-1]['price']
        quote_time = index_points[-1]['time']
    else:
        previous_close = None
        quote_time = index_points[-1]['time']
    difference = amount - previous_amount if previous_amount is not None else None
    return {'trade_date': date, 'quote_time': quote_time, 'amount_time': cutoff, 'scope': '沪深A股',
            'price': last, 'pre_close': previous_close,
            'change': last - previous_close if previous_close else None,
            'change_pct': (last / previous_close - 1) * 100 if previous_close else None,
            'amount': amount, 'volume': volume, 'previous_date': previous_date,
            'previous_amount': previous_amount, 'amount_delta': difference,
            'amount_delta_pct': difference / previous_amount * 100 if previous_amount else None,
            'points': index_points, 'source': '腾讯行情', 'stale': False,
            'updated_at': datetime.now().isoformat(timespec='seconds')}


def parse_breadth(rows: list[dict]) -> dict | None:
    """行情源市场涨跌家数字段，覆盖沪深京；缺一个市场时不返回部分合计。"""
    expected = {'000002', '399107', '899050'}
    markets = {str(row.get('f12')): row for row in rows if str(row.get('f12')) in expected}
    if set(markets) != expected:
        return None
    dates = set()
    totals = {'up': 0, 'down': 0, 'flat': 0}
    try:
        for row in markets.values():
            dates.add(datetime.fromtimestamp(int(row['f124'])).strftime('%Y%m%d'))
            for field, key in [('f104', 'up'), ('f105', 'down'), ('f106', 'flat')]:
                value = int(row[field])
                if value < 0:
                    return None
                totals[key] += value
    except (KeyError, ValueError, TypeError, OSError, OverflowError):
        return None
    if len(dates) != 1:
        return None
    return {**totals, 'trade_date': dates.pop(), 'scope': '沪深京', 'stale': False}


class MarketOverviewService:
    def __init__(self):
        self.cached: dict | None = None
        self.expires = 0.0
        self.lock = asyncio.Lock()

    async def get(self) -> dict:
        if self.cached and time.monotonic() < self.expires:
            return self.cached
        async with self.lock:
            if self.cached and time.monotonic() < self.expires:
                return self.cached
            try:
                async with httpx.AsyncClient(timeout=7, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.qq.com/'}) as client:
                    async def days(symbol):
                        response = await client.get('https://web.ifzq.gtimg.cn/appstock/app/day/query', params={'code': symbol})
                        response.raise_for_status()
                        return parse_days((response.json().get('data') or {}).get(symbol) or {})
                    async def quote():
                        try:
                            response = await client.get('https://qt.gtimg.cn/q=sh000001')
                            response.raise_for_status()
                            return response.text.split('=', 1)[1].strip().strip('";\n ').split('~')
                        except Exception:
                            return []
                    async def breadth():
                        try:
                            response = await client.get('https://push2.eastmoney.com/api/qt/ulist.np/get', params={
                                'secids': '1.000002,0.399107,0.899050',
                                'fields': 'f12,f104,f105,f106,f124', 'fltt': '2'})
                            response.raise_for_status()
                            rows = (response.json().get('data') or {}).get('diff') or []
                            if isinstance(rows, dict):
                                rows = list(rows.values())
                            return parse_breadth(rows)
                        except Exception:
                            return None
                    sh, a, sz, q, breadth_data = await asyncio.gather(days('sh000001'), days('sh000002'), days('sz399107'), quote(), breadth())
                payload = build_overview({'sh000001': sh, 'sh000002': a, 'sz399107': sz}, q)
                if breadth_data and breadth_data['trade_date'] == payload['trade_date']:
                    payload['breadth'] = breadth_data
                else:
                    old = (self.cached or {}).get('breadth')
                    payload['breadth'] = {**old, 'stale': True} if old and old['trade_date'] == payload['trade_date'] else None
                self.cached = payload
                self.expires = time.monotonic() + 8
                return payload
            except Exception as exc:
                if self.cached:
                    self.expires = time.monotonic() + 8
                    self.cached = {**self.cached, 'breadth': {**self.cached['breadth'], 'stale': True} if self.cached.get('breadth') else None, 'stale': True, 'warning': '大盘更新失败，保留上次有效数据，请检查网络或代理'}
                    return self.cached
                raise RuntimeError('大盘数据加载失败，请检查网络、代理或稍后重试') from exc

market_overview_service = MarketOverviewService()
