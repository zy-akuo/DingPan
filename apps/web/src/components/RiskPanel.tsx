import { QuestionCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Segmented, Spin, Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

export type RiskTab = "latest" | "st" | "delist";

export interface RiskStock {
  code: string;
  name: string;
  risk_type?: string;
  risk_tags?: string[];
  risk_hint?: string;
}

export interface RiskDay {
  date: string;
  date_label: string;
  added: RiskStock[];
  removed: RiskStock[];
}

export interface RiskSnapshot {
  tab: RiskTab;
  days: RiskDay[];
  current: RiskStock[];
  count: number;
  updated_at?: string;
  source?: string;
  error?: string;
}

function RiskChip({
  stock,
  muted,
  onClick,
}: {
  stock: RiskStock;
  muted?: boolean;
  onClick?: (s: RiskStock) => void;
}) {
  const tags = stock.risk_tags || (stock.risk_type ? [stock.risk_type] : []);
  const showSt = tags.includes("st") || tags.includes("delist");
  return (
    <button
      type="button"
      className={`risk-chip${muted ? " muted" : ""}`}
      title={stock.risk_hint || stock.name}
      onClick={() => onClick?.(stock)}
    >
      <span className="risk-chip-name">{stock.name}</span>
      {showSt ? <span className="risk-chip-st">ST</span> : null}
    </button>
  );
}

export function RiskBadge({
  tags,
  hint,
}: {
  tags?: string[] | null;
  hint?: string | null;
}) {
  if (!tags?.length) return null;
  const primary = tags.includes("delist") ? "delist" : tags.includes("st") ? "st" : "warn";
  const label = primary === "delist" ? "退" : primary === "st" ? "ST" : "雷";
  return (
    <span
      className={`risk-badge risk-badge-${primary}`}
      title={hint || (primary === "delist" ? "退市风险警示" : primary === "st" ? "其他风险警示" : "潜在风险")}
    >
      {label}
    </span>
  );
}

export function RiskPanel({
  onStockClick,
}: {
  onStockClick?: (code: string, name: string) => void;
}) {
  const [tab, setTab] = useState<RiskTab>("latest");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<RiskSnapshot | null>(null);
  const reqSeq = useRef(0);

  const load = useCallback(async (t: RiskTab) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/market/risk?tab=${encodeURIComponent(t)}`);
      if (seq !== reqSeq.current) return;
      if (!res.ok) {
        setData({
          tab: t,
          days: [],
          current: [],
          count: 0,
          error: `加载失败(${res.status})`,
        });
        return;
      }
      const payload = (await res.json()) as RiskSnapshot;
      if (seq !== reqSeq.current) return;
      setData(payload);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setData({
        tab: t,
        days: [],
        current: [],
        count: 0,
        error: String(e),
      });
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await fetch("/api/market/risk/refresh", { method: "POST" });
    } catch {
      /* ignore */
    }
    await load(tab);
  }, [load, tab]);

  const onChip = (s: RiskStock) => onStockClick?.(s.code, s.name);

  return (
    <div className="risk-panel">
      <div className="risk-banner">
        <div className="risk-banner-text">
          <span>在个股列表显示潜在风险标签</span>
          <Tooltip title="实时监控与连板天梯中，风险警示股名称旁会标注 ST / 退 / 雷">
            <QuestionCircleOutlined className="risk-help" />
          </Tooltip>
        </div>
        <div className="risk-banner-right">
          <span className="muted">已开启</span>
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void refresh()}
            title="刷新"
          />
        </div>
      </div>

      <div className="risk-tabs-row">
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as RiskTab)}
          options={[
            { label: "最新预警", value: "latest" },
            { label: "ST预警", value: "st" },
            { label: "退市预警", value: "delist" },
          ]}
        />
        {data?.updated_at ? (
          <span className="muted risk-updated">
            更新 {data.updated_at.slice(11)} · {data.source || "—"} · 在册 {data.count}
          </span>
        ) : null}
      </div>

      <Spin spinning={loading}>
        {data?.error ? <div className="risk-error">{data.error}</div> : null}

        {!loading && !data?.days?.length && !data?.current?.length ? (
          <Empty description="暂无预警变更，已加载当前风险警示池" />
        ) : null}

        <div className="risk-timeline">
          {(data?.days || []).map((day) => (
            <div key={day.date} className="risk-day">
              <div className="risk-day-label">{day.date_label}</div>
              <div className="risk-day-card">
                {day.added.length ? (
                  <div className="risk-section">
                    <div className="risk-section-title">新加入预警</div>
                    <div className="risk-chips">
                      {day.added.map((s) => (
                        <RiskChip key={`a-${day.date}-${s.code}`} stock={s} onClick={onChip} />
                      ))}
                    </div>
                  </div>
                ) : null}
                {day.removed.length ? (
                  <div className="risk-section">
                    <div className="risk-section-title">新移除预警</div>
                    <div className="risk-chips">
                      {day.removed.map((s) => (
                        <RiskChip key={`r-${day.date}-${s.code}`} stock={s} muted onClick={onChip} />
                      ))}
                    </div>
                  </div>
                ) : null}
                {!day.added.length && !day.removed.length ? (
                  <span className="muted">当日无变更</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        {data?.current?.length ? (
          <div className="risk-current">
            <div className="risk-section-title">当前在册（{data.current.length}）</div>
            <div className="risk-chips">
              {data.current.map((s) => (
                <RiskChip key={`c-${s.code}`} stock={s} onClick={onChip} />
              ))}
            </div>
          </div>
        ) : null}
      </Spin>
    </div>
  );
}
