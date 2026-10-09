import { SearchOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Input, Segmented, Select, Space } from "antd";
import { useMemo, useState } from "react";
import { collectRegions } from "./MonitorFilterBar";
import { matchNameOrInitials } from "../lib/stockMatch";
import type { LadderGroup, StockItem } from "../types";
import { formatPct } from "../types";
import { RiskBadge } from "./RiskPanel";
import { StockChartModal } from "./StockChartModal";

type DisplayMode = "all" | "success" | "fail" | "broken";

const DISPLAY_OPTIONS: { label: string; value: DisplayMode }[] = [
  { label: "全部展示", value: "all" },
  { label: "晋级成功", value: "success" },
  { label: "晋级失败", value: "fail" },
  { label: "炸板", value: "broken" },
];

function matchDisplayMode(status: string, mode: DisplayMode): boolean {
  if (mode === "all") return true;
  if (mode === "success") return status === "成";
  if (mode === "fail") return status === "败";
  return status === "炸";
}

function timeToSec(t: string): number | null {
  const s = (t || "").trim();
  if (!s) return null;
  const parts = s.split(":").map((x) => Number(x));
  if (parts.some((n) => Number.isNaN(n))) return null;
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const sec = parts[2] ?? 0;
  return h * 3600 + m * 60 + sec;
}

function inTimeRange(t: string | undefined, from: string, to: string): boolean {
  const fromSec = timeToSec(from);
  const toSec = timeToSec(to);
  if (fromSec == null && toSec == null) return true;
  const sec = timeToSec(t || "");
  if (sec == null) return false;
  if (fromSec != null && sec < fromSec) return false;
  if (toSec != null && sec > toSec) return false;
  return true;
}

/** HH:MM:SS / HH:MM → H:MM */
function timeShort(t?: string): string {
  if (!t) return "";
  const parts = t.split(":");
  if (parts.length >= 2) {
    const h = String(Number(parts[0]));
    if (Number.isNaN(Number(parts[0]))) return t;
    return `${h}:${parts[1]}`;
  }
  return t;
}

/** 炸板时间：优先末封/炸板时刻，否则首封 */
function breakTimeOf(s: StockItem): string {
  return s.last_seal_time || s.first_seal_time || "";
}

function StatusBadge({ status }: { status: string }) {
  if (status === "成") return <span className="badge badge-ok">成</span>;
  if (status === "炸") return <span className="badge badge-broken">炸</span>;
  return <span className="badge-fail">(败)</span>;
}

function StockTimeLine({ stock }: { stock: StockItem }) {
  if (stock.status === "成") {
    const first = timeShort(stock.first_seal_time);
    if (!first) return null;
    const reseal =
      stock.open_times > 0 && stock.last_seal_time
        ? timeShort(stock.last_seal_time)
        : "";
    const showReseal = !!(reseal && reseal !== first);
    return (
      <div className="ladder-stock-times" title="首次封板 / 回封时间">
        <span className="t-seal">首：{first}</span>
        {showReseal ? (
          <>
            <span className="t-sep">；</span>
            <span className="t-reseal">回：{reseal}</span>
          </>
        ) : null}
      </div>
    );
  }
  if (stock.status === "炸") {
    const bt = timeShort(breakTimeOf(stock));
    if (!bt) return null;
    return (
      <div className="ladder-stock-times" title="炸板时间">
        <span className="t-break">炸：{bt}</span>
      </div>
    );
  }
  return null;
}

