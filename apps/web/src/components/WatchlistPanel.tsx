import { AutoComplete, Button, Input, Space, message } from "antd";
import { DeleteOutlined, PushpinFilled, PushpinOutlined } from "@ant-design/icons";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  mergeRows,
  quoteListSignature,
  stabilizeList,
} from "../lib/stockRows";
import { loadWatchlist, saveWatchlist } from "../lib/watchlist";
import type { StockItem } from "../types";
import { MonitorTable } from "./MonitorTable";
import { StockChartModal } from "./StockChartModal";

type Suggest = { code: string; name: string; market: string };

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
  const [options, setOptions] = useState<
    { value: string; label: string; item: Suggest }[]
  >([]);
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const timer = useRef<number | null>(null);
  const searchTimer = useRef<number | null>(null);
  const seq = useRef(0);
  const sigRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const codesRef = useRef<string[]>([]);
  const filteredRef = useRef<StockItem[]>([]);
  const pinSet = useMemo(() => new Set(pinned), [pinned]);

  useEffect(() => {
    codesRef.current = codes;
  }, [codes]);

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

  const refresh = useCallback(async (list?: string[]) => {
    const codesNow = list ?? codesRef.current;
    if (!codesNow.length) {
      sigRef.current = "";
      startTransition(() => setRows([]));
      return;
    }
    const my = ++seq.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(`/api/stocks/batch?codes=${codesNow.join(",")}`, {
        signal: ac.signal,
      });
      if (!res.ok || my !== seq.current) return;
      const data = (await res.json()) as { items: StockItem[] };
      const items = data.items || [];
      const sig = quoteListSignature(items);
      if (sig === sigRef.current) return;
      sigRef.current = sig;
      startTransition(() => {
        setRows((prev) => mergeRows(prev, items, { keepOnEmpty: true }));
      });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      /* keep previous */
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    seq.current += 1;
    sigRef.current = "";
    void refresh(codes);
    if (timer.current) window.clearInterval(timer.current);
    const ms = Math.max(500, Math.round((pollSec || 2.5) * 1000));
    timer.current = window.setInterval(() => void refresh(), ms);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      abortRef.current?.abort();
      seq.current += 1;
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
        const res = await fetch(
          `/api/stocks/search?q=${encodeURIComponent(q)}&limit=12`,
        );
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
    const order = new Map(codes.map((c, i) => [c, i]));
    const sorted = [...list].sort((a, b) => {
      const ap = pinSet.has(a.code) ? 0 : 1;
      const bp = pinSet.has(b.code) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999);
    });
    const stable = stabilizeList(filteredRef.current, sorted);
    filteredRef.current = stable;
    return stable;
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

  const rowClassName = useCallback(
    (r: StockItem) =>
      [
        r.code === selectedCode ? "monitor-row-selected" : "",
        pinSet.has(r.code) ? "monitor-row-pinned" : "",
      ]
        .filter(Boolean)
        .join(" "),
    [selectedCode, pinSet],
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
        rowClassName={rowClassName}
        preserveScroll
      />

      <StockChartModal
        stock={chartStock}
        open={!!chartStock}
        onClose={() => setChartStock(null)}
      />
    </div>
  );
}
