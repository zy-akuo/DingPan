import sys
from pathlib import Path
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'apps/server'))
from _test_env import DATA
from app.services.market import MarketService
from app.models import StockItem

class StFilteringRegressionTests(unittest.TestCase):
    def test_st_detection_and_limit_threshold(self):
        for name in ['ST测试', '*ST测试', '退市测试', 'ＳＴ测试']:
            self.assertTrue(MarketService._stock_is_st(name))
            self.assertEqual(MarketService._limit_thr_for(name, '600001'), 4.85)
        self.assertFalse(MarketService._stock_is_st('浙文影业'))
        self.assertTrue(MarketService._stock_is_st('测试', ['st']))
        self.assertEqual(MarketService._limit_thr_for('测试', '600001'), 9.5)
        self.assertEqual(MarketService._limit_thr_for('测试', '300001'), 19.5)

    def test_hide_st_keeps_normal_live_and_history_rows(self):
        service = MarketService()
        normal = {'code': '601599', 'name': '浙文影业'}
        st = {'code': '600001', 'name': '*ST测试'}
        group = {'key': 'first', 'label': '首板', 'stocks': [normal, st], 'count': 2}
        payload = {'items': [normal, st], 'count': 2, 'zt_count': 2,
                   'board_groups': [group], 'concept_groups': [group]}
        with patch.object(service, '_show_st_enabled', return_value=False):
            live = service.filter_st_stocks([StockItem(**normal), StockItem(**st)])
            self.assertEqual([s.code for s in live], ['601599'])
            result = service.filter_st_history_payload(payload)
            self.assertEqual(result['count'], 1)
            self.assertEqual(result['items'], [normal])
            for key in ['board_groups', 'concept_groups']:
                self.assertEqual(result[key][0]['stocks'], [normal])
                self.assertEqual(result[key][0]['count'], 1)
        self.assertEqual(payload['count'], 2)

if __name__ == '__main__':
    unittest.main()
