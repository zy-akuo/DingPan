export type StockStatus = "成" | "败" | "炸" | "封";

export interface StockItem {
  code: string;
  name: string;
  market: string;
  price: number;
  change_pct: number;
  amount: number;
  volume: number;
  float_mv: number;
  total_mv: number;
  turnover: number;
  seal_amount: number;
  first_seal_time: string;
  last_seal_time: string;
  board_count: number;
  open_times: number;
  industry: string;
  concepts: string[];
  zt_stats: string;
  status: StockStatus;
  board_tag: string;
  region: string;
  free_float_mv: number | null;
  top10_holder_pct: number | null;
  /** 十大股东明细（详情抽屉） */
  top10_holders?: TopHolder[];
  /** 十大股东报告期 */
  top10_holders_date?: string;
  /** 历史曾用名 */
  former_names?: string[];
  year_seal_rate: number | null;
  year_board_rate: number | null;
  /** 涨速 % */
  speed?: number | null;
  /** 异动原因 */
  reason?: string;
  /** 避雷啦风险标签：st / delist / warn */
  risk_tags?: string[];
  /** 风险说明 */
  risk_hint?: string;
}

export interface TopHolder {
  rank: number;
  name: string;
  ratio: number | null;
  shares: number | null;
  change?: string;
  shares_type?: string;
}

export interface HistoryGroup {
  key: string;
  label: string;
  avg_change_pct: number;
  count: number;
  amount?: number;
  stocks: StockItem[];
}

export interface HistorySnapshot {
  date: string;
  date_label?: string;
  count: number;
  zt_count?: number;
  dt_count?: number;
  items: StockItem[];
  concept_groups: HistoryGroup[];
  board_groups: HistoryGroup[];
  source?: string;
  error?: string;
}

export interface StockZtHistoryItem {
  date: string;
  date_label: string;
  board_count: number;
  board_label: string;
  reason: string;
  first_seal_time?: string;
  name?: string;
}

export interface StockZtHistoryMatch {
  code: string;
  name: string;
  former_names?: string[];
  match_via?: string;
}

export interface StockZtHistoryResult {
  query?: string;
  stock?: { code: string; name: string; former_names?: string[] } | null;
  matches?: StockZtHistoryMatch[];
  items: StockZtHistoryItem[];
  count: number;
  need_select?: boolean;
  error?: string;
}

export interface MarketSummary {
  zt_today: number;
  zt_yesterday: number;
  lb_today: number;
  lb_yesterday: number;
  seal_rate_today: number;
  seal_rate_yesterday: number;
  zb_today: number;
  zb_yesterday: number;
  dt_today: number;
  dt_yesterday: number;
}

export interface LadderGroup {
  key: string;
  label: string;
  promotion_rate: string;
  stocks: StockItem[];
}

export interface SpeechEvent {
  type: string;
  code: string;
  name: string;
  text: string;
  board_count: number;
}

export interface MarketSnapshot {
  trade_date: string;
  updated_at: string;
  summary: MarketSummary;
  zt: StockItem[];
  lb: StockItem[];
  zb: StockItem[];
  dt: StockItem[];
  ladder: LadderGroup[];
  speech_events: SpeechEvent[];
}

export interface FieldConfig {
  table_columns: string[];
  detail_fields: string[];
  speech_enabled: boolean;
  /** 保留字段；仅支持 realtime 新事件播报 */
  speech_mode?: "realtime";
  speech_types: string[];
  /** 盘中实时轮询间隔（秒） */
  poll_interval_sec?: number;
  /** 涨速榜刷新间隔（秒） */
  speed_poll_interval_sec?: number;
}

export interface UserConfig {
  fields: FieldConfig;
  extra: Record<string, unknown>;
}

export function formatMoney(v?: number | null): string {
  if (v == null || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return `${v.toFixed(0)}`;
}

export function formatVolume(v?: number | null): string {
  if (v == null || Number.isNaN(v) || v <= 0) return "—";
  const hands = v >= 100 ? v / 100 : v;
  if (hands >= 1e8) return `${(hands / 1e8).toFixed(2)}亿手`;
  if (hands >= 1e4) return `${(hands / 1e4).toFixed(2)}万手`;
  return `${hands.toFixed(0)}手`;
}

export function formatPct(v?: number | null, suffix = "%"): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(2)}${suffix}`;
}

export function tradeDateLabel(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
