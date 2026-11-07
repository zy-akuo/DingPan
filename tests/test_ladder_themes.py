import asyncio
from datetime import datetime
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'apps/server'))
from _test_env import DATA
from app.collectors.kaipanla import KaipanlaClient, _parse_stock_row
from app.models import StockItem
from app.services.market import MarketService


class LadderThemeTests(unittest.TestCase):
    def test_same_parser_and_trade_date_validation(self):
        async def run():
            client = KaipanlaClient()
            def row(code, day, theme):
                data = [None] * 23
                data[0], data[1], data[4], data[5], data[12], data[15] = (
                    code, code, int(datetime.fromisoformat(day + 'T09:30:00').timestamp()), theme, '电子', 1)
                return _parse_stock_row(data, 1)
            async def fetch(date, pid, *, source):
                if pid != 1:
                    return []
                return ([row('001001', '2026-11-06', '光伏')]
                        if source == 'hist' else [row('001002', '2026-11-05', '旧题材'),
                                                row('001003', '2026-11-06', '端侧AI')])
            with patch.object(client, 'fetch_board_level', side_effect=fetch), patch.object(client, '_is_recent_calendar_date', return_value=True):
                themes = await client.fetch_theme_map('20261106')
            self.assertEqual(themes, {'001001': '光伏', '001003': '端侧AI'})
        asyncio.run(run())

    def test_apply_only_same_day_and_preserve_quotes_and_industry(self):
        service = MarketService()
        stock = StockItem(code='001003', name='测试', industry='电子', price=12, concepts=['电子'])
        service._ladder_theme_date = '20261106'
        service._ladder_themes = {'001003': '端侧AI'}
        service._apply_ladder_themes('20261107', [stock])
        self.assertEqual(stock.reason, '电子')
        self.assertEqual(stock.reason_source, 'industry')
        service._apply_ladder_themes('20261106', [stock])
        self.assertEqual(stock.reason, '端侧AI')
        self.assertEqual(stock.industry, '电子')
        self.assertEqual(stock.price, 12)
        self.assertEqual(stock.concepts, ['电子'])

class FallbackThemeTests(unittest.TestCase):
    def test_fallback_upgrades_and_official_theme_never_downgrades(self):
        service = MarketService()
        date = '20261106'
        stock = StockItem(code='001003', name='测试', industry='电子', concepts=['融资融券', '端侧AI概念'])
        service._apply_ladder_themes(date, [stock])
        self.assertEqual((stock.reason, stock.reason_source), ('端侧AI', 'concept'))
        service._y_pool_date = service._previous_theme_date = '20261105'
        service._previous_themes = {'001003': '芯片'}
        service._apply_ladder_themes(date, [stock])
        self.assertEqual((stock.reason, stock.reason_source, stock.reason_date), ('芯片', 'previous_kaipanla', '20261105'))
        service._fallback_theme_date = date
        service._fallback_themes = {'001003': ('端侧AI', 'ths', date)}
        service._apply_ladder_themes(date, [stock])
        self.assertEqual(stock.reason_source, 'ths')
        service._ladder_theme_date = date
        service._ladder_themes = {'001003': '大飞机'}
        service._apply_ladder_themes(date, [stock])
        self.assertEqual((stock.reason, stock.reason_source), ('大飞机', 'kaipanla'))
        service._fallback_themes['001003'] = ('芯片', 'ths', date)
        service._apply_ladder_themes(date, [stock])
        self.assertEqual(stock.reason, '大飞机')
        # 跨日缓存不得继续显示为当日确认题材。
        service._y_pool_date = '20261106'
        service._apply_ladder_themes('20261109', [stock])
        self.assertEqual((stock.reason, stock.reason_source), ('端侧AI', 'concept'))

    def test_primary_reason_normalization_and_relevant_concept(self):
        from app.services.ladder_theme import normalize_theme, concept_fallback
        self.assertEqual(normalize_theme('光伏概念+储能'), '光伏')
        self.assertEqual(normalize_theme('融资融券、端侧人工智能'), '端侧AI')
        self.assertEqual(normalize_theme('人工智能'), '人工智能')
        stock = StockItem(code='001003', name='测试', industry='电子', concepts=['融资融券', '芯片'],
                          concept_themes=[{'name': '端侧AI', 'most_relevant': True}])
        self.assertEqual(concept_fallback(stock), ('端侧AI', 'concept', ''))


if __name__ == '__main__':
    unittest.main()
