import { AutoComplete, Button, Input, Space, message } from "antd";
import { DeleteOutlined, PushpinFilled, PushpinOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadWatchlist, saveWatchlist } from "../lib/watchlist";
import type { StockItem } from "../types";
import { MonitorTable } from "./MonitorTable";
import { StockChartModal } from "./StockChartModal";

type Suggest = { code: string; name: string; market: string };

function rowEqual(a: StockItem, b: StockItem): boolean {
  return (
    a.code === b.code &&
    a.name === b.name &&
    a.price === b.price &&
    a.change_pct === b.change_pct &&
    a.amount === b.amount &&
    a.volume === b.volume &&
    a.seal_amount === b.seal_amount &&
    a.float_mv === b.float_mv &&
    a.total_mv === b.total_mv &&
    a.turnover === b.turnover &&
    a.first_seal_time === b.first_seal_time &&
    a.last_seal_time === b.last_seal_time &&
    a.break_time === b.break_time &&
    a.board_count === b.board_count &&
    a.open_times === b.open_times &&
    a.board_tag === b.board_tag &&
    a.status === b.status &&
    a.industry === b.industry &&
    a.region === b.region &&
    a.speed === b.speed &&
    a.reason === b.reason &&
    a.risk_hint === b.risk_hint &&
    (a.concepts || []).join("|") === (b.concepts || []).join("|") &&
    (a.risk_tags || []).join("|") === (b.risk_tags || []).join("|")
  );
}

function mergeRows(prev: StockItem[], next: StockItem[]): StockItem[] {
  const prevMap = new Map(prev.map((r) => [r.code, r]));
  return next.map((row) => {
    const old = prevMap.get(row.code);
    if (old && rowEqual(old, row)) return old;
    return row;
  });
}

export function WatchlistPanel({
  columns,
  onRowClick,
  selectedCode,
  pollSec = 2.5,
}: {
  columns: string[];
  onRowClick: (s: StockItem) => void;
  selectedCode?: string | null;
  pollSec?: number;
}) {
  const [codes, setCodes] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<StockItem[]>([]);
  const [filterKw, setFilterKw] = useState("");
  const [addKw, setAddKw] = useState("");
  const [options, setOptions] = useState<{ value: string; label: string; item: Suggest }[]>([]);
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const timer = useRef<number | null>(null);
  const searchTimer = useRef<number | null>(null);
  const pinSet = useMemo(() => new Set(pinned), [pinned]);

  useEffect(() => {
    let cancelled = false;
    void loadWatchlist().then((data) => {
      if (cancelled) return;
      setCodes(data.codes);
      setPinned(data.pinned);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (nextCodes: string[], nextPinned: string[]) => {
    setCodes(nextCodes);
    setPinned(nextPinned);
    try {
      const saved = await saveWatchlist(nextCodes, nextPinned);
      setCodes(saved.codes);
      setPinned(saved.pinned);
    } catch {
      message.error("观察列表保存失败");
    }
  }, []);

  const refresh = useCallback(async (list: string[]) => {
    if (!list.length) {
      setRows([]);
      return;
    }
    try {
      const res = await fetch(`/api/stocks/batch?codes=${list.join(",")}`);
      if (!res.ok) return;
      const data = (await res.json()) as { items: StockItem[] };
      const items = data.items || [];
      setRows((prev) => mergeRows(prev, items));
    } catch {
      /* keep previous */
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refresh(codes);
    if (timer.current) window.clearInterval(timer.current);
    const ms = Math.max(1000, Math.round((pollSec || 2.5) * 1000));
    timer.current = window.setInterval(() => void refresh(codes), ms);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [codes, pollSec, ready, refresh]);

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
      message.info("已在观察列表中");
      return;
    }
    void persist([...codes, item.code], pinned);
    setAddKw("");
    setOptions([]);
    message.success(`已添加 ${item.name}`);
  };

  const removeStock = useCallback(
    (code: string) => {
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

  const filtered = useMemo(() => {
    const kw = filterKw.trim().toLowerCase();
    let list = rows;
    if (kw) {
      list = rows.filter(
        (s) =>
          s.code.includes(kw) ||
          (s.name || "").toLowerCase().includes(kw) ||
          (s.industry || "").toLowerCase().includes(kw),
      );
    }
    // 置顶优先（与 codes 序一致）
    const order = new Map(codes.map((c, i) => [c, i]));
    return [...list].sort((a, b) => {
      const ap = pinSet.has(a.code) ? 0 : 1;
      const bp = pinSet.has(b.code) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999);
    });
  }, [rows, filterKw, codes, pinSet]);

  const onOpenChart = useCallback((s: StockItem) => {
    setChartStock(s);
  }, []);

  const extraActions = useCallback(
    (s: StockItem): ReactNode => (
      <span className="watch-actions">
        <Button
          type="text"
          size="small"
          icon={pinSet.has(s.code) ? <PushpinFilled /> : <PushpinOutlined />}
          title={pinSet.has(s.code) ? "取消置顶" : "置顶"}
          onClick={(e) => {
            e.stopPropagation();
            togglePin(s.code);
          }}
        />
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          title="移出观察"
          onClick={(e) => {
            e.stopPropagation();
            removeStock(s.code);
          }}
        />
      </span>
    ),
    [pinSet, togglePin, removeStock],
  );

  return (
    <div className="watch-panel">
      <div className="watch-toolbar">
        <Space wrap>
          <AutoComplete
            style={{ width: 280 }}
            options={options}
            value={addKw}
            onSearch={onSearchSuggest}
            onSelect={(_, opt) => {
              if (opt?.item) addStock(opt.item);
            }}
            placeholder="输入代码/名称添加观察股"
            allowClear
          />
          <Input
            style={{ width: 200 }}
            allowClear
            placeholder="搜索列表"
            value={filterKw}
            onChange={(e) => setFilterKw(e.target.value)}
          />
          <span className="filter-count">
            {filtered.length}/{codes.length}
          </span>
        </Space>
      </div>

      <MonitorTable
        data={filtered}
        columns={columns}
        onRowClick={onRowClick}
        selectedCode={selectedCode}
        onOpenChart={onOpenChart}
        extraActions={extraActions}
        rowClassName={(r) =>
          [
            r.code === selectedCode ? "monitor-row-selected" : "",
            pinSet.has(r.code) ? "monitor-row-pinned" : "",
          ]
            .filter(Boolean)
            .join(" ")
        }
      />

      <StockChartModal
        stock={chartStock}
        open={!!chartStock}
        onClose={() => setChartStock(null)}
      />
    </div>
  );
}
