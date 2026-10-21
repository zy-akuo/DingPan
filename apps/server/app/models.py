from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class StockStatus(str, Enum):
    SUCCESS = "成"
    FAIL = "败"
    BROKEN = "炸"
    HOLDING = "封"


class StockItem(BaseModel):
    code: str
    name: str
    market: str = ""  # 沪/深/创/科
    price: float = 0.0
    change_pct: float = 0.0
    amount: float = 0.0
    volume: float = 0.0  # 成交量（股）
    float_mv: float = 0.0
    total_mv: float = 0.0
    turnover: float = 0.0
    seal_amount: float = 0.0
    first_seal_time: str = ""
    last_seal_time: str = ""
    # 炸板时间（仅炸板标的；东财炸板池无此字段，由同花顺打开涨停池/分时推断补齐）
    break_time: str = ""
    board_count: int = 1
    open_times: int = 0
    industry: str = ""
    concepts: list[str] = Field(default_factory=list)
    zt_stats: str = ""  # e.g. 3/10
    status: StockStatus = StockStatus.SUCCESS
    board_tag: str = ""  # 硬板/回封/首板
    region: str = ""
    free_float_mv: float | None = None
    top10_holder_pct: float | None = None
    # 十大股东中持股≥5% 合计占比（自由流通剔除口径）
    top10_major_holder_pct: float | None = None
    top10_holders: list[dict[str, Any]] | None = None
    top10_holders_date: str | None = None
    former_names: list[str] | None = None
    year_seal_rate: float | None = None
    year_board_rate: float | None = None
    # 涨停基因（与详情雷达同源）
    zt_success_rate: float | None = None
    first_seal_rate: float | None = None
    next_red_rate: float | None = None
    speed: float | None = None  # 涨速 %
    reason: str = ""  # 异动原因（涨停概念/题材）
    # 避雷啦 / 风险警示：st=其他风险警示, delist=退市风险(*ST), warn=潜在风险
    risk_tags: list[str] = Field(default_factory=list)
    risk_hint: str = ""


DEFAULT_SPEED_TABLE_COLUMNS: list[str] = [
    "name",
    "speed",
    "amount",
    "total_mv",
    "free_float_mv",
    "price",
    "change_pct",
    "concepts",
    "industry",
    "region",
    "zt_success_rate",
    "first_seal_rate",
    "next_red_rate",
    "top10_holder_pct",
    "top10_major_holder_pct",
]


class HistoryGroup(BaseModel):
    key: str
    label: str
    avg_change_pct: float = 0.0
    count: int = 0
    amount: float = 0.0  # 板块成交额合计（开盘啦概念分类）
    stocks: list[StockItem] = Field(default_factory=list)


class MarketSummary(BaseModel):
    zt_today: int = 0
    zt_yesterday: int = 0
    lb_today: int = 0
    lb_yesterday: int = 0
    seal_rate_today: float = 0.0
    seal_rate_yesterday: float = 0.0
    zb_today: int = 0
    zb_yesterday: int = 0
    dt_today: int = 0
    dt_yesterday: int = 0


class LadderGroup(BaseModel):
    key: str
    label: str
    promotion_rate: str
    stocks: list[StockItem] = Field(default_factory=list)


class SpeechEvent(BaseModel):
    type: str  # zt / lb / zb
    code: str
    name: str
    text: str
    board_count: int = 1


class AlertEvent(BaseModel):
    """异动播报事件（冲击涨停 / 封死涨停 / 封涨大减 / 急涨急跌 / 涨停打开 / 涨停被砸）。"""

    type: str
    code: str
    name: str
    text: str
    board_count: int = 1
    board_label: str = "首板"
    time: str = ""
    detail: str = ""
    industry: str = ""


class MarketSnapshot(BaseModel):
    trade_date: str
    updated_at: str
    summary: MarketSummary
    zt: list[StockItem] = Field(default_factory=list)
    lb: list[StockItem] = Field(default_factory=list)
    zb: list[StockItem] = Field(default_factory=list)
    dt: list[StockItem] = Field(default_factory=list)
    ladder: list[LadderGroup] = Field(default_factory=list)
    speech_events: list[SpeechEvent] = Field(default_factory=list)
    # 本轮新产生的异动（供 TTS）；alert_feed 为当日流水（供表格）
    alert_events: list[AlertEvent] = Field(default_factory=list)
    alert_feed: list[AlertEvent] = Field(default_factory=list)


