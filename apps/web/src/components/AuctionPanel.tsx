import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import {
  Button,
  Empty,
  Input,
  Segmented,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  message,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BOARD_TAB_OPTIONS,
  matchBoardBucket,
  type BoardBucket,
} from "../lib/boardBucket";
import { AuctionVirtualList } from "./AuctionVirtualList";
import { collectRegions } from "./MonitorFilterBar";
import { matchNameOrInitials } from "../lib/stockMatch";
import { filterStItems } from "../lib/stStock";
import type { StockItem } from "../types";
import { formatMoney, formatPct } from "../types";

const BOARD_ROW_H = 40;
const LIST_MAX_H = 560;

type AuctionStock = {
  code: string;
  name: string;
  market?: string;
  board_count?: number;
  board_tag?: string;
  concepts?: string[];
  region?: string;
  industry?: string;
  is_yizhi?: boolean;
  auction_pct?: number | null;
  change_pct?: number | null;
  amount?: number | null;
  float_mv?: number | null;
  free_float_mv?: number | null;
  price?: number | null;
  price_0915?: number | null;
  price_0920?: number | null;
  price_0925?: number | null;
  seal_0915?: number | null;
  seal_0920?: number | null;
  seal_0925?: number | null;
  pct_0915?: number | null;
  pct_0920?: number | null;
  pct_0925?: number | null;
};

type BoardColumn = {
  date: string;
  date_label: string;
  yizhi_count?: number;
  other_count?: number;
  seal_total?: number;
  yizhi_items?: AuctionStock[];
  other_items?: AuctionStock[];
  items?: AuctionStock[];
};

type BoardPayload = {
  phase?: string;
  display_mode?: string;
  display_date?: string;
  is_live_today?: boolean;
  active_slot?: string | null;
  trade_date?: string;
  selected_date?: string;
  updated_at?: string;
  column?: BoardColumn;
  error?: string;
};

type PrevStock = {
  code: string;
  name: string;
  market?: string;
  board_count?: number;
  board_tag?: string;
  auction_pct?: number | null;
  suspended?: boolean;
  region?: string;
  industry?: string;
  concepts?: string[];
  reason?: string;
};

type PrevGroup = {
  key: string;
  label: string;
  board_count: number;
  count: number;
  promotion_rate?: string;
  stocks: PrevStock[];
};

type PrevPayload = {
  phase?: string;
  trade_date?: string;
  prev_date?: string;
  updated_at?: string;
  groups?: PrevGroup[];
};

/** 竞价未匹配额：≥1亿用「x.xx亿」(去尾0)，否则「xxxx万」；无数据不回退股价 */
function formatSealAmount(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v)) || Number(v) <= 0) return "—";
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 1e8) {
    const yi = n / 1e8;
    const s = yi.toFixed(2).replace(/\.?0+$/, "");
    return `${s}亿`;
  }
  if (abs >= 1e4) return `${Math.round(n / 1e4)}万`;
  return `${Math.round(n)}`;
}

function pctClass(v?: number | null): string {
  if (v == null || Number.isNaN(v)) return "";
  if (v > 0) return "up";
  if (v < 0) return "down";
  return "";
}

function pctText(v?: number | null): string {
  if (v == null || Number.isNaN(v)) return "—";
  return formatPct(v);
}

/** 接近涨停的竞价涨幅阈值（与后端 _limit_thr_for 对齐） */
function nearLimitThr(code?: string, name?: string): number {
  const n = (name || "").trim().replace(/ＳＴ/g, "ST").replace(/＊/g, "*");
  if (
    n.startsWith("*ST") ||
    n.startsWith("ST*") ||
    n.startsWith("ST") ||
    n.startsWith("退市")
  ) {
    return 4.85;
  }
  const c = String(code || "").padStart(6, "0");
  if (c.startsWith("300") || c.startsWith("301") || c.startsWith("688")) {
    return 19.5;
  }
  return 9.5;
}

function mvText(v?: number | null): string {
  if (v == null || Number.isNaN(Number(v)) || Number(v) <= 0) return "—";
  return formatMoney(Number(v));
}

