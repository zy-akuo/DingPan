import type { MarketSummary } from "../types";

export function SummaryBar({ summary }: { summary: MarketSummary }) {
  const rate = (count: number, total: number) => total > 0 ? `${(count / total * 100).toFixed(1)}%` : "—";
  const cards = [
    { title: "涨停", current: summary.zt_today, previous: summary.zt_yesterday, tone: "up", hint: "涨停股票数量" },
    { title: "跌停", current: summary.dt_today, previous: summary.dt_yesterday, tone: "down", hint: "跌停股票数量" },
    { title: "炸板", current: summary.zb_today, previous: summary.zb_yesterday, tone: "market-summary-amber", hint: "炸板股票数量" },
    { title: "连板率", current: rate(summary.lb_today, summary.zt_today), previous: rate(summary.lb_yesterday, summary.zt_yesterday), tone: "up", hint: `连板股数 ÷ 涨停股数，今日 ${summary.lb_today} / ${summary.zt_today}` },
    { title: "封板率", current: `${summary.seal_rate_today}%`, previous: `${summary.seal_rate_yesterday}%`, tone: "market-summary-amber", hint: "涨停股数 ÷（涨停股数 + 炸板股数）" },
    { title: "炸板率", current: rate(summary.zb_today, summary.zt_today + summary.zb_today), previous: rate(summary.zb_yesterday, summary.zt_yesterday + summary.zb_yesterday), tone: "market-summary-amber", hint: "炸板股数 ÷（涨停股数 + 炸板股数）" },
  ];
  return <section className="market-sentiment" aria-label="市场情绪统计">
    <div className="market-sentiment-heading"><strong>市场情绪</strong><span>今日 / 昨日</span></div>
    <div className="market-sentiment-grid">
      {cards.map((card) => <div className="market-sentiment-card" key={card.title} title={card.hint}>
        <span className="market-sentiment-label">{card.title}</span>
        <strong className={card.tone}>{card.current}</strong>
        <span className="market-sentiment-yesterday">昨日 <b>{card.previous}</b></span>
      </div>)}
    </div>
  </section>;
}