DEFAULT_ALERT_SPEECH_TYPES: list[str] = [
    "impact_zt",
    "seal_firm",
    "seal_drop",
    "seal_rise",
    "range_move",
    "zt_open",
    "zt_smash",
]


class FieldConfig(BaseModel):
    table_columns: list[str] = Field(
        default_factory=lambda: [
            "name",
            "board",
            "first_seal_time",
            "seal_amount",
            "amount",
            "volume",
            "float_mv",
            "concepts",
        ]
    )
    detail_fields: list[str] = Field(
        default_factory=lambda: [
            "price",
            "total_mv",
            "float_mv",
            "free_float_mv",
            "top10_holder_pct",
            "year_seal_rate",
            "year_board_rate",
            "volume",
            "amount",
            "concepts",
            "region",
            "industry",
        ]
    )
    # 涨速榜专用列顺序（与监控表 table_columns 独立）
    speed_table_columns: list[str] = Field(
        default_factory=lambda: list(DEFAULT_SPEED_TABLE_COLUMNS)
    )
    speech_enabled: bool = False
    speech_mode: str = "realtime"  # 仅 realtime
    speech_types: list[str] = Field(default_factory=lambda: ["zt", "lb", "zb"])
    # 盘中实时轮询间隔（秒），范围 1~30
    poll_interval_sec: float = 2.5
    # 涨速榜刷新间隔（秒），范围 0.5~10
    speed_poll_interval_sec: float = 1.5
    # 早盘竞价刷新间隔（秒），范围 0.5~5
    auction_poll_interval_sec: float = 1.0
    # 连板天梯是否展示封板/回封/炸板时间
    ladder_show_times: bool = True
    # 是否展示/拉取 ST、*ST、退市股（避雷啦面板除外）
    show_st_stocks: bool = True
    # 异动播报（独立于普通涨停/连板/炸板语音）
    alert_speech_enabled: bool = True
    alert_speech_types: list[str] = Field(
        default_factory=lambda: list(DEFAULT_ALERT_SPEECH_TYPES)
    )
    alert_speech_interval_sec: float = 1.0
    # 时间窗口涨跌幅提醒：默认 60 秒内涨跌幅超过 3%
    alert_range_window_sec: float = 60.0
    alert_range_pct: float = 3.0


AVAILABLE_FIELDS: dict[str, str] = {
    "name": "名称",
    "board": "板数",
    "first_seal_time": "首封",
    "seal_amount": "封单",
    "amount": "成交额",
    "volume": "成交量",
    "float_mv": "流通市值",
    "total_mv": "总市值",
    "free_float_mv": "自由流通市值",
    "price": "股价",
    "change_pct": "涨跌幅",
    "speed": "涨速",
    "concepts": "概念",
    "industry": "行业",
    "region": "地域",
    "top10_holder_pct": "十大股东持股占比",
    "top10_major_holder_pct": "十大股东持股≥5%占比",
    "zt_success_rate": "涨停成功率",
    "first_seal_rate": "首板封板率",
    "next_red_rate": "次日红盘率",
    "year_seal_rate": "近一年封板率",
    "year_board_rate": "近一年连板率",
    "turnover": "换手率",
    "zt_stats": "涨停统计",
    "reason": "异动原因",
    "last_seal_time": "末封",
}


def normalize_speed_table_columns(cols: list[str] | None) -> list[str]:
    """校验涨速榜列：固定 15 列全集，仅允许调整顺序。"""
    allowed = set(DEFAULT_SPEED_TABLE_COLUMNS)
    seen: set[str] = set()
    out: list[str] = []
    for k in cols or []:
        key = str(k or "").strip()
        if key in allowed and key not in seen:
            seen.add(key)
            out.append(key)
    for k in DEFAULT_SPEED_TABLE_COLUMNS:
        if k not in seen:
            out.append(k)
    return out


class UserConfig(BaseModel):
    fields: FieldConfig = Field(default_factory=FieldConfig)
    # 重点观察股票代码列表（持久化到本地 user_config.json）
    watchlist: list[str] = Field(default_factory=list)
    watchlist_pinned: list[str] = Field(default_factory=list)
    # 异动播报股票池（与重点观察分离）
    alertlist: list[str] = Field(default_factory=list)
    alertlist_pinned: list[str] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)