function priceText(v?: number | null): string {
  if (v == null || Number.isNaN(Number(v)) || Number(v) <= 0) return "—";
  return Number(v).toFixed(2);
}

function contentSignature(data: unknown): string {
  if (data == null || typeof data !== "object") return JSON.stringify(data);
  const obj = data as Record<string, unknown>;
  const { updated_at: _u, ...rest } = obj;
  return JSON.stringify(rest);
}

/** 9:10 起加强轮询（预热清空 + 竞价），9:25 后停止，对齐服务端 */
function isLocalAuctionWindow(now = new Date()): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const sec = now.getSeconds();
  // 与服务端 _AUCTION_END=09:25:45 对齐：9:26 起不再轮询
  if (mins > 9 * 60 + 25) return false;
  if (mins === 9 * 60 + 25 && sec >= 45) return false;
  return mins >= 9 * 60 + 10;
}

function boardStatusTag(data: BoardPayload | null | undefined) {
  const mode = data?.display_mode || "";
  const slot = data?.active_slot || "";
  if (mode === "auction" || data?.phase === "auction") {
    return (
      <Space size={4}>
        <Tag color="red">竞价中 {slot}</Tag>
        {slot === "0915" ? (
          <Tag color="orange">可撤单，封单仅供参考</Tag>
        ) : null}
      </Space>
    );
  }
  if (mode === "warming") {
    return <Tag color="gold">已清空，等待竞价</Tag>;
  }
  if (mode === "display_prev") {
    const ds = data?.display_date || data?.selected_date || "";
    const label =
      ds.length === 8
        ? `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`
        : ds;
    return <Tag>展示上一交易日{label ? ` ${label}` : ""}</Tag>;
  }
  return <Tag>非竞价时段</Tag>;
}

function toStockItem(s: {
  code: string;
  name: string;
  market?: string;
  price?: number | null;
  change_pct?: number | null;
  auction_pct?: number | null;
  amount?: number | null;
  float_mv?: number | null;
  free_float_mv?: number | null;
  concepts?: string[];
  region?: string;
  industry?: string;
  board_count?: number;
  board_tag?: string;
}): StockItem {
  return {
    code: s.code,
    name: s.name,
    market: s.market || "深",
    price: Number(s.price || 0),
    change_pct: Number(s.change_pct ?? s.auction_pct ?? 0),
    amount: Number(s.amount || 0),
    volume: 0,
    float_mv: Number(s.float_mv || 0),
    total_mv: 0,
    turnover: 0,
    seal_amount: 0,
    first_seal_time: "",
    last_seal_time: "",
    board_count: Number(s.board_count || 1),
    open_times: 0,
    industry: s.industry || "",
    concepts: s.concepts || [],
    zt_stats: "",
    status: "封",
    board_tag: s.board_tag || "",
    region: s.region || "",
    free_float_mv:
      s.free_float_mv == null || Number.isNaN(Number(s.free_float_mv))
        ? null
        : Number(s.free_float_mv),
    top10_holder_pct: null,
    year_seal_rate: null,
    year_board_rate: null,
  };
}

