import { Button, Input, Popover, Segmented, Space, message } from "antd";
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
import {
  addSpeedHidden,
  clearSpeedHidden,
  loadSpeedHidden,
  removeSpeedHidden,
  type SpeedHiddenEntry,
} from "../lib/speedHidden";
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

function relUpdateLabel(updatedAtMs: number, nowMs: number): string {
  if (!updatedAtMs) return "";
  const sec = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (sec < 1) return "刚刚";
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  return `${Math.floor(min / 60)}小时前`;
}

export function SpeedRankPanel({
  columns,
  onRowClick,
  selectedCode,
  pollSec = 1.5,
  showStStocks = true,
  hideRequest,
  onHideRequestHandled,
}: {
  columns: string[];
  onRowClick: (s: StockItem) => void;
  selectedCode?: string | null;
  pollSec?: number;
  showStStocks?: boolean;
  /** App 抽屉触发的隐藏请求 */
  hideRequest?: { code: string; name: string; token: number } | null;
  onHideRequestHandled?: () => void;
}) {
  const [board, setBoard] = useState<BoardBucket>("main");
  const [rows, setRows] = useState<StockItem[]>([]);
  const [kw, setKw] = useState("");
  const [filter, setFilter] = useState<SpeedFilter>(EMPTY_SPEED_FILTER);
  const [updatedAtMs, setUpdatedAtMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pulse, setPulse] = useState(false);
  const [liveOk, setLiveOk] = useState(true);
  const [failHint, setFailHint] = useState(false);
  const [boardLoading, setBoardLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [hiddenList, setHiddenList] = useState<SpeedHiddenEntry[]>(() =>
    loadSpeedHidden(),
  );
  const [hiddenOpen, setHiddenOpen] = useState(false);

  const timer = useRef<number | null>(null);
  const genRef = useRef(0);
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  const sigRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const rowsRef = useRef<StockItem[]>([]);
  const rowsBoardRef = useRef<BoardBucket>(board);
  const filteredRef = useRef<StockItem[]>([]);
  const boardRef = useRef(board);
  const failStreakRef = useRef(0);
  const pulseTimer = useRef<number | null>(null);
  boardRef.current = board;

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const hiddenCodes = useMemo(
    () => new Set(hiddenList.map((e) => e.code)),
    [hiddenList],
  );

  const hideStock = useCallback((code: string, name: string) => {
    const next = addSpeedHidden(code, name);
    setHiddenList(next);
    setSelectedKeys((keys) => keys.filter((k) => k !== code));
    message.success(`已从涨速榜隐藏 ${name || code}`);
  }, []);

  useEffect(() => {
    if (!hideRequest?.code) return;
    hideStock(hideRequest.code, hideRequest.name);
    onHideRequestHandled?.();
  }, [hideRequest, hideStock, onHideRequestHandled]);

  const triggerPulse = useCallback(() => {
    setPulse(true);
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setPulse(false), 480);
  }, []);

  const refresh = useCallback(async () => {
    if (busyRef.current) {
      pendingRef.current = true;
      return;
    }
    busyRef.current = true;
    const boardAtStart = boardRef.current;
    const gen = genRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    const timeoutId = window.setTimeout(() => ac.abort(), 8000);
    let outcome: "ok" | "abort" | "fail" = "fail";
    try {
      const res = await fetch(
        `/api/market/speed?limit=${SPEED_LIMIT}&board=${encodeURIComponent(boardAtStart)}`,
        { signal: ac.signal },
      );
      if (gen !== genRef.current || boardRef.current !== boardAtStart) {
        outcome = "abort";
        return;
      }
      if (!res.ok) {
        outcome = "fail";
        return;
      }
      const data = (await res.json()) as {
        items: StockItem[];
        updated_at?: string;
      };
      if (gen !== genRef.current || boardRef.current !== boardAtStart) {
        outcome = "abort";
        return;
      }

      const items = (data.items || [])
        .filter((s) => Number(s.speed ?? 0) > 0)
        .sort((a, b) => Number(b.speed ?? 0) - Number(a.speed ?? 0));
      const sameBoard = rowsBoardRef.current === boardAtStart;

      if (!items.length) {
        if (!sameBoard) {
          startTransition(() => {
            setRows([]);
            rowsBoardRef.current = boardAtStart;
            sigRef.current = "";
          });
        }
        setUpdatedAtMs(Date.now());
        triggerPulse();
        outcome = "ok";
        return;
      }

      startTransition(() => {
        setRows((prev) => {
          const merged = sameBoard
            ? mergeRows(prev, items, { keepOnEmpty: true })
            : items;
          const next = [...merged]
            .filter((s) => Number(s.speed ?? 0) > 0)
            .sort((a, b) => Number(b.speed ?? 0) - Number(a.speed ?? 0));
          rowsBoardRef.current = boardAtStart;
          const sig = quoteListSignature(next);
          if (
            sameBoard &&
            sig === sigRef.current &&
            next.every((r, i) => r === prev[i])
          ) {
            return prev;
          }
          sigRef.current = sig;
          return next;
        });
      });
      setUpdatedAtMs(Date.now());
      triggerPulse();
      outcome = "ok";
    } catch (e) {
      outcome =
        (e as { name?: string })?.name === "AbortError" ? "abort" : "fail";
    } finally {
      window.clearTimeout(timeoutId);
      if (abortRef.current === ac) abortRef.current = null;
      if (gen === genRef.current && boardRef.current === boardAtStart) {
        setBoardLoading(false);
        setInitialLoading(false);
        if (outcome === "ok") {
          failStreakRef.current = 0;
          setFailHint(false);
          setLiveOk(true);
        } else if (outcome === "fail") {
          failStreakRef.current += 1;
          if (failStreakRef.current >= 2) {
            setFailHint(true);
            setLiveOk(false);
          }
        }
      }
      busyRef.current = false;
      if (pendingRef.current && gen === genRef.current) {
        pendingRef.current = false;
        void refresh();
      } else {
        pendingRef.current = false;
      }
    }
  }, [triggerPulse]);

  useEffect(() => {
    genRef.current += 1;
    abortRef.current?.abort();
    busyRef.current = false;
    pendingRef.current = false;
    sigRef.current = "";
    setSelectedKeys([]);
    setBoardLoading(rowsRef.current.length > 0);
    if (!rowsRef.current.length) setInitialLoading(true);

    const run = () => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    };

    void refresh();
    if (timer.current) window.clearInterval(timer.current);
    const ms = Math.max(500, Math.round((pollSec || 1.5) * 1000));
    timer.current = window.setInterval(run, ms);

    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      if (timer.current) window.clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVis);
      abortRef.current?.abort();
      genRef.current += 1;
      busyRef.current = false;
      pendingRef.current = false;
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    };
  }, [pollSec, refresh, board]);

  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const baseRows = useMemo(() => {
    const st = filterStItems(rows, showStStocks);
    if (!hiddenCodes.size) return st;
    return st.filter((s) => !hiddenCodes.has(s.code));
  }, [rows, showStStocks, hiddenCodes]);

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

  const restoreOne = useCallback((code: string) => {
    setHiddenList(removeSpeedHidden(code));
    message.success("已恢复显示");
  }, []);

  const restoreAll = useCallback(() => {
    setHiddenList(clearSpeedHidden());
    setHiddenOpen(false);
    message.success("已清空隐藏列表");
  }, []);

  const rel = relUpdateLabel(updatedAtMs, nowMs);
  const showSkeleton = initialLoading && !filtered.length;

  const hiddenPopover = (
    <div className="speed-hidden-pop">
      {!hiddenList.length ? (
        <div className="muted">暂无隐藏股票</div>
      ) : (
        <>
          <div className="speed-hidden-list">
            {hiddenList.map((e) => (
              <div key={e.code} className="speed-hidden-row">
                <span className="speed-hidden-name">
                  {e.name}
                  <small>{e.code}</small>
                </span>
                <Button type="link" size="small" onClick={() => restoreOne(e.code)}>
                  恢复
                </Button>
              </div>
            ))}
          </div>
          <Button size="small" block danger onClick={restoreAll}>
            全部恢复
          </Button>
        </>
      )}
    </div>
  );

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
          <Popover
            content={hiddenPopover}
            title="已隐藏"
            trigger="click"
            open={hiddenOpen}
            onOpenChange={setHiddenOpen}
            placement="bottomLeft"
          >
            <Button size="small">
              已隐藏{hiddenList.length ? ` ${hiddenList.length}` : ""}
            </Button>
          </Popover>
        </Space>
        <span className="filter-count speed-live-status">
          <span
            className={`speed-live-dot${liveOk ? " is-ok" : " is-bad"}${pulse ? " is-pulse" : ""}`}
            title={liveOk ? "实时刷新中" : "刷新异常"}
          />
          前 {SPEED_LIMIT} · {filtered.length} 只
          {rel ? ` · 更新 ${rel}` : ""}
          {failHint ? (
            <span className="speed-fail-hint"> · 刷新失败 · 保留上次</span>
          ) : null}
          <span className="muted"> · 涨速降序 · 已隐藏涨停/负涨速</span>
        </span>
      </div>
      <SpeedFilterBar
        value={filter}
        onChange={setFilter}
        resultCount={filtered.length}
        totalCount={baseRows.length}
      />
      {showSkeleton ? (
        <div className="speed-skeleton" aria-busy="true">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="speed-skeleton-row">
              <span className="sk sk-name" />
              <span className="sk sk-num" />
              <span className="sk sk-num" />
              <span className="sk sk-wide" />
            </div>
          ))}
        </div>
      ) : (
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
          enableSpeedFlash
          emptyAsDots
          loadingOverlay={boardLoading}
        />
      )}
      <StockChartModal
        stock={chartStock}
        open={!!chartStock}
        onClose={() => setChartStock(null)}
      />
    </div>
  );
}
