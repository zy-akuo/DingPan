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
    top10_holders: list[dict[str, Any]] | None = None
    top10_holders_date: str | None = None
    former_names: list[str] | None = None
    year_seal_rate: float | None = None
    year_board_rate: float | None = None
    speed: float | None = None  # 涨速 %
    reason: str = ""  # 异动原因（涨停概念/题材）
    # 避雷啦 / 风险警示：st=其他风险警示, delist=退市风险(*ST), warn=潜在风险
    risk_tags: list[str] = Field(default_factory=list)
    risk_hint: str = ""


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
    speech_enabled: bool = False
    speech_mode: str = "realtime"  # 仅 realtime
    speech_types: list[str] = Field(default_factory=lambda: ["zt", "lb", "zb"])
    # 盘中实时轮询间隔（秒），范围 1~30
    poll_interval_sec: float = 2.5
    # 涨速榜刷新间隔（秒），范围 0.5~10
    speed_poll_interval_sec: float = 1.5
    # 连板天梯是否展示封板/回封/炸板时间
    ladder_show_times: bool = True


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
    "year_seal_rate": "近一年封板率",
    "year_board_rate": "近一年连板率",
    "turnover": "换手率",
    "zt_stats": "涨停统计",
    "reason": "异动原因",
    "last_seal_time": "末封",
}


class UserConfig(BaseModel):
    fields: FieldConfig = Field(default_factory=FieldConfig)
    # 重点观察股票代码列表（持久化到本地 user_config.json）
    watchlist: list[str] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)