function useStablePoll<T extends { phase?: string; display_mode?: string }>(
  fetcher: () => Promise<T>,
  intervalSec: number,
  enabled: boolean,
  depsKey = "",
): {
  data: T | null;
  loading: boolean;
  updatedAt: string;
  applyPayload: (next: T) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState("");
  const [inAuctionWindow, setInAuctionWindow] = useState(() =>
    isLocalAuctionWindow(),
  );
  const seq = useRef(0);
  const busy = useRef(false);
  const timer = useRef<number | null>(null);
  const frozen = useRef<string>("");
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const shouldPoll =
    data?.phase === "auction" ||
    data?.display_mode === "warming" ||
    data?.display_mode === "auction" ||
    inAuctionWindow;

  const applyPayload = useCallback((next: T) => {
    frozen.current = contentSignature(next);
    setData(next);
    const ts =
      next && typeof next === "object" && "updated_at" in (next as object)
        ? String((next as { updated_at?: string }).updated_at || "")
        : "";
    if (ts) setUpdatedAt(ts);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const my = ++seq.current;
    try {
      const next = await fetcherRef.current();
      if (my !== seq.current) return;
      const sig = contentSignature(next);
      if (sig !== frozen.current) {
        frozen.current = sig;
        setData(next);
      }
      const ts =
        next && typeof next === "object" && "updated_at" in (next as object)
          ? String((next as { updated_at?: string }).updated_at || "")
          : "";
      if (ts) setUpdatedAt(ts);
    } catch {
      /* keep */
    } finally {
      if (my === seq.current) setLoading(false);
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => setInAuctionWindow(isLocalAuctionWindow());
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      if (timer.current) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
      return;
    }
    seq.current += 1;
    frozen.current = "";
    setLoading(true);
    void refresh();
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (!shouldPoll) {
      return () => {
        seq.current += 1;
        busy.current = false;
      };
    }
    const ms = Math.max(1000, Math.round((intervalSec || 1.0) * 1000));
    timer.current = window.setInterval(() => void refresh(), ms);
    return () => {
      if (timer.current) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
      seq.current += 1;
      busy.current = false;
    };
  }, [enabled, intervalSec, refresh, shouldPoll, depsKey]);

  return { data, loading, updatedAt, applyPayload };
}

function AuctionTableHeader() {
  return (
    <div className="auction-wide-head">
      <span className="col-name">名称</span>
      <span className="col-t col-t915">9:15</span>
      <span className="col-t col-t920">9:20</span>
      <span className="col-t col-t925">9:25</span>
      <span className="col-num col-auction-pct">竞价涨幅</span>
      <span className="col-num">竞价成交额</span>
      <span className="col-num">流通市值</span>
      <span className="col-num">自由流通市值</span>
      <span className="col-num">股价</span>
      <span className="col-region">地域</span>
      <span className="col-concept">概念</span>
    </div>
  );
}

function AuctionTableRow({
  stock,
  searching,
  hit,
  onOpen,
}: {
  stock: AuctionStock;
  searching: boolean;
  hit: boolean;
  onOpen?: (s: StockItem) => void;
}) {
  const dim = searching && !hit;
  const concept = (stock.concepts || []).filter(Boolean).join("、") || "—";
  const region = (stock.region || "").trim() || "—";
  return (
    <button
      type="button"
      className={`auction-wide-row${hit ? " auction-row-hit" : ""}${dim ? " auction-row-dim" : ""}`}
      onClick={() => onOpen?.(toStockItem(stock))}
    >
      <span className="col-name">
        <span className="auction-name">{stock.name}</span>
        {stock.board_tag ? (
          <span className="auction-chip board">{stock.board_tag}</span>
        ) : null}
        {stock.is_yizhi ? <span className="auction-chip yizhi">一字</span> : null}
      </span>
      <span className="col-t col-t915">
        {formatSealAmount(stock.is_yizhi ? stock.seal_0915 : null)}
      </span>
      <span className="col-t col-t920">
        {formatSealAmount(stock.is_yizhi ? stock.seal_0920 : null)}
      </span>
      <span className="col-t col-t925">
        {formatSealAmount(stock.is_yizhi ? stock.seal_0925 : null)}
      </span>
      <span className={`col-num col-auction-pct ${pctClass(stock.auction_pct)}`}>
        {pctText(stock.auction_pct)}
      </span>
      <span className="col-num">{mvText(stock.amount)}</span>
      <span className="col-num">{mvText(stock.float_mv)}</span>
      <span className="col-num">{mvText(stock.free_float_mv)}</span>
      <span className="col-num">{priceText(stock.price)}</span>
      <span className="col-region" title={region}>
        {region}
      </span>
      <span className="col-concept" title={concept}>
        {concept}
      </span>
    </button>
  );
}

