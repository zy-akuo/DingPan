import { AutoComplete, Button, Input, Space, message } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<StockItem[]>([]);
  const [filterKw, setFilterKw] = useState("");
  const [addKw, setAddKw] = useState("");
  const [options, setOptions] = useState<{ value: string; label: string; item: Suggest }[]>([]);
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const timer = useRef<number | null>(null);
  const searchTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadWatchlist().then((list) => {
      if (cancelled) return;
      setCodes(list);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: string[]) => {
    setCodes(next);
    try {
      const saved = await saveWatchlist(next);
      setCodes(saved);
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
      setRows(data.items || []);
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
    void persist([...codes, item.code]);
    setAddKw("");
    setOptions([]);
    message.success(`已添加 ${item.name}`);
  };

  const removeStock = (code: string) => {
    void persist(codes.filter((c) => c !== code));
  };

  const filtered = useMemo(() => {
    const kw = filterKw.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter(
      (s) =>
        s.code.includes(kw) ||
        (s.name || "").toLowerCase().includes(kw) ||
        (s.industry || "").toLowerCase().includes(kw),
    );
  }, [rows, filterKw]);

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
        onOpenChart={setChartStock}
        extraActions={(s) => (
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
        )}
      />

      <StockChartModal
        stock={chartStock}
        open={!!chartStock}
        onClose={() => setChartStock(null)}
      />
    </div>
  );
}
