import { Button, Input, Segmented, Space, message } from "antd";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BOARD_TAB_OPTIONS,
  type BoardBucket,
} from "../lib/boardBucket";
import { mergeRows, quoteListSignature } from "../lib/stockRows";
import { filterStItems } from "../lib/stStock";
import { loadAlertlist, saveAlertlist } from "../lib/watchlist";
import type { StockItem } from "../types";
import { MonitorTable } from "./MonitorTable";
import {
  applySpeedFilter,
  EMPTY_SPEED_FILTER,
  SpeedFilterBar,
  type SpeedFilter,
} from "./SpeedFilterBar";
import { StockChartModal } from "./StockChartModal";

const SPEED_LIMIT = 50;

export function SpeedRankPanel({
  columns,
  onRowClick,
  selectedCode,
  pollSec = 1.5,
  showStStocks = true,
}: {
  columns: string[];
  onRowClick: (s: StockItem) => void;
  selectedCode?: string | null;
  pollSec?: number;
  showStStocks?: boolean;
}) {
  const [board, setBoard] = useState<BoardBucket>("main");
  const [rows, setRows] = useState<StockItem[]>([]);
  const [kw, setKw] = useState("");
  const [filter, setFilter] = useState<SpeedFilter>(EMPTY_SPEED_FILTER);
  const [updated, setUpdated] = useState("");
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const timer = useRef<number | null>(null);
  /** 仅在换板/卸载时递增，用于作废进行中的请求 */
  const genRef = useRef(0);
  const busyRef = useRef(false);
  const sigRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const rowsRef = useRef<StockItem[]>([]);
  const filteredRef = useRef<StockItem[]>([]);
  const boardRef = useRef(board);
  boardRef.current = board;

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const refresh = useCallback(async () => {
    // 串行轮询：上一轮未完成则跳过，避免叠请求后用序号把有效回包全部丢掉
    if (busyRef.current) return;
    busyRef.current = true;
    const boardAtStart = boardRef.current;
    const gen = genRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    const timeoutId = window.setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(
        `/api/market/speed?limit=${SPEED_LIMIT}&board=${encodeURIComponent(boardAtStart)}`,
        { signal: ac.signal },
      );
      if (!res.ok || gen !== genRef.current || boardRef.current !== boardAtStart) return;
      const data = (await res.json()) as {
        items: StockItem[];
        updated_at?: string;
      };
      if (gen !== genRef.current || boardRef.current !== boardAtStart) return;
      // 前端再兜底：只要涨速>0，并按涨速从大到小
      const items = (data.items || [])
        .filter((s) => Number(s.speed ?? 0) > 0)
        .sort((a, b) => Number(b.speed ?? 0) - Number(a.speed ?? 0));
      // 空结果：保留已有列表，只刷新时间戳（若有）
      if (!items.length) {
        if (data.updated_at && rowsRef.current.length) {
          setUpdated(data.updated_at.slice(11));
        }
        return;
      }
      // 始终 merge：慢字段可能在行情不变时由后台补齐
      startTransition(() => {
        setRows((prev) => {
          const merged = mergeRows(prev, items, { keepOnEmpty: true });
          const next = [...merged]
            .filter((s) => Number(s.speed ?? 0) > 0)
            .sort((a, b) => Number(b.speed ?? 0) - Number(a.speed ?? 0));
          const sig = quoteListSignature(next);
          if (sig === sigRef.current && next.every((r, i) => r === prev[i])) {
            return prev;
          }
          sigRef.current = sig;
          return next;
        });
      });
      if (data.updated_at) {
        setUpdated(data.updated_at.slice(11));
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      /* keep previous */
    } finally {
      window.clearTimeout(timeoutId);
      if (abortRef.current === ac) abortRef.current = null;
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    genRef.current += 1;
    busyRef.current = false;
    sigRef.current = "";
    setRows([]);
    setSelectedKeys([]);
    void refresh();
    if (timer.current) window.clearInterval(timer.current);
    const ms = Math.max(500, Math.round((pollSec || 1.5) * 1000));
    timer.current = window.setInterval(() => void refresh(), ms);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      abortRef.current?.abort();
      genRef.current += 1;
      busyRef.current = false;
    };
  }, [pollSec, refresh, board]);

  const baseRows = useMemo(
    () => filterStItems(rows, showStStocks),
    [rows, showStStocks],
  );

  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    const byKw = !q
      ? baseRows
      : baseRows.filter(
          (s) =>
            s.code.includes(q) ||
            (s.name || "").toLowerCase().includes(q) ||
            (s.industry || "").toLowerCase().includes(q),
        );
    const next = applySpeedFilter(byKw, filter);
    if (
      filteredRef.current.length === next.length &&
      next.every((r, i) => r === filteredRef.current[i])
    ) {
      return filteredRef.current;
    }
    filteredRef.current = next;
    return next;
  }, [baseRows, kw, filter]);

  const addToAlert = useCallback(async () => {
    if (!selectedKeys.length || adding) return;
    setAdding(true);
    try {
      const cur = await loadAlertlist();
      const exist = new Set(cur.codes);
      const add = selectedKeys.filter((c) => !exist.has(c));
      if (!add.length) {
        message.info("所选股票已在异动播报中");
        return;
      }
      await saveAlertlist([...cur.codes, ...add], cur.pinned);
      message.success(`已添加 ${add.length} 只到异动播报`);
      setSelectedKeys([]);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "添加失败");
    } finally {
      setAdding(false);
    }
  }, [selectedKeys, adding]);

  return (
    <div className="speed-panel">
      <div className="watch-toolbar">
        <Segmented
          size="small"
          value={board}
          options={BOARD_TAB_OPTIONS}
          onChange={(v) => setBoard(v as BoardBucket)}
        />
        <Input
          style={{ width: 180 }}
          allowClear
          placeholder="搜索涨速榜"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
        <Space size={8}>
          <Button
            type="primary"
            size="small"
            disabled={!selectedKeys.length}
            loading={adding}
            onClick={() => void addToAlert()}
          >
            加入异动播报{selectedKeys.length ? ` (${selectedKeys.length})` : ""}
          </Button>
          {selectedKeys.length ? (
            <Button size="small" onClick={() => setSelectedKeys([])}>
              清除选择
            </Button>
          ) : null}
        </Space>
        <span className="filter-count">
          前 {SPEED_LIMIT} · {filtered.length} 只
          {updated ? ` · 更新 ${updated}` : ""}
          <span className="muted"> · 涨速降序 · 已隐藏涨停/负涨速</span>
        </span>
      </div>
      <SpeedFilterBar
        value={filter}
        onChange={setFilter}
        resultCount={filtered.length}
        totalCount={baseRows.length}
      />
      <MonitorTable
        data={filtered}
        columns={columns}
        onRowClick={onRowClick}
        selectedCode={selectedCode}
        onOpenChart={setChartStock}
        preserveScroll
        selectedRowKeys={selectedKeys}
        onSelectedRowKeysChange={setSelectedKeys}
        showNameBoardMarks
      />
      <StockChartModal
        stock={chartStock}
        open={!!chartStock}
        onClose={() => setChartStock(null)}
      />
    </div>
  );
}
