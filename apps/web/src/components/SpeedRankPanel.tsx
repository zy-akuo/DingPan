import { Input } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StockItem } from "../types";
import { MonitorTable } from "./MonitorTable";
import { StockChartModal } from "./StockChartModal";

export function SpeedRankPanel({
  columns,
  onRowClick,
  selectedCode,
  pollSec = 1.5,
}: {
  columns: string[];
  onRowClick: (s: StockItem) => void;
  selectedCode?: string | null;
  pollSec?: number;
}) {
  const [rows, setRows] = useState<StockItem[]>([]);
  const [kw, setKw] = useState("");
  const [updated, setUpdated] = useState("");
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const timer = useRef<number | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch("/api/market/speed?limit=50");
      if (!res.ok) return;
      const data = (await res.json()) as { items: StockItem[]; updated_at?: string };
      setRows(data.items || []);
      if (data.updated_at) setUpdated(data.updated_at.slice(11));
    } catch {
      /* keep */
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (timer.current) window.clearInterval(timer.current);
    const ms = Math.max(500, Math.round((pollSec || 1.5) * 1000));
    timer.current = window.setInterval(() => void refresh(), ms);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [pollSec, refresh]);

  const displayCols = useMemo(() => {
    if (columns.includes("speed")) return columns;
    const idx = columns.indexOf("name");
    if (idx >= 0) {
      const next = [...columns];
      next.splice(idx + 1, 0, "speed");
      return next;
    }
    return ["speed", ...columns];
  }, [columns]);

  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (s) =>
        s.code.includes(q) ||
        (s.name || "").toLowerCase().includes(q) ||
        (s.industry || "").toLowerCase().includes(q),
    );
  }, [rows, kw]);

  return (
    <div className="speed-panel">
      <div className="watch-toolbar">
        <Input
          style={{ width: 220 }}
          allowClear
          placeholder="搜索涨速榜"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
        <span className="filter-count">
          {filtered.length} 只
          {updated ? ` · 更新 ${updated}` : ""}
        </span>
      </div>
      <MonitorTable
        data={filtered}
        columns={displayCols}
        onRowClick={onRowClick}
        selectedCode={selectedCode}
        onOpenChart={setChartStock}
      />
      <StockChartModal
        stock={chartStock}
        open={!!chartStock}
        onClose={() => setChartStock(null)}
      />
    </div>
  );
}
