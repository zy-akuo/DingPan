import type { MarketSummary } from "../types";

const cards: {
  key: keyof Pick<
    MarketSummary,
    | "zt_today"
    | "lb_today"
    | "seal_rate_today"
    | "zb_today"
    | "dt_today"
  >;
  yKey: keyof Pick<
    MarketSummary,
    | "zt_yesterday"
    | "lb_yesterday"
    | "seal_rate_yesterday"
    | "zb_yesterday"
    | "dt_yesterday"
  >;
  title: string;
  tone: string;
  suffix?: string;
}[] = [
  { key: "zt_today", yKey: "zt_yesterday", title: "涨停", tone: "zt" },
  { key: "lb_today", yKey: "lb_yesterday", title: "连板", tone: "lb" },
  {
    key: "seal_rate_today",
    yKey: "seal_rate_yesterday",
    title: "封板率",
    tone: "seal",
    suffix: "%",
  },
  { key: "zb_today", yKey: "zb_yesterday", title: "炸板", tone: "zb" },
  { key: "dt_today", yKey: "dt_yesterday", title: "跌停", tone: "dt" },
];

export function SummaryBar({ summary }: { summary: MarketSummary }) {
  return (
    <div className="summary-bar">
      {cards.map((c) => (
        <div key={c.key} className={`summary-card tone-${c.tone}`}>
          <div className="summary-title">{c.title}</div>
          <div className="summary-body">
            <div className="summary-row">
              <span>今日</span>
              <strong>
                {summary[c.key]}
                {c.suffix || ""}
              </strong>
            </div>
            <div className="summary-row muted">
              <span>昨日</span>
              <span>
                {summary[c.yKey]}
                {c.suffix || ""}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
