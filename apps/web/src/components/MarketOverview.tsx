import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "antd";
import { FullscreenOutlined, ReloadOutlined } from "@ant-design/icons";

import * as echarts from "echarts";
import { buildTrendOption } from "./StockChartModal";

type Point = { time: string; price: number; amount: number; volume: number };
type Overview = {
  trade_date: string; quote_time: string; amount_time: string; scope: string;
  price: number; pre_close: number | null; change: number | null; change_pct: number | null;
  amount: number; volume: number; previous_date: string | null;
  previous_amount: number | null; amount_delta: number | null; amount_delta_pct: number | null;
  breadth?: { up: number; down: number; flat: number; scope: string; stale: boolean } | null;
  points: Point[]; stale: boolean; warning?: string; updated_at: string;
};
const pct = (value: number | null) => value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const money = (value: number | null) => value == null ? "—" : `${(value / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}亿`;
const tone = (value: number | null) => value == null || value === 0 ? "" : value > 0 ? "up" : "down";
function minute(time: string) {
  const [h, m] = time.split(":").map(Number);
  return Math.max(0, Math.min(240, h * 60 + m - 570 - (h >= 13 ? 90 : 0)));
}

function ExpandedIndexChart({ data }: { data: Overview }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const instance = echarts.init(element);
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element);
    return () => { observer.disconnect(); instance.dispose(); chart.current = null; };
  }, []);
  useEffect(() => {
    const draw = () => {
      const points = data.points.map((point, index) => ({ ...point, avg: 0,
        volume: Math.max(0, point.volume - (data.points[index - 1]?.volume || 0)),
        amount: Math.max(0, point.amount - (data.points[index - 1]?.amount || 0)),
      }));
      chart.current?.setOption(buildTrendOption(points, data.pre_close || 0,
        document.documentElement.dataset.theme === "dark", true), true);
    };
    draw();
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [data]);
  return <><div className="market-expanded-info">
    <strong className={tone(data.change_pct)}>{data.price.toFixed(2)}　{pct(data.change_pct)}</strong>
    <span>昨收 {data.pre_close?.toFixed(2) || "—"}</span>
    <span>最高 {Math.max(...data.points.map((p) => p.price)).toFixed(2)}</span>
    <span>最低 {Math.min(...data.points.map((p) => p.price)).toFixed(2)}</span>
    <span>{data.trade_date} · {data.quote_time}</span>
  </div><div ref={container} style={{ height: "min(65vh, 620px)", minHeight: 280 }} /></>;
}

