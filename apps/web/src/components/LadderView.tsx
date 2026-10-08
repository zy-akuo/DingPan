import { SearchOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { Input, Segmented, Select, Space } from "antd";
import { useMemo, useState } from "react";
import { collectRegions } from "./MonitorFilterBar";
import { matchNameOrInitials } from "../lib/stockMatch";
import type { LadderGroup, StockItem } from "../types";
import { formatPct } from "../types";
import { RiskBadge } from "./RiskPanel";
import { StockChartModal } from "./StockChartModal";

type DisplayMode = "all" | "success" | "success_broken";

const DISPLAY_OPTIONS: { label: string; value: DisplayMode }[] = [
  { label: "全部展示", value: "all" },
  { label: "晋级成功", value: "success" },
  { label: "晋级成功和炸板", value: "success_broken" },
];

function matchDisplayMode(status: string, mode: DisplayMode): boolean {
  if (mode === "all") return true;
  if (mode === "success") return status === "成";
  return status === "成" || status === "炸";
}

function StatusBadge({ status }: { status: string }) {
  if (status === "成") return <span className="badge badge-ok">成</span>;
  if (status === "炸") return <span className="badge badge-broken">炸</span>;
  return <span className="badge-fail">(败)</span>;
}

export function LadderView({
  dateLabel,
  groups,
  onJumpToMonitor,
}: {
  dateLabel: string;
  groups: LadderGroup[];
  onJumpToMonitor?: (stock: StockItem) => void;
}) {
  const [chartStock, setChartStock] = useState<StockItem | null>(null);
  const [keyword, setKeyword] = useState("");
  const [region, setRegion] = useState("");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("all");

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

  const hitCodes = useMemo(() => {
    const q = keyword.trim();
    const r = region.trim();
    if (!q && !r) return null as Set<string> | null;
    const set = new Set<string>();
    for (const g of visibleGroups) {
      for (const s of g.stocks) {
        if (q && !matchNameOrInitials(s.name || "", q)) continue;
        if (r && !(s.region || "").includes(r)) continue;
        set.add(s.code);
      }
    }
    return set;
  }, [visibleGroups, keyword, region]);

  const hitCount = hitCodes?.size ?? 0;
  const searching = !!(keyword.trim() || region.trim());

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
                    {onJumpToMonitor ? (
                      <button
                        type="button"
                        className="jump-monitor-btn"
                        title="跳转实时监控并选中"
                        onClick={(e) => {
                          e.stopPropagation();
                          onJumpToMonitor(s);
                        }}
                      >
                        <UnorderedListOutlined />
                      </button>
                    ) : null}
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
