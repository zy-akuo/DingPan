import { MoonOutlined, SettingOutlined, SunOutlined } from "@ant-design/icons";
import { Button, ConfigProvider, Segmented, Tabs, Tag, theme as antTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { LadderView } from "./components/LadderView";
import {
  applyMonitorFilter,
  collectRegions,
  EMPTY_FILTER,
  MonitorFilterBar,
  type MonitorFilter,
} from "./components/MonitorFilterBar";
import { HistoryBackPanel, resolveHistoryDate } from "./components/HistoryBackPanel";
import { MonitorTable } from "./components/MonitorTable";
import { RiskPanel } from "./components/RiskPanel";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { SpeedRankPanel } from "./components/SpeedRankPanel";
import { StockChartModal } from "./components/StockChartModal";
import { StockDetailDrawer } from "./components/StockDetailDrawer";
import { SummaryBar } from "./components/SummaryBar";
import { WatchlistPanel } from "./components/WatchlistPanel";
import { useMarketSocket } from "./hooks/useMarketSocket";
import { useSpeech } from "./hooks/useSpeech";
import { cacheGet, cachePurgeExpired, cacheSet } from "./lib/localCache";
import { applyThemeToDom, loadTheme, saveTheme, type ThemeMode } from "./lib/theme";
import type { FieldConfig, StockItem, UserConfig } from "./types";
import { tradeDateLabel } from "./types";
import "./App.css";

const defaultFields: FieldConfig = {
  table_columns: [
    "name",
    "board",
    "first_seal_time",
    "seal_amount",
    "amount",
    "volume",
    "float_mv",
    "concepts",
  ],
  detail_fields: [
    "price",
    "total_mv",
    "float_mv",
    "free_float_mv",
    "top10_holder_pct",
    "year_seal_rate",
    "year_board_rate",
    "volume",
    "amount",
    "concepts",
    "region",
    "industry",
  ],
  speech_enabled: false,
  speech_mode: "realtime",
  speech_types: ["zt", "lb", "zb"],
  poll_interval_sec: 2.5,
  speed_poll_interval_sec: 1.5,
  ladder_show_times: true,
};

type MainTab = "monitor" | "ladder" | "watch" | "speed" | "history" | "risk";

function findPoolTab(
  snapshot: { zt: StockItem[]; lb: StockItem[]; zb: StockItem[]; dt: StockItem[] },
  code: string,
  fallbackStatus?: string,
): string {
  if (snapshot.zb.some((s) => s.code === code)) return "zb";
  if (snapshot.lb.some((s) => s.code === code)) return "lb";
  if (snapshot.dt.some((s) => s.code === code)) return "dt";
  if (snapshot.zt.some((s) => s.code === code)) return "zt";
  if (fallbackStatus === "炸") return "zb";
  if (fallbackStatus === "成" || fallbackStatus === "封") return "zt";
  return "zt";
}

export default function App() {
  const [fields, setFields] = useState<FieldConfig>(defaultFields);
  const [available, setAvailable] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detail, setDetail] = useState<StockItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [poolTab, setPoolTab] = useState("zt");
  const [mainTab, setMainTab] = useState<MainTab>("monitor");
  const [historyDate, setHistoryDate] = useState(() => resolveHistoryDate());
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [filter, setFilter] = useState<MonitorFilter>(EMPTY_FILTER);
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadTheme());
  const [, startTransition] = useTransition();

  const pushRef = useRef<(events: import("./types").SpeechEvent[]) => void>(() => undefined);
  const { snapshot: rawSnapshot, connected } = useMarketSocket((events) => pushRef.current(events));
  const [snapshot, setSnapshot] = useState(rawSnapshot);

  useEffect(() => {
    applyThemeToDom(themeMode);
  }, [themeMode]);

  useEffect(() => {
    startTransition(() => setSnapshot(rawSnapshot));
  }, [rawSnapshot, startTransition]);

  useEffect(() => {
    cachePurgeExpired();
  }, []);

  // 仅首次用行情交易日填充默认历史日期；已有会话选择则不覆盖
  const historySeeded = useRef(false);
  useEffect(() => {
    if (historySeeded.current) return;
    if (!snapshot.trade_date || snapshot.trade_date.length !== 8) return;
    historySeeded.current = true;
    setHistoryDate((prev) => resolveHistoryDate(prev || snapshot.trade_date));
  }, [snapshot.trade_date]);

  const { push } = useSpeech(fields.speech_enabled, fields.speech_types);
  pushRef.current = push;

  const toggleTheme = useCallback(() => {
    setThemeMode((prev) => {
      const next: ThemeMode = prev === "dark" ? "light" : "dark";
      saveTheme(next);
      return next;
    });
  }, []);

  const openDetail = useCallback(async (stock: StockItem) => {
    setSelectedCode(stock.code);
    // v2：含十大股东明细 / 曾用名，避免沿用旧缓存缺字段
    const cacheKey = `fund:v2:${stock.code}`;
    const cached = cacheGet<StockItem>(cacheKey);
    const cacheOk =
      cached &&
      Array.isArray(cached.top10_holders) &&
      Array.isArray(cached.former_names);
    setDetail(cacheOk ? { ...stock, ...cached } : stock);
    setDetailLoading(!cacheOk);
    try {
      const res = await fetch(`/api/stock/${stock.code}/fundamentals`);
      if (res.ok) {
        const data = (await res.json()) as StockItem;
        const merged = { ...stock, ...data };
        setDetail(merged);
        if (Array.isArray(data.top10_holders) || Array.isArray(data.former_names)) {
          cacheSet(cacheKey, data, 30 * 60);
        }
      }
    } catch {
      /* keep snapshot / cache */
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openDetailFromLadder = useCallback(
    (stock: StockItem) => {
      const hit =
        snapshot.zb.find((s) => s.code === stock.code) ||
        snapshot.lb.find((s) => s.code === stock.code) ||
        snapshot.dt.find((s) => s.code === stock.code) ||
        snapshot.zt.find((s) => s.code === stock.code) ||
        stock;
      void openDetail(hit);
    },
    [snapshot, openDetail],
  );

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: { config: UserConfig; available_fields: Record<string, string> }) => {
        if (data.config?.fields) setFields({ ...defaultFields, ...data.config.fields });
        if (data.available_fields) setAvailable(data.available_fields);
      })
      .catch(() => undefined);
  }, []);

  const saveFields = useCallback(async (v: FieldConfig) => {
    const res = await fetch("/api/config/fields", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v),
    });
    if (res.ok) {
      const cfg = (await res.json()) as UserConfig;
      setFields({ ...defaultFields, ...(cfg.fields || v) });
    } else {
      setFields(v);
    }
  }, []);

  const firstBoard = useMemo(
    () => snapshot.zt.filter((s) => (s.board_count || 1) <= 1),
    [snapshot.zt],
  );

  const poolData = useMemo(() => {
    switch (poolTab) {
      case "sb":
        return firstBoard;
      case "lb":
        return snapshot.lb;
      case "zb":
        return snapshot.zb;
      case "dt":
        return snapshot.dt;
      default:
        return snapshot.zt;
    }
  }, [poolTab, snapshot, firstBoard]);

  const filteredData = useMemo(
    () => applyMonitorFilter(poolData, filter),
    [poolData, filter],
  );

  const regions = useMemo(() => collectRegions(poolData), [poolData]);
  const dateLabel = tradeDateLabel(snapshot.trade_date);
  const isDark = themeMode === "dark";

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
        token: {
          colorPrimary: "#f97316",
          borderRadius: 6,
          fontFamily:
            '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          colorBgContainer: isDark ? "#1a2332" : "#ffffff",
          colorBgElevated: isDark ? "#1e2a3a" : "#ffffff",
          colorBorder: isDark ? "#2d3a4d" : "#e8ebef",
        },
      }}
    >
      <div className={`app theme-${themeMode}`}>
        <header className="topbar">
          <div className="brand">
            <span className="logo">钉盘</span>
            <span className="sub">A股涨停实时盯盘</span>
            <Tag color={connected ? "success" : "default"}>
              {connected ? "已连接" : "重连中"}
            </Tag>
            {snapshot.updated_at && (
              <span className="updated">更新 {snapshot.updated_at.slice(11)}</span>
            )}
          </div>
          <div className="top-actions">
            <Segmented
              value={mainTab}
              onChange={(v) => setMainTab(v as MainTab)}
              options={[
                { label: "实时监控", value: "monitor" },
                { label: "连板天梯", value: "ladder" },
                { label: "避雷啦", value: "risk" },
                { label: "重点观察", value: "watch" },
                { label: "涨速榜", value: "speed" },
                { label: "历史回溯", value: "history" },
              ]}
            />
            <Button
              icon={isDark ? <SunOutlined /> : <MoonOutlined />}
              onClick={toggleTheme}
              title={isDark ? "切换亮色" : "切换暗色"}
            />
            <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
              设置
            </Button>
          </div>
        </header>

        <SummaryBar summary={snapshot.summary} />

        {mainTab === "monitor" ? (
          <section className="panel">
            <Tabs
              activeKey={poolTab}
              onChange={(k) => {
                setPoolTab(k);
                setSelectedCode(null);
              }}
              items={[
                { key: "zt", label: `涨停(${snapshot.summary.zt_today})` },
                { key: "sb", label: `首板(${firstBoard.length})` },
                { key: "lb", label: `连板(${snapshot.summary.lb_today})` },
                { key: "zb", label: `炸板(${snapshot.summary.zb_today})` },
                { key: "dt", label: `跌停(${snapshot.summary.dt_today})` },
              ]}
            />
            <MonitorFilterBar
              value={filter}
              onChange={setFilter}
              regions={regions}
              resultCount={filteredData.length}
              totalCount={poolData.length}
            />
            <MonitorTable
              data={filteredData}
              columns={fields.table_columns}
              onRowClick={openDetail}
              selectedCode={selectedCode}
              onOpenChart={setChartStock}
            />
          </section>
        ) : mainTab === "ladder" ? (
          <section className="panel ladder-panel">
            <LadderView
              dateLabel={dateLabel || "—"}
              groups={snapshot.ladder}
              onOpenDetail={openDetailFromLadder}
              showTimes={fields.ladder_show_times !== false}
            />
          </section>
        ) : mainTab === "watch" ? (
          <section className="panel">
            <WatchlistPanel
              columns={fields.table_columns}
              onRowClick={openDetail}
              selectedCode={selectedCode}
              pollSec={fields.poll_interval_sec ?? 2.5}
            />
          </section>
        ) : mainTab === "risk" ? (
          <section className="panel">
            <RiskPanel
              onStockClick={(code) => {
                setSelectedCode(code);
                const hit =
                  snapshot.zt.find((s) => s.code === code) ||
                  snapshot.lb.find((s) => s.code === code) ||
                  snapshot.zb.find((s) => s.code === code) ||
                  snapshot.dt.find((s) => s.code === code);
                if (hit) {
                  setMainTab("monitor");
                  setPoolTab(findPoolTab(snapshot, code, hit.status));
                  void openDetail(hit);
                }
              }}
            />
          </section>
        ) : mainTab === "speed" ? (
          <section className="panel">
            <SpeedRankPanel
              columns={fields.table_columns}
              onRowClick={openDetail}
              selectedCode={selectedCode}
              pollSec={fields.speed_poll_interval_sec ?? 1.5}
            />
          </section>
        ) : (
          <section className="panel">
            <HistoryBackPanel
              columns={fields.table_columns}
              onRowClick={openDetail}
              selectedCode={selectedCode}
              date={historyDate}
              onDateChange={setHistoryDate}
            />
          </section>
        )}

        <StockDetailDrawer
          stock={detail}
          fields={fields.detail_fields}
          open={!!detail}
          loading={detailLoading}
          onClose={() => setDetail(null)}
        />

        <StockChartModal
          stock={chartStock}
          open={!!chartStock}
          onClose={() => setChartStock(null)}
        />

        <SettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          available={available}
          value={fields}
          onSave={saveFields}
        />
      </div>
    </ConfigProvider>
  );
}