function IndexSparkline({ data }: { data: Overview }) {
  const [hover, setHover] = useState<Point | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(480);
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(100, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const points = data.points;
  const base = data.pre_close || points[0]?.price || data.price;
  const range = Math.max(...points.map((p) => Math.abs(p.price - base)), base * 0.002) * 1.12;
  const x = (p: Point) => 8 + minute(p.time) / 240 * (width - 16);
  const y = (p: Point) => 40 - (p.price - base) / range * 32;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const volumes = points.map((p, i) => Math.max(0, p.volume - (points[i - 1]?.volume || 0)));
  const maxVolume = Math.max(...volumes, 1);
  return <div className="market-sparkline">
    <div className="market-sparkline-caption"><span>上证日内分时</span><span>{hover ? `${hover.time} · ${hover.price.toFixed(2)} · ${pct((hover.price / base - 1) * 100)}` : `昨收 ${base.toFixed(2)}`}</span><Button type="text" size="small" icon={<FullscreenOutlined />} className="market-expand-btn" title="放大上证分时" aria-label="放大上证分时" onClick={() => setExpanded(true)} /></div>
    <svg ref={svgRef} viewBox={`0 0 ${width} 112`} preserveAspectRatio="none" role="img" aria-label="上证指数日内分时走势" onMouseLeave={() => setHover(null)} onMouseMove={(event) => {
      // 使用 SVG 的实际屏幕变换，包含等比缩放、居中留白及页面缩放。
      const svg = event.currentTarget;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const local = point.matrixTransform(matrix.inverse());
      if (local.x < 8 || local.x > width - 8 || local.y < 0 || local.y > 96) {
        setHover(null);
        return;
      }
      const target = local.x;
      const nearest = points.reduce((best, point) => Math.abs(x(point) - target) < Math.abs(x(best) - target) ? point : best, points[0]);
      setHover(nearest || null);
    }}>
      {[8, 40, 72].map((line) => <line key={line} x1="8" x2={width - 8} y1={line} y2={line} stroke="var(--line)" strokeDasharray="3 4" />)}
      <line x1={width / 2} x2={width / 2} y1="8" y2="96" stroke="var(--line)" />
      <path d={path} fill="none" stroke="var(--text)" strokeWidth="1.5" />
      {points.map((point, i) => <rect key={point.time} x={x(point)} y={96 - volumes[i] / maxVolume * 17} width="1.3" height={volumes[i] / maxVolume * 17} fill={point.price >= (points[i - 1]?.price || base) ? "var(--up)" : "var(--down)"} />)}
      {hover && <><line x1={x(hover)} x2={x(hover)} y1="8" y2="96" stroke="var(--muted)" strokeDasharray="3 3" /><circle cx={x(hover)} cy={y(hover)} r="2.5" fill="var(--accent)" /></>}
      <text x="8" y="110">09:30</text><text x={width / 2} y="110" textAnchor="middle">11:30 / 13:00</text><text x={width - 8} y="110" textAnchor="end">15:00</text>
    </svg>
    <Modal title="上证指数 000001 · 日内分时" open={expanded} onCancel={() => setExpanded(false)} footer={null}
      width="min(1100px, 94vw)" destroyOnHidden>
      {expanded && <ExpandedIndexChart data={data} />}
    </Modal>
  </div>;
}

export function MarketOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const inflight = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (inflight.current) { timer = setTimeout(load, 500); return; }
      inflight.current = true;
      setLoading(true);
      try {
        const response = await fetch("/api/market/overview", { signal: controller.signal });
        if (!response.ok) throw new Error(`大盘请求失败（${response.status}）`);
        const payload = await response.json() as Overview;
        if (!cancelled) { setData(payload); setError(payload.warning || ""); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "大盘数据加载失败");
      } finally {
        inflight.current = false;
        if (!cancelled) {
          setLoading(false);
          const now = new Date();
          const trading = now.getDay() > 0 && now.getDay() < 6 && now.getHours() >= 9 && now.getHours() < 15;
          timer = setTimeout(load, trading ? 10_000 : 60_000);
        }
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [retry]);
  return <section className="market-overview" aria-label="大盘实时概览">
    <div className="market-index-hero">
      <div className="market-metric-label">上证指数 <span>000001</span></div>
      <div className={`market-index-value ${tone(data?.change_pct ?? null)}`}>{data ? data.price.toFixed(2) : "—"}</div>
      <div className={`market-index-change ${tone(data?.change_pct ?? null)}`}><strong>{pct(data?.change_pct ?? null)}</strong><span>{data?.change == null ? "—" : `${data.change > 0 ? "+" : ""}${data.change.toFixed(2)}`}</span></div>
      <div className="market-data-time">{data ? `${data.trade_date.slice(0, 4)}-${data.trade_date.slice(4, 6)}-${data.trade_date.slice(6)} ${data.quote_time}` : loading ? "正在加载…" : "等待数据"}</div>
    </div>
    {data?.points.length ? <IndexSparkline data={data} /> : <div className="market-sparkline market-chart-placeholder">{loading ? "正在加载上证分时…" : "暂未取得分时数据"}</div>}
    <div className="market-turnover">
      <div className="market-metric-label">{data?.scope || "沪深A股"}成交额 <span>截至 {data?.amount_time || "—"}</span></div>
      <strong className="market-turnover-value">{money(data?.amount ?? null)}</strong>
      <div className="market-secondary-metric">成交量 <b>{data ? `${(data.volume / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}亿股` : "—"}</b></div>
    </div>
    <div className="market-comparison" title="沪深A股累计成交额与上一交易日同一时刻比较。金额非资金净流入；不包含北交所。">
      <div className="market-metric-label">较上一交易日同期</div>
      <strong className={`market-delta-value ${tone(data?.amount_delta ?? null)}`}>{data?.amount_delta == null ? "暂无同期数据" : `${data.amount_delta >= 0 ? "放量" : "缩量"} ${money(Math.abs(data.amount_delta))}`}</strong>
      <div className={`market-delta-pct ${tone(data?.amount_delta ?? null)}`}>{pct(data?.amount_delta_pct ?? null)}</div>
      <div className="market-data-time">昨日同期 {money(data?.previous_amount ?? null)}</div>
    </div>
    <div className="market-overview-status">
      <div className="market-breadth" title={`沪深京市场上涨、下跌、平盘家数${data?.breadth?.stale ? '；更新失败，显示上次统计' : ''}`}>
        <span className="muted">涨跌统计</span>
        <span className="up">涨 <b>{data?.breadth?.up ?? "—"}</b></span>
        <span className="down">跌 <b>{data?.breadth?.down ?? "—"}</b></span>
        <span className="muted">平 <b>{data?.breadth?.flat ?? "—"}</b></span>
        {data?.breadth?.stale && <span className="market-stale">待更新</span>}
      </div>
      <span className={error || data?.stale ? "market-stale" : "muted"}>{error || (data ? `${data.scope}口径 · 交易时段每10秒更新` : "沪深A股口径，不含北交所")}</span>
      <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={() => setRetry((v) => v + 1)}>刷新</Button>
    </div>
  </section>;
}