function AuctionBoardTab({
  pollSec,
  enabled,
  onOpenDetail,
  showStStocks = true,
}: {
  pollSec: number;
  enabled: boolean;
  onOpenDetail?: (s: StockItem) => void;
  showStStocks?: boolean;
}) {
  const [kw, setKw] = useState("");
  const [region, setRegion] = useState("");
  // 默认主板：在已采集竞价池上本地过滤，零额外请求（优于再拉前100）
  const [board, setBoard] = useState<BoardBucket>("main");

  const [refreshing, setRefreshing] = useState(false);

  const fetcher = useCallback(async () => {
    const res = await fetch("/api/auction/board");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as BoardPayload;
  }, []);

  const { data, loading, updatedAt, applyPayload } = useStablePoll(
    fetcher,
    pollSec,
    enabled,
  );

  const onManualRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/auction/refresh", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as BoardPayload;
      if (next.error) throw new Error(String(next.error));
      applyPayload(next);
      message.success("已强制刷新竞价数据");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }, [applyPayload, refreshing]);

  const col = data?.column;
  const displayMode = data?.display_mode || "";
  const yizhiAll = col?.yizhi_items;
  const otherAll = col?.other_items;

  const yizhi = useMemo(
    () =>
      filterStItems(
        (yizhiAll || []).filter((s) => matchBoardBucket(s.code, board)),
        showStStocks,
      ),
    [yizhiAll, board, showStStocks],
  );
  const other = useMemo(
    () =>
      filterStItems(
        (otherAll || []).filter((s) => matchBoardBucket(s.code, board)),
        showStStocks,
      ),
    [otherAll, board, showStStocks],
  );

  const regions = useMemo(() => {
    const rows: { region?: string }[] = [];
    for (const s of yizhi) rows.push(s);
    for (const s of other) rows.push(s);
    return collectRegions(rows as StockItem[]);
  }, [yizhi, other]);

  const hitCodes = useMemo(() => {
    const q = kw.trim();
    const r = region.trim();
    if (!q && !r) return null;
    const set = new Set<string>();
    for (const s of [...yizhi, ...other]) {
      if (q && !matchNameOrInitials(s.name || "", q)) continue;
      if (r && !(s.region || "").includes(r)) continue;
      set.add(s.code);
    }
    return set;
  }, [yizhi, other, kw, region]);

  const searching = !!(kw.trim() || region.trim());

  const emptyDesc =
    displayMode === "warming"
      ? "已清空上一交易日数据，9:15 起自动采集今日竞价"
      : displayMode === "display_prev"
        ? "暂无上一交易日竞价快照"
        : !(yizhiAll?.length || otherAll?.length)
          ? "暂无竞价数据（竞价时段自动采集 9:15/9:20/9:25）"
          : "当前板块暂无竞价数据";

  const renderSection = (title: string, items: AuctionStock[]) => (
    <div className="auction-wide-section" key={title}>
      <div className="auction-wide-section-title">
        {title}
        <span className="muted">（{items.length}）</span>
      </div>
      {items.length ? (
        <AuctionVirtualList
          className="auction-wide-list"
          items={items}
          rowHeight={BOARD_ROW_H}
          maxHeight={Math.min(LIST_MAX_H, Math.max(160, items.length * BOARD_ROW_H + 8))}
          getKey={(s) => s.code}
          renderRow={(s) => (
            <AuctionTableRow
              stock={s}
              searching={searching}
              hit={searching && !!hitCodes?.has(s.code)}
              onOpen={onOpenDetail}
            />
          )}
        />
      ) : (
        <div className="muted" style={{ padding: "8px 12px" }}>
          暂无
        </div>
      )}
    </div>
  );

  return (
    <div className="auction-board">
      <div className="auction-toolbar">
        <Space wrap>
          <Segmented
            size="small"
            value={board}
            options={BOARD_TAB_OPTIONS}
            onChange={(v) => setBoard(v as BoardBucket)}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="名称 / 首字母"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            style={{ width: 160 }}
          />
          <Select
            allowClear
            showSearch
            placeholder="地域"
            value={region || undefined}
            onChange={(v) => setRegion(v || "")}
            options={regions.map((x) => ({ label: x, value: x }))}
            optionFilterProp="label"
            style={{ width: 120 }}
          />
          {searching ? (
            <span className="filter-count">高亮 {hitCodes?.size ?? 0} 只</span>
          ) : null}
          {col && displayMode !== "warming" ? (
            <span className="muted">
              一字 {yizhi.length} | 非一字 {other.length} | 封单{" "}
              {formatMoney(
                yizhi.reduce((a, s) => a + Number(s.seal_0925 || s.seal_0920 || s.seal_0915 || 0), 0),
              )}
            </span>
          ) : null}
          {updatedAt ? (
            <span className="muted">更新 {updatedAt.slice(11, 19)}</span>
          ) : null}
          <Button
            size="small"
            icon={<ReloadOutlined spin={refreshing} />}
            loading={refreshing}
            onClick={() => void onManualRefresh()}
            title="强制重采最新竞价（竞价中会覆盖当前时段快照）"
          >
            刷新
          </Button>
          {boardStatusTag(data)}
        </Space>
      </div>

      {loading && !col ? (
        <div className="muted" style={{ padding: 24 }}>
          <Spin size="small" /> 加载竞价数据…
        </div>
      ) : !yizhi.length && !other.length ? (
        <Empty description={emptyDesc} />
      ) : (
        <div className="auction-wide">
          <AuctionTableHeader />
          {renderSection("一字板", yizhi)}
          {renderSection("非一字板", other)}
        </div>
      )}
    </div>
  );
}

