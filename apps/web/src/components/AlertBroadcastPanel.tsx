import {
  DeleteOutlined,
  LineChartOutlined,
  PushpinFilled,
  PushpinOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { AutoComplete, Button, Space, Switch, Table, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTableDragScroll } from "../hooks/useTableDragScroll";
import { loadAlertlist, saveAlertlist } from "../lib/watchlist";
import type { AlertEvent, FieldConfig, StockItem } from "../types";
import { ALERT_TYPE_LABELS, formatPct } from "../types";

function AlertTableDrag({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useTableDragScroll(ref);
  return (
    <div ref={ref} className="alert-table-drag">
      {children}
    </div>
  );
}

type Suggest = { code: string; name: string; market: string };

const TYPE_COLOR: Record<string, string> = {
  impact_zt: "var(--up)",
  seal_firm: "var(--up)",
  seal_drop: "var(--down)",
  seal_rise: "var(--up)",
  range_move: "var(--accent, #f59e0b)",
  zt_open: "var(--broken)",
  zt_smash: "var(--down)",
};

function toStockItem(partial: Partial<StockItem> & { code: string }): StockItem {
  return {
    code: partial.code,
    name: partial.name || partial.code,
    market: partial.market || "",
    price: partial.price ?? 0,
    change_pct: partial.change_pct ?? 0,
    amount: partial.amount ?? 0,
    volume: partial.volume ?? 0,
    float_mv: partial.float_mv ?? 0,
    total_mv: partial.total_mv ?? 0,
    turnover: partial.turnover ?? 0,
    seal_amount: partial.seal_amount ?? 0,
    first_seal_time: partial.first_seal_time || "",
    last_seal_time: partial.last_seal_time || "",
    board_count: partial.board_count ?? 1,
    open_times: partial.open_times ?? 0,
    industry: partial.industry || "",
    concepts: partial.concepts || [],
    zt_stats: partial.zt_stats || "",
    status: partial.status || "封",
    board_tag: partial.board_tag || "",
    region: partial.region || "",
    free_float_mv: partial.free_float_mv ?? null,
    top10_holder_pct: partial.top10_holder_pct ?? null,
    year_seal_rate: partial.year_seal_rate ?? null,
    year_board_rate: partial.year_board_rate ?? null,
  };
}

export function AlertBroadcastPanel({
  feed,
  fields,
  onToggleSpeech,
  onOpenSettings,
  onRowClick,
  onOpenChart,
  selectedCode,
}: {
  feed: AlertEvent[];
  fields: FieldConfig;
  onToggleSpeech: (v: boolean) => void;
  onOpenSettings: () => void;
  onRowClick: (s: StockItem) => void;
  onOpenChart: (s: StockItem) => void;
  selectedCode?: string | null;
}) {
  const [codes, setCodes] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<StockItem[]>([]);
  const [addKw, setAddKw] = useState("");
  const [options, setOptions] = useState<{ value: string; label: string; item: Suggest }[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const searchTimer = useRef<number | null>(null);
  const pollTimer = useRef<number | null>(null);
  const cacheRef = useRef<Map<string, StockItem>>(new Map());
  const pinSet = useMemo(() => new Set(pinned), [pinned]);

  useEffect(() => {
    let cancelled = false;
    void loadAlertlist().then((data) => {
      if (cancelled) return;
      setCodes(data.codes);
      setPinned(data.pinned);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshQuotes = useCallback(async (list: string[]) => {
    if (!list.length) {
      setRows([]);
      return;
    }
    try {
      const res = await fetch(`/api/stocks/batch?codes=${list.join(",")}`);
      if (!res.ok) return;
      const data = (await res.json()) as { items: StockItem[] };
      for (const it of data.items || []) {
        const prev = cacheRef.current.get(it.code);
        const merged = toStockItem({ ...prev, ...it });
        cacheRef.current.set(it.code, merged);
      }
    } catch {
      /* keep cache */
    }
    setRows(
      list.map((code) => {
        const hit = cacheRef.current.get(code);
        return hit || toStockItem({ code, name: code });
      }),
    );
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refreshQuotes(codes);
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    const sec = Math.max(0.5, fields.alert_speech_interval_sec ?? 1);
    pollTimer.current = window.setInterval(
      () => void refreshQuotes(codes),
      Math.round(sec * 1000),
    );
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [codes, ready, refreshQuotes, fields.alert_speech_interval_sec]);

  const onManualRefresh = useCallback(async () => {
    if (!codes.length) {
      message.info("请先添加监控股票");
      return;
    }
    setRefreshing(true);
    try {
      const [res] = await Promise.all([
        fetch("/api/alerts/refresh", { method: "POST" }),
        refreshQuotes(codes),
      ]);
      if (!res.ok) throw new Error(`刷新失败: ${res.status}`);
      const data = (await res.json()) as {
        ok?: boolean;
        count?: number;
        error?: string;
      };
      if (data.error && data.ok === false) {
        throw new Error(data.error);
      }
      const n = data.count ?? 0;
      if (n > 0) {
        message.success(`已刷新，发现 ${n} 条新异动`);
      } else {
        message.success("已刷新监控行情，暂无新异动");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }, [codes, refreshQuotes]);

  const persist = useCallback(async (nextCodes: string[], nextPinned: string[]) => {
    setCodes(nextCodes);
    setPinned(nextPinned);
    try {
      const saved = await saveAlertlist(nextCodes, nextPinned);
      setCodes(saved.codes);
      setPinned(saved.pinned);
    } catch {
      message.error("异动列表保存失败");
    }
  }, []);

  const onSearchSuggest = (text: string) => {
    setAddKw(text);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    const q = text.trim();
    if (!q) {
      setOptions([]);
      return;
    }
    searchTimer.current = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}&limit=12`);
        if (!res.ok) return;
        const data = (await res.json()) as { items: Suggest[] };
        setOptions(
          (data.items || []).map((it) => ({
            value: `${it.code} ${it.name}`,
            label: `${it.market || ""} ${it.code} ${it.name}`,
            item: it,
          })),
        );
      } catch {
        setOptions([]);
      }
    }, 220);
  };

  const addStock = (item: Suggest) => {
    if (codes.includes(item.code)) {
      message.info("已在异动列表中");
      return;
    }
    cacheRef.current.set(
      item.code,
      toStockItem({ code: item.code, name: item.name, market: item.market }),
    );
    void persist([...codes, item.code], pinned);
    setAddKw("");
    setOptions([]);
    message.success(`已添加 ${item.name}`);
  };

  const removeStock = useCallback(
    (code: string) => {
      cacheRef.current.delete(code);
      void persist(
        codes.filter((c) => c !== code),
        pinned.filter((c) => c !== code),
      );
    },
    [codes, pinned, persist],
  );

  const togglePin = useCallback(
    (code: string) => {
      if (pinSet.has(code)) {
        void persist(
          codes,
          pinned.filter((c) => c !== code),
        );
      } else {
        void persist(codes, [code, ...pinned.filter((c) => c !== code)]);
      }
    },
    [codes, pinned, persist, pinSet],
  );

  const sortedFeed = useMemo(() => {
    const list = [...(feed || [])];
    list.sort((a, b) => {
      const ap = pinSet.has(a.code) ? 0 : 1;
      const bp = pinSet.has(b.code) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (b.time || "").localeCompare(a.time || "");
    });
    return list;
  }, [feed, pinSet]);

  const eventCols: ColumnsType<AlertEvent> = useMemo(
    () => [
      {
        title: "名称",
        dataIndex: "name",
        width: 108,
        render: (v: string, r) => (
          <span className="alert-name-cell">
            {pinSet.has(r.code) ? <PushpinFilled className="alert-pin-icon" /> : null}
            {v}
          </span>
        ),
      },
      { title: "代码", dataIndex: "code", width: 78 },
      {
        title: "异动",
        dataIndex: "type",
        width: 96,
        render: (t: string) => (
          <span style={{ color: TYPE_COLOR[t] || "var(--text)", fontWeight: 600 }}>
            {ALERT_TYPE_LABELS[t] || t}
          </span>
        ),
      },
      {
        title: "板数",
        dataIndex: "board_label",
        width: 68,
        render: (v: string, r) => v || (r.board_count <= 1 ? "首板" : `${r.board_count}连板`),
      },
      { title: "时间", dataIndex: "time", width: 84 },
      { title: "详情", dataIndex: "detail", ellipsis: true },
      { title: "行业", dataIndex: "industry", width: 110, ellipsis: true },
    ],
    [pinSet],
  );

  const stockCols: ColumnsType<StockItem> = useMemo(
    () => [
      {
        title: "名称",
        dataIndex: "name",
        width: 88,
        ellipsis: true,
        render: (name: string, r) => (
          <div className="alert-stock-name">
            <div className="nm">
              {pinSet.has(r.code) ? <PushpinFilled className="alert-pin-icon" /> : null}
              {r.market ? <span className="mkt">{r.market}</span> : null}
              <span>{name || r.code}</span>
            </div>
            <div className="code">{r.code}</div>
          </div>
        ),
      },
      {
        title: "涨跌幅",
        dataIndex: "change_pct",
        width: 68,
        align: "right",
        render: (v: number) => (
          <span className={v >= 0 ? "up" : "down"}>{formatPct(v)}</span>
        ),
      },
      {
        title: "",
        key: "actions",
        width: 96,
        align: "right",
        render: (_, r) => (
          <Space size={0} onClick={(e) => e.stopPropagation()}>
            <Button
              type="text"
              size="small"
              className="name-chart-btn"
              icon={<LineChartOutlined />}
              title="查看分时/日K"
              onClick={() => onOpenChart(r)}
            />
            <Button
              type="text"
              size="small"
              icon={pinSet.has(r.code) ? <PushpinFilled /> : <PushpinOutlined />}
              title={pinSet.has(r.code) ? "取消置顶" : "置顶"}
              onClick={() => togglePin(r.code)}
            />
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              title="移除"
              onClick={() => removeStock(r.code)}
            />
          </Space>
        ),
      },
    ],
    [pinSet, togglePin, removeStock, onOpenChart],
  );

  const speechOn = fields.alert_speech_enabled !== false;

  return (
    <div className="alert-panel">
      <div className="alert-toolbar">
        <div className="alert-title-row">
          <div className="alert-title-left">
            <h3 className="alert-title">异动播报</h3>
            <Tag>{codes.length} 只监控</Tag>
          </div>
          <Space wrap>
            <AutoComplete
              className="alert-search"
              options={options}
              value={addKw}
              onSearch={onSearchSuggest}
              onSelect={(_, opt) => {
                if (opt?.item) addStock(opt.item);
              }}
              placeholder="输入代码/名称添加监控股"
              allowClear
              disabled={!ready}
            />
            <span className="muted">语音</span>
            <Switch checked={speechOn} onChange={onToggleSpeech} />
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={refreshing}
              disabled={!ready}
              onClick={() => void onManualRefresh()}
            >
              刷新
            </Button>
            <Button size="small" onClick={onOpenSettings}>
              设置
            </Button>
          </Space>
        </div>
      </div>

      <div className="alert-body">
        <div className="alert-stocks">
          <div className="alert-subhead">监控列表</div>
          <AlertTableDrag>
            <Table
              className="alert-stocks-table"
              size="small"
              rowKey="code"
              pagination={false}
              dataSource={rows}
              columns={stockCols}
              scroll={{ y: "calc(100vh - 300px)", x: 280 }}
              locale={{ emptyText: "请添加要监控的股票" }}
              rowClassName={(r) =>
                [
                  pinSet.has(r.code) ? "monitor-row-pinned" : "",
                  r.code === selectedCode ? "monitor-row-selected" : "",
                  "alert-stock-row",
                ]
                  .filter(Boolean)
                  .join(" ")
              }
              onRow={(record) => ({
                onClick: () => onRowClick(record),
              })}
            />
          </AlertTableDrag>
        </div>
        <div className="alert-feed">
          <div className="alert-subhead">事件流水</div>
          <AlertTableDrag>
            <Table
              className="alert-feed-table"
              size="small"
              rowKey={(r, i) => `${r.type}-${r.code}-${r.time}-${r.detail}-${i}`}
              pagination={false}
              dataSource={sortedFeed}
              columns={eventCols}
              scroll={{ y: "calc(100vh - 300px)", x: 760 }}
              locale={{ emptyText: codes.length ? "等待异动…" : "添加股票后开始监控" }}
            />
          </AlertTableDrag>
        </div>
      </div>
    </div>
  );
}
