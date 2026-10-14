import {
  LeftOutlined,
  LineChartOutlined,
  RightOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  AutoComplete,
  Button,
  DatePicker,
  Empty,
  Input,
  Segmented,
  Spin,
  Tag,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import "dayjs/locale/zh-cn";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchNameOrInitials } from "../lib/stockMatch";
import type {
  HistoryGroup,
  HistorySnapshot,
  StockItem,
  StockZtHistoryMatch,
  StockZtHistoryResult,
} from "../types";
import { formatMoney, formatPct, tradeDateLabel } from "../types";
import { MonitorTable } from "./MonitorTable";
import { StockChartModal } from "./StockChartModal";

type StockSuggest = { code: string; name: string; market: string };

dayjs.extend(customParseFormat);
dayjs.locale("zh-cn");

type ViewMode = "ladder" | "concept";

const HISTORY_DATE_KEY = "dingpan.historyDate";

function toYmd(d: Dayjs): string {
  return d.format("YYYYMMDD");
}

function fromYmd(s: string): Dayjs {
  const raw = (s || "").replace(/-/g, "");
  if (raw.length === 8 && /^\d{8}$/.test(raw)) {
    const parsed = dayjs(
      `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
      "YYYY-MM-DD",
      true,
    );
    if (parsed.isValid()) return parsed;
  }
  return dayjs();
}

function normalizeYmd(s: string | undefined | null, fallback?: string): string {
  const raw = (s || "").replace(/-/g, "").trim();
  if (raw.length === 8 && /^\d{8}$/.test(raw)) return raw;
  const fb = (fallback || "").replace(/-/g, "").trim();
  if (fb.length === 8 && /^\d{8}$/.test(fb)) return fb;
  return dayjs().format("YYYYMMDD");
}

function readStoredDate(): string | null {
  try {
    const v = sessionStorage.getItem(HISTORY_DATE_KEY);
    if (v && /^\d{8}$/.test(v)) return v;
  } catch {
    /* ignore */
  }
  return null;
}

function writeStoredDate(ds: string) {
  try {
    sessionStorage.setItem(HISTORY_DATE_KEY, ds);
  } catch {
    /* ignore */
  }
}

function ensureReasonColumn(columns: string[]): string[] {
  if (columns.includes("reason")) return columns;
  return [...columns, "reason"];
}

function shiftTradeDay(ymd: string, delta: number): string {
  let cur = fromYmd(ymd).add(delta, "day");
  const today = dayjs().startOf("day");
  for (let i = 0; i < 12; i++) {
    if (delta > 0 && cur.isAfter(today, "day")) {
      return ymd;
    }
    if (cur.day() !== 0 && cur.day() !== 6) {
      return toYmd(cur);
    }
    cur = cur.add(delta > 0 ? 1 : -1, "day");
  }
  return toYmd(cur);
}

/** 供 App 初始化历史日期：优先会话缓存，其次交易日 */
export function resolveHistoryDate(tradeDate?: string): string {
  return normalizeYmd(readStoredDate(), tradeDate);
}

function sealTimeShort(t?: string): string {
  if (!t) return "";
  // HH:MM:SS -> H:MM / HH:MM
  const parts = t.split(":");
  if (parts.length >= 2) {
    const h = String(Number(parts[0]));
    return `${h}:${parts[1]}`;
  }
  return t;
}

function StockChip({
  stock,
  onClick,
  onOpenChart,
  hit,
  dim,
  chipRef,
}: {
  stock: StockItem;
  onClick: (s: StockItem) => void;
  onOpenChart?: (s: StockItem) => void;
  hit?: boolean;
  dim?: boolean;
  chipRef?: (el: HTMLDivElement | null) => void;
}) {
  const concept = stock.reason || stock.concepts?.[0] || stock.industry || "";
  const cls = [
    "kpl-chip",
    hit ? "kpl-chip-hit" : "",
    dim ? "kpl-chip-dim" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      ref={chipRef}
      className={cls}
      role="button"
      tabIndex={0}
      onClick={() => onClick(stock)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(stock);
        }
      }}
      title={`${stock.name} ${stock.code}`}
    >
      <span className="kpl-chip-time">{sealTimeShort(stock.first_seal_time)}</span>
      <span className="kpl-chip-name">{stock.name}</span>
      {concept ? <span className="kpl-chip-concept">{concept}</span> : null}
      {stock.zt_stats && /一字/.test(stock.zt_stats) ? (
        <span className="kpl-chip-tag">一字</span>
      ) : null}
      {onOpenChart ? (
        <button
          type="button"
          className="kpl-chip-chart"
          title="查看当日分时/日K"
          onClick={(e) => {
            e.stopPropagation();
            onOpenChart(stock);
          }}
        >
          <LineChartOutlined />
        </button>
      ) : null}
    </div>
  );
}

export function HistoryBackPanel({
  columns,
  onRowClick,
  selectedCode,
  date,
  onDateChange,
}: {
  columns: string[];
  onRowClick: (s: StockItem) => void;
  selectedCode?: string | null;
  date: string;
  onDateChange: (ymd: string) => void;
}) {
  const [mode, setMode] = useState<ViewMode>("ladder");
  const [nameKw, setNameKw] = useState("");
  const [kw, setKw] = useState("");
  const [stockKw, setStockKw] = useState("");
  const [stockOptions, setStockOptions] = useState<
    { value: string; label: string; item: StockSuggest }[]
  >([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockResult, setStockResult] = useState<StockZtHistoryResult | null>(null);
  const [highlightCode, setHighlightCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<HistorySnapshot | null>(null);
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const [activeConcept, setActiveConcept] = useState<string | null>(null);
  const reqSeq = useRef(0);
  const stockReqSeq = useRef(0);
  const stockSearchTimer = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hitChipRef = useRef<HTMLDivElement | null>(null);

  const displayCols = useMemo(() => ensureReasonColumn(columns), [columns]);
  const dateValue = useMemo(() => fromYmd(date), [date]);

  const setDateSafe = useCallback(
    (next: string) => {
      const ymd = normalizeYmd(next, date);
      writeStoredDate(ymd);
      onDateChange(ymd);
    },
    [date, onDateChange],
  );

  const load = useCallback(
    async (ds: string) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      setActiveConcept(null);
      try {
        const res = await fetch(`/api/market/history?date=${encodeURIComponent(ds)}`);
        if (seq !== reqSeq.current) return;
        if (!res.ok) {
          setData({
            date: ds,
            count: 0,
            items: [],
            concept_groups: [],
            board_groups: [],
            error: `加载失败(${res.status})`,
          });
          return;
        }
        const payload = (await res.json()) as HistorySnapshot;
        if (seq !== reqSeq.current) return;
        // 后端可能把周末/未入库日纠正为最近交易日（开盘啦实时源）
        const actual = normalizeYmd(payload.date, ds);
        setData({ ...payload, date: actual });
        if (actual !== ds) {
          writeStoredDate(actual);
          onDateChange(actual);
        }
      } catch (e) {
        if (seq !== reqSeq.current) return;
        setData({
          date: ds,
          count: 0,
          items: [],
          concept_groups: [],
          board_groups: [],
          error: e instanceof Error ? e.message : "网络错误",
        });
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [onDateChange],
  );

  useEffect(() => {
    void load(date);
  }, [date, load]);

  // 跳转日期加载完成后，滚动到高亮个股
  useEffect(() => {
    if (!highlightCode || loading) return;
    const t = window.setTimeout(() => {
      hitChipRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(t);
  }, [highlightCode, loading, date, data]);

  /** 涨停原因筛选（不吞名称模糊，名称走连板天梯同款高亮） */
  const filterByReason = useCallback(
    (s: StockItem) => {
      const q = kw.trim().toLowerCase();
      if (!q) return true;
      return (
        (s.reason || "").toLowerCase().includes(q) ||
        (s.industry || "").toLowerCase().includes(q) ||
        (s.concepts || []).some((c) => c.toLowerCase().includes(q))
      );
    },
    [kw],
  );

  const nameSearching = !!nameKw.trim();
  const nameHitCodes = useMemo(() => {
    const q = nameKw.trim();
    if (!q) return null as Set<string> | null;
    const set = new Set<string>();
    const push = (stocks: StockItem[]) => {
      for (const s of stocks) {
        if (matchNameOrInitials(s.name || "", q)) set.add(s.code);
      }
    };
    for (const g of data?.board_groups || []) push(g.stocks || []);
    for (const g of data?.concept_groups || []) push(g.stocks || []);
    for (const s of data?.items || []) {
      if (matchNameOrInitials(s.name || "", q)) set.add(s.code);
    }
    return set;
  }, [data, nameKw]);

  const conceptGroups = useMemo(() => {
    const raw = data?.concept_groups || [];
    if (!kw.trim()) return raw;
    return raw
      .map((g) => {
        const stocks = (g.stocks || []).filter(filterByReason);
        if (!stocks.length) return null;
        return { ...g, stocks, count: stocks.length };
      })
      .filter(Boolean) as HistoryGroup[];
  }, [data, kw, filterByReason]);

  const boardGroups = useMemo(() => {
    const raw = data?.board_groups || [];
    return raw
      .map((g) => {
        let stocks = (g.stocks || []).filter(filterByReason);
        if (activeConcept) {
          stocks = stocks.filter((s) => {
            const primary = (s.reason || s.industry || "").trim();
            if (primary === activeConcept) return true;
            return (s.concepts || []).some((c) => c === activeConcept);
          });
        }
        if (!stocks.length && (kw.trim() || activeConcept)) return null;
        return { ...g, stocks, count: stocks.length };
      })
      .filter(Boolean) as HistoryGroup[];
  }, [data, kw, filterByReason, activeConcept]);

  const dateLabel = tradeDateLabel(date);
  const canNext = dateValue.isBefore(dayjs(), "day");
  const ztCount = data?.zt_count ?? data?.count ?? 0;
  const highlighting = !!highlightCode;
  const ladderSearching = highlighting || nameSearching;

  const detailGroup = useMemo(() => {
    if (mode !== "concept") return null;
    if (activeConcept) {
      return conceptGroups.find((g) => g.label === activeConcept) || null;
    }
    return null;
  }, [mode, activeConcept, conceptGroups]);

  const runStockSearch = useCallback(
    async (query: string, code?: string) => {
      const q = query.trim();
      if (!q && !code) {
        setStockResult(null);
        return;
      }
      const seq = ++stockReqSeq.current;
      setStockLoading(true);
      try {
        const params = new URLSearchParams();
        if (code) params.set("code", code);
        else params.set("q", q);
        const res = await fetch(`/api/market/history/stock?${params.toString()}`);
        if (seq !== stockReqSeq.current) return;
        if (!res.ok) {
          setStockResult({
            query: q,
            items: [],
            count: 0,
            error: `查询失败(${res.status})`,
          });
          return;
        }
        const payload = (await res.json()) as StockZtHistoryResult;
        if (seq !== stockReqSeq.current) return;
        setStockResult(payload);
        if (payload.stock?.code && (payload.items?.length || 0) > 0) {
          // 有结果时不自动跳转，等用户点日期
        }
      } catch (e) {
        if (seq !== stockReqSeq.current) return;
        setStockResult({
          query: q,
          items: [],
          count: 0,
          error: e instanceof Error ? e.message : "网络错误",
        });
      } finally {
        if (seq === stockReqSeq.current) setStockLoading(false);
      }
    },
    [],
  );

  const jumpToDate = useCallback(
    (ymd: string, code: string) => {
      setMode("ladder");
      setActiveConcept(null);
      setKw("");
      setHighlightCode(code);
      setDateSafe(ymd);
    },
    [setDateSafe],
  );

  const clearStockSearch = useCallback(() => {
    setStockKw("");
    setStockOptions([]);
    setStockResult(null);
    setHighlightCode(null);
  }, []);

  const onStockSuggest = useCallback((text: string) => {
    setStockKw(text);
    if (stockSearchTimer.current) window.clearTimeout(stockSearchTimer.current);
    const q = text.trim();
    if (!q) {
      setStockOptions([]);
      return;
    }
    stockSearchTimer.current = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/stocks/search?q=${encodeURIComponent(q)}&limit=12`,
        );
        if (!res.ok) return;
        const payload = (await res.json()) as { items: StockSuggest[] };
        setStockOptions(
          (payload.items || []).map((it) => ({
            value: `${it.code} ${it.name}`,
            label: `${it.market || ""} ${it.code} ${it.name}`.trim(),
            item: it,
          })),
        );
      } catch {
        setStockOptions([]);
      }
    }, 220);
  }, []);

  useEffect(() => {
    return () => {
      if (stockSearchTimer.current) window.clearTimeout(stockSearchTimer.current);
    };
  }, []);

  const renderStockChip = (gKey: string, s: StockItem) => {
    const jumpHit = highlighting && s.code === highlightCode;
    const nameHit = nameSearching && !!nameHitCodes?.has(s.code);
    const hit = jumpHit || nameHit;
    const dim = ladderSearching && !hit;
    return (
      <StockChip
        key={`${gKey}-${s.code}`}
        stock={s}
        onClick={onRowClick}
        onOpenChart={setChartStock}
        hit={hit}
        dim={dim}
        chipRef={jumpHit ? (el) => { hitChipRef.current = el; } : undefined}
      />
    );
  };

  return (
    <div className="history-panel" ref={panelRef}>
      <div className="history-toolbar">
        <div className="history-date-nav">
          <Button
            type="text"
            icon={<LeftOutlined />}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDateSafe(shiftTradeDay(date, -1));
            }}
            title="上一交易日"
          />
          <DatePicker
            value={dateValue}
            allowClear={false}
            inputReadOnly
            disabledDate={(d) => !d || d.isAfter(dayjs(), "day") || d.day() === 0 || d.day() === 6}
            onChange={(d) => {
              if (!d || !d.isValid()) return;
              setDateSafe(toYmd(d));
            }}
            format="YYYY-MM-DD"
            getPopupContainer={() => panelRef.current || document.body}
          />
          <Button
            type="text"
            icon={<RightOutlined />}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDateSafe(shiftTradeDay(date, 1));
            }}
            disabled={!canNext}
            title="下一交易日"
          />
        </div>
        <div className="history-summary-inline">
          <span>
            涨停 <em className="up">{ztCount}</em>
          </span>
          <span className="muted">{dateLabel}</span>
          <span className="muted" title="开盘啦个股/板块复盘约 15:05 更新，龙虎榜约 17:00">
            开盘啦
          </span>
        </div>
        <div className="history-stock-search">
          <Input
            style={{ width: 200 }}
            allowClear
            prefix={<SearchOutlined />}
            placeholder="名称 / 首字母，如 中 或 zg"
            value={nameKw}
            onChange={(e) => setNameKw(e.target.value)}
            title="当日连板模糊高亮，规则同实时监控连板天梯"
          />
          {nameSearching ? (
            <span className="filter-count">高亮 {nameHitCodes?.size ?? 0} 只</span>
          ) : null}
          <AutoComplete
            style={{ width: 220 }}
            options={stockOptions}
            value={stockKw}
            onSearch={onStockSuggest}
            onSelect={(_, opt) => {
              const item = (
                opt as { item?: StockSuggest } | undefined
              )?.item;
              if (!item) return;
              setStockKw(item.name);
              setStockOptions([]);
              void runStockSearch(item.name, item.code);
            }}
            onClear={() => clearStockSearch()}
            placeholder="代码/名称查涨停"
            allowClear
          >
            <Input
              prefix={<SearchOutlined />}
              onPressEnter={() => {
                const q = stockKw.trim();
                if (!q) return;
                const exact = stockOptions.find(
                  (o) =>
                    o.item.code === q ||
                    o.item.name === q ||
                    o.value === q,
                );
                void runStockSearch(
                  exact?.item.name || q,
                  exact?.item.code,
                );
              }}
            />
          </AutoComplete>
          <Button
            type="primary"
            loading={stockLoading}
            onClick={() => {
              const q = stockKw.trim();
              if (!q) return;
              const exact = stockOptions.find(
                (o) =>
                  o.item.code === q ||
                  o.item.name === q ||
                  o.value === q,
              );
              void runStockSearch(exact?.item.name || q, exact?.item.code);
            }}
          >
            查涨停
          </Button>
          <Input
            style={{ width: 160 }}
            allowClear
            placeholder="搜索涨停原因"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
          />
        </div>
      </div>

      {stockResult ? (
        <div className="history-stock-result">
          <div className="history-stock-result-head">
            <div className="history-stock-result-title">
              {stockResult.stock ? (
                <>
                  {stockResult.stock.name}
                  <span className="muted">{stockResult.stock.code}</span>
                  <span className="muted">历史涨停 {stockResult.count} 次</span>
                  {stockResult.stock.former_names?.length ? (
                    <span className="muted">
                      曾用名 {stockResult.stock.former_names.slice(0, 3).join(" / ")}
                    </span>
                  ) : null}
                </>
              ) : stockResult.need_select ? (
                <>请选择个股</>
              ) : (
                <>个股搜索</>
              )}
            </div>
            <Button size="small" type="link" onClick={clearStockSearch}>
              关闭
            </Button>
          </div>

          <Spin spinning={stockLoading}>
            {stockResult.error ? (
              <Empty description={stockResult.error} />
            ) : stockResult.need_select && (stockResult.matches?.length || 0) > 0 ? (
              <div className="history-stock-matches">
                {(stockResult.matches || []).map((m: StockZtHistoryMatch) => (
                  <Button
                    key={m.code}
                    size="small"
                    onClick={() => {
                      setStockKw(m.name);
                      void runStockSearch(m.name, m.code);
                    }}
                  >
                    {m.name}
                    <Tag style={{ marginInlineStart: 6 }}>{m.code}</Tag>
                    {m.match_via === "former" ? (
                      <Tag color="orange">曾用名</Tag>
                    ) : null}
                  </Button>
                ))}
              </div>
            ) : !(stockResult.items?.length || 0) ? (
              <Empty description="未找到该股历史涨停记录" />
            ) : (
              <div className="history-stock-date-list">
                {stockResult.items.map((it) => (
                  <button
                    key={it.date}
                    type="button"
                    className="history-stock-date-row"
                    title="进入当日连板梯队并高亮"
                    onClick={() => {
                      const code = stockResult.stock?.code;
                      if (!code) return;
                      jumpToDate(it.date, code);
                    }}
                  >
                    <span>{it.date_label}</span>
                    <span className="board">{it.board_label}</span>
                    <span className="reason">{it.reason || "—"}</span>
                  </button>
                ))}
              </div>
            )}
          </Spin>
        </div>
      ) : null}

      {highlightCode ? (
        <div className="history-tabs" style={{ paddingTop: 4, paddingBottom: 0 }}>
          <span className="filter-count">
            已高亮 {stockResult?.stock?.name || highlightCode}
          </span>
          <Button size="small" type="link" onClick={() => setHighlightCode(null)}>
            清除高亮
          </Button>
        </div>
      ) : null}

      <Spin spinning={loading}>
        {!loading && !(data?.count || 0) ? (
          <Empty
            style={{ marginTop: 48 }}
            description={data?.error || "该日暂无涨停数据（或非交易日）"}
          />
        ) : (
          <>
            <div className="kpl-concept-strip">
              {conceptGroups.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className={
                    activeConcept === g.label
                      ? "kpl-concept-card active"
                      : "kpl-concept-card"
                  }
                  onClick={() =>
                    setActiveConcept((prev) => (prev === g.label ? null : g.label))
                  }
                >
                  <div className="kpl-concept-title">
                    {g.label} <span>({g.count})</span>
                  </div>
                  <div className="kpl-concept-amt">
                    成交额 {formatMoney(g.amount || 0)}
                  </div>
                </button>
              ))}
            </div>

            <div className="history-tabs">
              <Segmented
                value={mode}
                onChange={(v) => setMode(v as ViewMode)}
                options={[
                  { label: "连板梯队", value: "ladder" },
                  { label: "概念明细", value: "concept" },
                ]}
              />
              {activeConcept ? (
                <Button size="small" type="link" onClick={() => setActiveConcept(null)}>
                  清除概念筛选：{activeConcept}
                </Button>
              ) : null}
            </div>

            {mode === "ladder" ? (
              <div className="kpl-ladder">
                {boardGroups.map((g) => (
                  <div key={g.key} className="kpl-ladder-row">
                    <div className="kpl-ladder-label">
                      <div>{g.label}</div>
                      <div className="muted">{g.count}只</div>
                      <div className={g.avg_change_pct >= 0 ? "up" : "down"}>
                        {formatPct(g.avg_change_pct)}
                      </div>
                    </div>
                    <div className="kpl-ladder-cells">
                      {g.stocks.map((s) => renderStockChip(g.key, s))}
                    </div>
                  </div>
                ))}
                {!boardGroups.length ? (
                  <Empty description="无匹配的连板数据" />
                ) : null}
              </div>
            ) : (
              <div className="kpl-concept-detail">
                {detailGroup ? (
                  <>
                    <div className="kpl-detail-head">
                      {detailGroup.label}（{detailGroup.count}）· 成交额{" "}
                      {formatMoney(detailGroup.amount || 0)}
                    </div>
                    <MonitorTable
                      data={detailGroup.stocks}
                      columns={displayCols}
                      onRowClick={onRowClick}
                      selectedCode={highlightCode || selectedCode}
                      onOpenChart={setChartStock}
                      scrollY={420}
                    />
                  </>
                ) : (
                  conceptGroups.map((g) => (
                    <div key={g.key} className="kpl-concept-block">
                      <button
                        type="button"
                        className="kpl-detail-head linkish"
                        onClick={() => setActiveConcept(g.label)}
                      >
                        {g.label}（{g.count}）· 成交额 {formatMoney(g.amount || 0)} ·{" "}
                        {formatPct(g.avg_change_pct)}
                      </button>
                      <div className="kpl-ladder-cells">
                        {g.stocks.map((s) => renderStockChip(g.key, s))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </Spin>

      <StockChartModal
        stock={chartStock}
        open={!!chartStock}
        onClose={() => setChartStock(null)}
        asOfDate={date}
      />
    </div>
  );
}
