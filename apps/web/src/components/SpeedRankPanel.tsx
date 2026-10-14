import { Input } from "antd";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { mergeRows, quoteListSignature } from "../lib/stockRows";
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
  const seq = useRef(0);
  const sigRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const rowsRef = useRef<StockItem[]>([]);
  const filteredRef = useRef<StockItem[]>([]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const refresh = useCallback(async () => {
    // 不取消进行中的请求：慢成功不应被下一轮 abort 掉；用序号丢弃过期回包
    const my = ++seq.current;
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/market/speed?limit=50", {
        signal: ac.signal,
      });
      if (!res.ok || my !== seq.current) return;
      const data = (await res.json()) as {
        items: StockItem[];
        updated_at?: string;
      };
      const items = data.items || [];
      // 空结果：保留已有列表，只刷新时间戳（若有）
      if (!items.length) {
        if (data.updated_at && my === seq.current && rowsRef.current.length) {
          setUpdated(data.updated_at.slice(11));
        }
        return;
      }
      const sig = quoteListSignature(items);
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        startTransition(() => {
          setRows((prev) => mergeRows(prev, items, { keepOnEmpty: true }));
        });
      }
      if (data.updated_at && my === seq.current) {
        setUpdated(data.updated_at.slice(11));
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      /* keep previous */
    }
  }, []);

  useEffect(() => {
    seq.current += 1;
    sigRef.current = "";
    void refresh();
    if (timer.current) window.clearInterval(timer.current);
    const ms = Math.max(500, Math.round((pollSec || 1.5) * 1000));
    timer.current = window.setInterval(() => void refresh(), ms);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      abortRef.current?.abort();
      seq.current += 1;
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
    const next = !q
      ? rows
      : rows.filter(
          (s) =>
            s.code.includes(q) ||
            (s.name || "").toLowerCase().includes(q) ||
            (s.industry || "").toLowerCase().includes(q),
        );
    if (
      filteredRef.current.length === next.length &&
      next.every((r, i) => r === filteredRef.current[i])
    ) {
      return filteredRef.current;
    }
    filteredRef.current = next;
    return next;
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