function TimeRangeInputs({
  label,
  from,
  to,
  onFrom,
  onTo,
}: {
  label: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  return (
    <Space size={4} className="filter-item" wrap>
      <span className="filter-label">{label}</span>
      <Input
        size="small"
        placeholder="09:30"
        value={from}
        onChange={(e) => onFrom(e.target.value)}
        style={{ width: 72 }}
        allowClear
      />
      <span className="filter-sep">~</span>
      <Input
        size="small"
        placeholder="15:00"
        value={to}
        onChange={(e) => onTo(e.target.value)}
        style={{ width: 72 }}
        allowClear
      />
    </Space>
  );
}

export function LadderView({
  dateLabel,
  groups,
  onOpenDetail,
}: {
  dateLabel: string;
  groups: LadderGroup[];
  onOpenDetail?: (stock: StockItem) => void;
}) {
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const [keyword, setKeyword] = useState("");
  const [region, setRegion] = useState("");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("all");
  const [sealTimeFrom, setSealTimeFrom] = useState("");
  const [sealTimeTo, setSealTimeTo] = useState("");
  const [breakTimeFrom, setBreakTimeFrom] = useState("");
  const [breakTimeTo, setBreakTimeTo] = useState("");

  const visibleGroups = useMemo(
    () =>
      groups.map((g) => ({
        ...g,
        stocks: g.stocks.filter((s) => matchDisplayMode(s.status, displayMode)),
      })),
    [groups, displayMode],
  );

  const regions = useMemo(
    () => collectRegions(groups.flatMap((g) => g.stocks)),
    [groups],
  );

  const sealFilterOn = !!(sealTimeFrom.trim() || sealTimeTo.trim());
  const breakFilterOn = !!(breakTimeFrom.trim() || breakTimeTo.trim());
  const timeFilterOn = sealFilterOn || breakFilterOn;

  const hitCodes = useMemo(() => {
    const q = keyword.trim();
    const r = region.trim();
    if (!q && !r && !timeFilterOn) return null as Set<string> | null;
    const set = new Set<string>();
    for (const g of visibleGroups) {
      for (const s of g.stocks) {
        if (q && !matchNameOrInitials(s.name || "", q)) continue;
        if (r && !(s.region || "").includes(r)) continue;
        if (timeFilterOn) {
          let timeOk = false;
          if (sealFilterOn && inTimeRange(s.first_seal_time, sealTimeFrom, sealTimeTo)) {
            timeOk = true;
          }
          if (
            breakFilterOn &&
            s.status === "炸" &&
            inTimeRange(breakTimeOf(s), breakTimeFrom, breakTimeTo)
          ) {
            timeOk = true;
          }
          // 封板+炸板同时填：任一命中即可（两类标的字段不同）
          if (!timeOk) continue;
        }
        set.add(s.code);
      }
    }
    return set;
  }, [
    visibleGroups,
    keyword,
    region,
    timeFilterOn,
    sealFilterOn,
    breakFilterOn,
    sealTimeFrom,
    sealTimeTo,
    breakTimeFrom,
    breakTimeTo,
  ]);

  const hitCount = hitCodes?.size ?? 0;
  const searching = !!(keyword.trim() || region.trim() || timeFilterOn);

  return (
    <div className="ladder">
      <div className="ladder-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="名称 / 首字母模糊搜索，如 中 或 zg"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        <Space size={4} className="filter-item">
          <span className="filter-label">地域</span>
          <Select
            allowClear
            showSearch
            placeholder="全部"
            value={region || undefined}
            onChange={(v) => setRegion(v || "")}
            options={regions.map((r) => ({ label: r, value: r }))}
            style={{ width: 120 }}
            optionFilterProp="label"
          />
        </Space>
        <TimeRangeInputs
          label="封板时间"
          from={sealTimeFrom}
          to={sealTimeTo}
          onFrom={setSealTimeFrom}
          onTo={setSealTimeTo}
        />
        <TimeRangeInputs
          label="炸板时间"
          from={breakTimeFrom}
          to={breakTimeTo}
          onFrom={setBreakTimeFrom}
          onTo={setBreakTimeTo}
        />
        <Space size={4} className="filter-item">
          <span className="filter-label">展示</span>
          <Segmented
            size="small"
            value={displayMode}
            onChange={(v) => setDisplayMode(v as DisplayMode)}
            options={DISPLAY_OPTIONS}
          />
        </Space>
        {searching && (
          <span className="filter-count">
            高亮 {hitCount} 只
          </span>
        )}
      </div>
      <h2 className="ladder-title">【{dateLabel}】涨停股票池</h2>
      <div className="ladder-table">
        <div className="ladder-head">
          <div>进度</div>
          <div>晋级率</div>
          <div>股票</div>
        </div>
        {visibleGroups.map((g) => (
          <div key={g.key} className="ladder-row">
            <div className="ladder-progress">{g.label}</div>
            <div className="ladder-rate">{g.promotion_rate}</div>
            <div className="ladder-stocks">
              {g.stocks.map((s) => {
                const hit = searching && !!hitCodes?.has(s.code);
                return (
                  <div
                    key={`${g.key}-${s.code}-${s.status}`}
                    className={`ladder-stock${s.risk_tags?.length ? " has-risk" : ""}${hit ? " ladder-stock-hit" : ""}${searching && !hit ? " ladder-stock-dim" : ""}`}
                  >
                    <div className="ladder-stock-main">
                      <span className="mkt">{s.market || "深"}</span>
                      <button
                        type="button"
                        className={`nm-link${s.risk_tags?.length ? " risk-name" : ""}`}
                        onClick={() => setChartStock(s)}
                        title={s.risk_hint ? `${s.risk_hint} · 查看分时/日线` : "查看分时/日线"}
                      >
                        {s.name}
                      </button>
                      <RiskBadge tags={s.risk_tags} hint={s.risk_hint} />
                      <StatusBadge status={s.status} />
                      <span className={s.change_pct >= 0 ? "pct up" : "pct down"}>
                        [ {formatPct(s.change_pct)} ]
                      </span>
                      <span className="concept">
                        {s.concepts?.[0] || s.industry || ""}
                      </span>
                      {s.region ? <span className="region">{s.region}</span> : null}
                      {onOpenDetail ? (
                        <button
                          type="button"
                          className="jump-monitor-btn"
                          title="查看详情"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenDetail(s);
                          }}
                        >
                          <UnorderedListOutlined />
                        </button>
                      ) : null}
                    </div>
                    <StockTimeLine stock={s} />
                  </div>
                );
              })}
              {!g.stocks.length && <span className="muted">暂无</span>}
            </div>
          </div>
        ))}
      </div>

      <StockChartModal
        stock={chartStock}
        open={!!chartStock}
        onClose={() => setChartStock(null)}
      />
    </div>
  );
}
