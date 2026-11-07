"""天梯题材回退只做名称规范化，不把行业猜测当作当日涨停原因。"""
import re

ALIASES = {
    '光伏概念': '光伏', '光伏产业': '光伏',
    '端侧人工智能': '端侧AI', '端侧AI概念': '端侧AI',
    '商业航天概念': '商业航天', '大飞机概念': '大飞机',
    '机器人': '机器人概念', 'AI应用概念': 'AI应用',
}
GENERIC = {'融资融券', '深股通', '沪股通', '标普道琼斯A股', 'MSCI概念',
           '富时罗素概念', '转融券标的', '注册制次新股', '专精特新', '国企改革'}


def normalize_theme(value: str) -> str:
    parts = re.split(r'[+＋、,，;；/]', str(value or '').strip())
    primary = next((p.strip() for p in parts if p.strip() and p.strip() not in GENERIC), '')
    return ALIASES.get(primary, primary)


def concept_fallback(stock):
    # 概念仅作候选，先排除与行业相同的标签及通用交易属性。
    relevant = [item.get('name', '') for item in (stock.concept_themes or [])
                if item.get('most_relevant')]
    for value in relevant + (stock.concepts or []):
        theme = normalize_theme(value)
        if theme and theme != stock.industry and theme not in GENERIC:
            return theme, 'concept', ''
    return stock.industry or '暂无题材信息', 'industry', ''
