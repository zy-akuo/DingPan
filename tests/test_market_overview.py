import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'apps/server'))
from _test_env import DATA
from app.services.market_overview import parse_days, build_overview, MarketOverviewService, parse_breadth
from unittest.mock import patch

class OverviewTests(unittest.TestCase):
    def fixture(self):
        def point(time, amount):
            return {'time':time, 'price': 3600, 'amount':amount, 'volume':amount * 2}
        return {symbol: {'20261106':[point('09:30',100),point('10:00',300)],
                         '20261105':[point('09:30',80),point('10:00',200),point('15:00',900)]}
                for symbol in ['sh000001','sh000002','sz399107']}

    def test_same_minute_comparison_never_uses_yesterday_close(self):
        data = build_overview(self.fixture(), [])
        self.assertEqual(data['amount'], 600)
        self.assertEqual(data['previous_amount'], 400)
        self.assertEqual(data['amount_delta'], 200)
        self.assertEqual(data['amount_delta_pct'], 50)
        self.assertEqual(data['amount_time'], '10:00')

    def test_missing_same_minute_stays_unknown(self):
        fixture = self.fixture()
        fixture['sz399107']['20261105'] = fixture['sz399107']['20261105'][:1]
        data = build_overview(fixture, [])
        self.assertIsNone(data['previous_amount'])
        self.assertIsNone(data['amount_delta'])

    def test_parse_cumulative_amount_and_volume(self):
        result = parse_days({'data':[{'date':'20261106','data':['0930 3600 20 400000','0931 3601 30 600000','bad','0931 3602 35 700000']}]})
        self.assertEqual(len(result['20261106']), 2)
        self.assertEqual(result['20261106'][-1]['amount'], 700000)
        self.assertEqual(result['20261106'][-1]['volume'], 3500)

    def test_failure_keeps_cached_data_marked_stale(self):
        async def run():
            service = MarketOverviewService()
            service.cached = build_overview(self.fixture(), [])
            with patch('app.services.market_overview.httpx.AsyncClient', side_effect=RuntimeError('offline')):
                result = await service.get()
            self.assertTrue(result['stale'])
            self.assertEqual(result['amount'], 600)
        asyncio.run(run())

class BreadthTests(unittest.TestCase):
    def rows(self):
        from datetime import datetime
        stamp = int(datetime(2026, 11, 6, 15, 0).timestamp())
        return [dict(f12=code, f104=up, f105=down, f106=flat, f124=stamp)
                for code, up, down, flat in [('000002',374,1908,34),('399107',342,2523,37),('899050',42,310,3)]]

    def test_full_market_counts(self):
        result = parse_breadth(self.rows())
        self.assertEqual((result['up'], result['down'], result['flat']), (758,4741,74))
        self.assertEqual(result['scope'], '沪深京')

    def test_missing_market_or_wrong_day_not_reported_as_full_market(self):
        self.assertIsNone(parse_breadth(self.rows()[:2]))
        rows = self.rows()
        rows[-1]['f124'] -= 86400
        self.assertIsNone(parse_breadth(rows))
        rows = self.rows()
        rows[0]['f104'] = '-'
        self.assertIsNone(parse_breadth(rows))

if __name__ == '__main__': unittest.main()