function AuctionPrevTab({
  pollSec,
  enabled,
  onOpenDetail,
  showStStocks = true,
}: {
  pollSec: number;
  enabled: boolean;
  onOpenDetail?: (s: StockItem) => void;
  showStStocks?: boolean;
}) {
  const [kw, setKw] = useState("");
  const [region, setRegion] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const fetcher = useCallback(async () => {
    const res = await fetch("/api/auction/prev-ladder");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as PrevPayload;
  }, []);

  const { data, loading, updatedAt, applyPayload } = useStablePoll(
    fetcher,
    pollSec,
    enabled,
  );

  const onManualRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/auction/prev-ladder/refresh", {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as PrevPayload & { error?: string };
      if (next.error) throw new Error(String(next.error));
      applyPayload(next);
      message.success("已强制刷新昨日连板竞价");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }, [applyPayload, refreshing]);

  const groups = useMemo(() => {
    const raw = data?.groups || [];
    if (showStStocks) return raw;
    return raw.map((g) => {
      const stocks = filterStItems(g.stocks || [], false);
      return { ...g, stocks, count: stocks.length };
    });
  }, [data?.groups, showStStocks]);

  const regions = useMemo(() => {
    const rows: { region?: string }[] = [];
    for (const g of groups) for (const s of g.stocks || []) rows.push(s);
    return collectRegions(rows as StockItem[]);
  }, [groups]);

  const hitCodes = useMemo(() => {
    const q = kw.trim();
    const r = region.trim();
    if (!q && !r) return null;
    const set = new Set<string>();
    for (const g of groups) {
      for (const s of g.stocks || []) {
        if (q && !matchNameOrInitials(s.name || "", q)) continue;
        if (r && !(s.region || "").includes(r)) continue;
        set.add(s.code);
      }
    }
    return set;
  }, [groups, kw, region]);

  const searching = !!(kw.trim() || region.trim());
  const fmtDate = (ds?: string) =>
    ds && ds.length === 8
      ? `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`
      : ds || "—";
  const prevLabel = fmtDate(data?.prev_date);
  const todayLabel = fmtDate(data?.trade_date);

  return (
    <div className="auction-prev ladder">
      <div className="ladder-toolbar auction-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="名称 / 首字母模糊搜索"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          style={{ maxWidth: 280 }}
        />
        <Space size={4} className="filter-item">
          <span className="filter-label">地域</span>
          <Select
            allowClear
            showSearch
            placeholder="全部"
            value={region || undefined}
            onChange={(v) => setRegion(v || "")}
            options={regions.map((x) => ({ label: x, value: x }))}
            optionFilterProp="label"
            style={{ width: 120 }}
          />
        </Space>
        {searching ? (
          <span className="filter-count">高亮 {hitCodes?.size ?? 0} 只</span>
        ) : null}
        {updatedAt ? (
          <span className="muted">更新 {updatedAt.slice(11, 19)}</span>
        ) : null}
        <Button
          size="small"
          icon={<ReloadOutlined spin={refreshing} />}
          loading={refreshing}
          onClick={() => void onManualRefresh()}
          title="强制重算昨日连板竞价涨幅（竞价中会同步重采观察池）"
        >
          刷新
        </Button>
        {data?.phase === "auction" ? (
          <Tag color="red">竞价中</Tag>
        ) : (
          <Tag>已冻结 9:25 竞价结果</Tag>
        )}
      </div>

      {loading && !groups.length ? (
        <div className="muted" style={{ padding: 24 }}>
          <Spin size="small" /> 加载昨日连板竞价…
        </div>
      ) : !groups.length ? (
        <Empty description="暂无昨日涨停数据" />
      ) : (
        <>
          <h2 className="ladder-title">
            【{prevLabel}】昨日涨停 · 【{todayLabel}】今日竞价
          </h2>
          <div className="ladder-table">
            <div className="ladder-head">
              <div>连板</div>
              <div>竞价晋级</div>
              <div>股票（竞价涨幅）</div>
            </div>
            {groups.map((g) => (
              <div key={g.key} className="ladder-row">
                <div className="ladder-progress">{g.label}</div>
                <div className="ladder-rate">
                  {g.promotion_rate || `${g.count}只`}
                </div>
                <div className="ladder-stocks">
                  {(g.stocks || []).map((s) => {
                    const hit = searching && !!hitCodes?.has(s.code);
                    const dim = searching && !hit;
                    const pct = s.auction_pct;
                    const nearLimit =
                      pct != null &&
                      !Number.isNaN(pct) &&
                      pct >= nearLimitThr(s.code, s.name);
                    return (
                      <button
                        type="button"
                        key={s.code}
                        className={`ladder-stock${nearLimit ? " ladder-stock-ok" : ""}${hit ? " ladder-stock-hit" : ""}${dim ? " ladder-stock-dim" : ""}`}
                        onClick={() =>
                          onOpenDetail?.(
                            toStockItem({
                              ...s,
                              change_pct: s.auction_pct,
                              industry: s.industry || s.reason,
                            }),
                          )
                        }
                      >
                        <div className="ladder-stock-main">
                          <span className="mkt">{s.market || "深"}</span>
                          <span className="nm-link auction-prev-name">
                            {s.name}
                          </span>
                          <span className={`pct ${pctClass(pct)}`}>
                            {pct == null ? "[ — ]" : `[ ${pctText(pct)} ]`}
                          </span>
                          <span className="concept">
                            {s.concepts?.[0] || s.industry || ""}
                          </span>
                          {s.region ? (
                            <span className="region">{s.region}</span>
                          ) : null}
                          {s.suspended ? (
                            <span className="region">停牌</span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                  {!g.stocks?.length ? (
                    <span className="muted">暂无</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function AuctionPanel({
  pollSec = 1.0,
  onOpenDetail,
  showStStocks = true,
}: {
  pollSec?: number;
  onOpenDetail?: (s: StockItem) => void;
  showStStocks?: boolean;
}) {
  const [tab, setTab] = useState("board");
  const sec = Math.max(1.0, Math.min(5, Number(pollSec) || 1.0));

  return (
    <div className="auction-panel">
      <Tabs
        activeKey={tab}
        onChange={setTab}
        destroyInactiveTabPane={false}
        items={[
          {
            key: "board",
            label: "早盘竞价",
            children: (
              <AuctionBoardTab
                pollSec={sec}
                enabled={tab === "board"}
                onOpenDetail={onOpenDetail}
                showStStocks={showStStocks}
              />
            ),
          },
          {
            key: "prev",
            label: "昨日连板竞价",
            children: (
              <AuctionPrevTab
                pollSec={sec}
                enabled={tab === "prev"}
                onOpenDetail={onOpenDetail}
                showStStocks={showStStocks}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
