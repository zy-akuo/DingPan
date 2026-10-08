import { Modal, Spin } from "antd";
import * as echarts from "echarts";
import { useCallback, useEffect, useRef, useState } from "react";
import { cacheGet, cacheSet } from "../lib/localCache";

type ChartStock = { code: string; name: string };
type TrendPoint = { time: string; price: number; avg: number; volume: number };
type KBar = {
  date: string;
  open: number;
  close: number;
  low: number;
  high: number;
  volume?: number;
  pct?: number;
};

const UP = "#e11d2e";
const DOWN = "#0a8f3d";
const PRICE_LINE = "#2563eb";
const AVG_LINE = "#f59e0b";
const MA5_C = "#3b82f6";
const MA10_C = "#eab308";
const MA20_C = "#d946ef";
const DIF_C = "#2563eb";
const DEA_C = "#d946ef";

type ChartPalette = {
  bg: string;
  text: string;
  muted: string;
  grid: string;
  axisLine: string;
  midLabel: string;
  tooltipBg: string;
  tooltipBorder: string;
  pointer: string;
  areaTop: string;
  areaBottom: string;
  markLine: string;
};

function readDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

function chartPalette(dark: boolean): ChartPalette {
  if (dark) {
    return {
      bg: "#161b22",
      text: "#e6edf3",
      muted: "#8b949e",
      grid: "#30363d",
      axisLine: "#3d444d",
      midLabel: "#e6edf3",
      tooltipBg: "rgba(22,27,34,0.96)",
      tooltipBorder: "#30363d",
      pointer: "#8b949e",
      areaTop: "rgba(59,130,246,0.28)",
      areaBottom: "rgba(59,130,246,0.03)",
      markLine: "#6e7681",
    };
  }
  return {
    bg: "#ffffff",
    text: "#374151",
    muted: "#6b7280",
    grid: "#e5e7eb",
    axisLine: "#cbd5e1",
    midLabel: "#111827",
    tooltipBg: "rgba(255,255,255,0.96)",
    tooltipBorder: "#e5e7eb",
    pointer: "#94a3b8",
    areaTop: "rgba(37,99,235,0.18)",
    areaBottom: "rgba(37,99,235,0.02)",
    markLine: "#94a3b8",
  };
}

/** 固定交易分钟轴：09:30–11:30 + 13:00–14:57 */
function buildTradeTimeline(): string[] {
  const out: string[] = [];
  const push = (h0: number, m0: number, h1: number, m1: number) => {
    let h = h0;
    let m = m0;
    while (h < h1 || (h === h1 && m <= m1)) {
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      m += 1;
      if (m >= 60) {
        m = 0;
        h += 1;
      }
    }
  };
  push(9, 30, 11, 30);
  push(13, 0, 14, 57);
  return out;
}

const TRADE_AXIS = buildTradeTimeline();

function normTime(raw: string): string {
  const m = String(raw || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function alignTrendToAxis(points: TrendPoint[]) {
  const map = new Map<string, TrendPoint>();
  for (const p of points) {
    const t = normTime(p.time);
    if (t) map.set(t, { ...p, time: t });
  }
  const prices: Array<number | null> = [];
  const avgs: Array<number | null> = [];
  const vols: Array<number | null> = [];
  const filled: Array<TrendPoint | null> = [];
  for (const t of TRADE_AXIS) {
    const hit = map.get(t) || null;
    filled.push(hit);
    prices.push(hit ? hit.price : null);
    avgs.push(hit ? hit.avg : null);
    vols.push(hit ? hit.volume : null);
  }
  return { times: TRADE_AXIS, prices, avgs, vols, filled };
}

function smaAt(closes: number[], index: number, n: number): number | null {
  if (index + 1 < n) return null;
  let s = 0;
  for (let i = index + 1 - n; i <= index; i++) s += closes[i];
  return s / n;
}

function smaSeries(closes: number[], n: number): Array<number | "-"> {
  return closes.map((_, i) => {
    const v = smaAt(closes, i, n);
    return v == null ? "-" : +v.toFixed(3);
  });
}

function emaSeries(values: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function macdOf(closes: number[]) {
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = emaSeries(dif, 9);
  const hist = dif.map((d, i) => (d - dea[i]) * 2);
  return { dif, dea, hist };
}

function barPct(bars: KBar[], index: number): number {
  const b = bars[index];
  if (!b) return 0;
  if (typeof b.pct === "number" && !Number.isNaN(b.pct) && (b.pct !== 0 || index === 0)) {
    return b.pct;
  }
  const prev = index > 0 ? bars[index - 1].close : 0;
  if (prev > 0) return ((b.close - prev) / prev) * 100;
  return 0;
}

function buildTrendOption(points: TrendPoint[], preClose: number, dark: boolean) {
  const pal = chartPalette(dark);
  const { times, prices, avgs, vols, filled } = alignTrendToAxis(points);
  const pre =
    preClose > 0
      ? preClose
      : prices.find((p): p is number => typeof p === "number" && p > 0) || 1;

  let maxAbs = 0;
  for (const p of prices) {
    if (typeof p === "number" && p > 0) maxAbs = Math.max(maxAbs, Math.abs(p - pre));
  }
  for (const a of avgs) {
    if (typeof a === "number" && a > 0) maxAbs = Math.max(maxAbs, Math.abs(a - pre));
  }
  maxAbs = Math.max(maxAbs, pre * 0.01);
  const yMax = pre + maxAbs;
  const yMin = Math.max(0.01, pre - maxAbs);
  const pctMax = (maxAbs / pre) * 100;

  const volData = vols.map((v, i) => {
    if (v == null) return { value: 0, itemStyle: { color: "transparent" } };
    const cur = prices[i];
    let prev: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (typeof prices[j] === "number") {
        prev = prices[j] as number;
        break;
      }
    }
    const up =
      typeof cur === "number"
        ? prev != null
          ? cur >= prev
          : cur >= pre
        : true;
    return { value: v, itemStyle: { color: up ? UP : DOWN } };
  });

  // 例图：约每 15 分钟一个刻度，覆盖到 14:45/14:57
  const labelSet = new Set([
    "09:30",
    "09:45",
    "10:00",
    "10:15",
    "10:30",
    "10:45",
    "11:00",
    "11:15",
    "11:30",
    "13:00",
    "13:15",
    "13:30",
    "13:45",
    "14:00",
    "14:15",
    "14:30",
    "14:45",
    "14:57",
  ]);

  return {
    backgroundColor: pal.bg,
    animation: false,
    axisPointer: {
      link: [{ xAxisIndex: "all" }],
      label: { backgroundColor: dark ? "#484f58" : "#334155" },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "cross",
        label: { backgroundColor: dark ? "#484f58" : "#334155" },
        lineStyle: { color: pal.pointer, type: "dashed", width: 1 },
      },
      backgroundColor: pal.tooltipBg,
      borderColor: pal.tooltipBorder,
      textStyle: { color: pal.text, fontSize: 12 },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [];
        if (!list.length) return "";
        const idx = (list[0] as { dataIndex?: number }).dataIndex ?? 0;
        const p = filled[idx];
        if (!p) return `${times[idx] || ""}<br/>暂无数据`;
        const chg = ((p.price - pre) / pre) * 100;
        const chgColor = chg >= 0 ? UP : DOWN;
        return [
          `<div style="font-weight:600;margin-bottom:4px">${p.time}</div>`,
          `价格 <b style="color:${chgColor}">${p.price.toFixed(2)}</b>`,
          `均价 <b style="color:${AVG_LINE}">${p.avg.toFixed(2)}</b>`,
          `涨跌 <b style="color:${chgColor}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</b>`,
          `量 ${(p.volume / 100).toFixed(0)} 手`,
        ].join("<br/>");
      },
    },
    grid: [
      { left: 62, right: 62, top: 18, height: "62%" },
      { left: 62, right: 62, top: "78%", height: "16%" },
    ],
    xAxis: [
      {
        type: "category",
        data: times,
        boundaryGap: false,
        axisLine: { lineStyle: { color: pal.axisLine } },
        axisTick: { show: false },
        axisLabel: {
          color: pal.muted,
          fontSize: 11,
          interval: 0,
          hideOverlap: true,
          formatter: (value: string) => (labelSet.has(value) ? value : ""),
        },
        splitLine: { show: false },
      },
      {
        type: "category",
        gridIndex: 1,
        data: times,
        boundaryGap: false,
        axisLine: { lineStyle: { color: pal.axisLine } },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        type: "value",
        min: yMin,
        max: yMax,
        interval: maxAbs / 2,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { type: "dashed", color: pal.grid } },
        axisLabel: {
          fontSize: 11,
          formatter: (v: number) => {
            const t = v.toFixed(2);
            if (v > pre + 1e-6) return `{up|${t}}`;
            if (v < pre - 1e-6) return `{down|${t}}`;
            return `{mid|${t}}`;
          },
          rich: {
            up: { color: UP, fontSize: 11 },
            down: { color: DOWN, fontSize: 11 },
            mid: { color: pal.midLabel, fontSize: 11 },
          },
        },
      },
      {
        type: "value",
        min: -pctMax,
        max: pctMax,
        interval: pctMax / 2,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          fontSize: 11,
          formatter: (v: number) => {
            if (v > 1e-6) return `{up|${Math.abs(v).toFixed(2)}%}`;
            if (v < -1e-6) return `{down|-${Math.abs(v).toFixed(2)}%}`;
            return `{mid|0%}`;
          },
          rich: {
            up: { color: UP, fontSize: 11 },
            down: { color: DOWN, fontSize: 11 },
            mid: { color: pal.midLabel, fontSize: 11 },
          },
        },
      },
      {
        type: "value",
        gridIndex: 1,
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        splitNumber: 2,
        splitLine: { show: false },
        axisLabel: { show: false },
      },
    ],
    series: [
      {
        name: "分时",
        type: "line",
        data: prices,
        connectNulls: false,
        showSymbol: false,
        symbol: "none",
        lineStyle: { width: 1.5, color: PRICE_LINE },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: pal.areaTop },
            { offset: 1, color: pal.areaBottom },
          ]),
        },
        markLine: {
          symbol: "none",
          silent: true,
          animation: false,
          label: { show: false },
          data: [{ yAxis: pre }],
          lineStyle: { type: "solid", color: pal.markLine, width: 1 },
        },
        z: 3,
      },
      {
        name: "均价",
        type: "line",
        data: avgs,
        connectNulls: false,
        showSymbol: false,
        symbol: "none",
        lineStyle: { width: 1.2, color: AVG_LINE },
        z: 4,
      },
      {
        name: "涨跌幅",
        type: "line",
        yAxisIndex: 1,
        data: prices.map((p) => (typeof p === "number" ? ((p - pre) / pre) * 100 : null)),
        connectNulls: false,
        showSymbol: false,
        symbol: "none",
        lineStyle: { width: 0, opacity: 0 },
        tooltip: { show: false },
        silent: true,
      },
      {
        name: "成交量",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 2,
        data: volData,
        barMaxWidth: 4,
      },
    ],
  };
}

function buildKlineOption(bars: KBar[], dark: boolean) {
  const pal = chartPalette(dark);
  const dates = bars.map((b) => b.date);
  const values = bars.map((b) => [b.open, b.close, b.low, b.high]);
  const vols = bars.map((b) => b.volume ?? 0);
  const closes = bars.map((b) => b.close);
  const { dif, dea, hist } = macdOf(closes);
  const labelStep = Math.max(1, Math.floor(dates.length / 6));
  const ptrBg = dark ? "#484f58" : "#334155";

  return {
    backgroundColor: pal.bg,
    animation: false,
    axisPointer: {
      link: [{ xAxisIndex: "all" }],
      label: { backgroundColor: ptrBg, color: "#fff" },
    },
    tooltip: { show: false },
    grid: [
      { left: 12, right: 68, top: 12, height: "52%" },
      { left: 12, right: 68, top: "68%", height: "12%" },
      { left: 12, right: 68, top: "84%", height: "12%" },
    ],
    xAxis: [
      {
        type: "category",
        data: dates,
        boundaryGap: true,
        axisLabel: {
          color: pal.muted,
          fontSize: 11,
          interval: (idx: number) => idx % labelStep === 0,
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: pal.axisLine } },
        splitLine: { show: false },
        axisPointer: {
          show: true,
          type: "line",
          label: { show: true, backgroundColor: ptrBg },
          lineStyle: { type: "dashed", color: pal.pointer },
        },
      },
      {
        type: "category",
        gridIndex: 1,
        data: dates,
        boundaryGap: true,
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: pal.axisLine } },
        axisPointer: { label: { show: false } },
      },
      {
        type: "category",
        gridIndex: 2,
        data: dates,
        boundaryGap: true,
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: pal.axisLine } },
        axisPointer: { label: { show: false } },
      },
    ],
    yAxis: [
      {
        type: "value",
        scale: true,
        position: "right",
        splitLine: { lineStyle: { type: "dashed", color: pal.grid } },
        axisLabel: { color: pal.muted, fontSize: 11 },
        axisPointer: {
          show: true,
          label: { show: true, backgroundColor: ptrBg, precision: 2 },
        },
      },
      {
        type: "value",
        gridIndex: 1,
        scale: true,
        position: "right",
        splitNumber: 2,
        splitLine: { show: false },
        axisLabel: { show: false },
        axisPointer: { label: { show: false } },
      },
      {
        type: "value",
        gridIndex: 2,
        scale: true,
        position: "right",
        splitNumber: 2,
        splitLine: { lineStyle: { type: "dashed", color: pal.grid } },
        axisLabel: { color: pal.muted, fontSize: 10 },
        axisPointer: { label: { show: false } },
      },
    ],
    series: [
      {
        name: "日K",
        type: "candlestick",
        data: values,
        itemStyle: {
          color: dark ? pal.bg : "#ffffff",
          color0: DOWN,
          borderColor: UP,
          borderColor0: DOWN,
          borderWidth: 1,
        },
      },
      {
        name: "MA5",
        type: "line",
        data: smaSeries(closes, 5),
        showSymbol: false,
        lineStyle: { width: 1, color: MA5_C },
        z: 3,
      },
      {
        name: "MA10",
        type: "line",
        data: smaSeries(closes, 10),
        showSymbol: false,
        lineStyle: { width: 1, color: MA10_C },
        z: 3,
      },
      {
        name: "MA20",
        type: "line",
        data: smaSeries(closes, 20),
        showSymbol: false,
        lineStyle: { width: 1, color: MA20_C },
        z: 3,
      },
      {
        name: "成交量",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: vols.map((v, i) => ({
          value: v,
          itemStyle: { color: bars[i].close >= bars[i].open ? UP : DOWN },
        })),
      },
      {
        name: "MACD",
        type: "bar",
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: hist.map((v) => ({
          value: +v.toFixed(4),
          itemStyle: { color: v >= 0 ? UP : DOWN },
        })),
      },
      {
        name: "DIF",
        type: "line",
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: dif.map((v) => +v.toFixed(4)),
        showSymbol: false,
        lineStyle: { width: 1, color: DIF_C },
      },
      {
        name: "DEA",
        type: "line",
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: dea.map((v) => +v.toFixed(4)),
        showSymbol: false,
        lineStyle: { width: 1, color: DEA_C },
      },
    ],
  };
}

function klineCacheFresh(bars: KBar[]): boolean {
  if (!bars.length) return false;
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 9 * 60 + 25) return true;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return (bars[bars.length - 1].date || "").slice(0, 10) >= today;
}

function emptyTitle(text: string, dark: boolean) {
  const pal = chartPalette(dark);
  return {
    backgroundColor: pal.bg,
    title: {
      text,
      left: "center",
      top: "middle",
      textStyle: { color: pal.muted, fontSize: 14, fontWeight: 400 },
    },
  };
}

function KInfoBar({ bars, index }: { bars: KBar[]; index: number }) {
  const i = index >= 0 && index < bars.length ? index : bars.length - 1;
  const b = bars[i];
  if (!b) return null;
  const pct = barPct(bars, i);
  const up = pct >= 0;
  const tone = up ? UP : DOWN;
  const closes = bars.map((x) => x.close);
  const ma5 = smaAt(closes, i, 5);
  const ma10 = smaAt(closes, i, 10);
  const ma20 = smaAt(closes, i, 20);
  const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(2));
  return (
    <div className="chart-k-info">
      <span className="k-date">{b.date}</span>
      <span>
        开 <b style={{ color: tone }}>{b.open.toFixed(2)}</b>
      </span>
      <span>
        高 <b style={{ color: tone }}>{b.high.toFixed(2)}</b>
      </span>
      <span>
        低 <b style={{ color: tone }}>{b.low.toFixed(2)}</b>
      </span>
      <span>
        收 <b style={{ color: tone }}>{b.close.toFixed(2)}</b>
      </span>
      <span>
        涨幅 <b style={{ color: tone }}>{pct.toFixed(2)}%</b>
      </span>
      <span>
        MA5: <b style={{ color: MA5_C }}>{fmt(ma5)}</b>
      </span>
      <span>
        MA10: <b style={{ color: MA10_C }}>{fmt(ma10)}</b>
      </span>
      <span>
        MA20: <b style={{ color: MA20_C }}>{fmt(ma20)}</b>
      </span>
    </div>
  );
}

export function StockChartModal({
  stock,
  open,
  onClose,
}: {
  stock: ChartStock | null;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"trends" | "kline">("trends");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [trends, setTrends] = useState<{
    points: TrendPoint[];
    preClose: number;
    tradeDate?: string;
  } | null>(null);
  const [klines, setKlines] = useState<KBar[] | null>(null);
  const [kIndex, setKIndex] = useState(-1);
  const [dark, setDark] = useState(() => readDark());

  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const kPickRef = useRef<(i: number) => void>(() => undefined);
  kPickRef.current = (i: number) => setKIndex(i);

  useEffect(() => {
    const sync = () => setDark(readDark());
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);


  const disposeChart = useCallback(() => {
    roRef.current?.disconnect();
    roRef.current = null;
    chartRef.current?.dispose();
    chartRef.current = null;
  }, []);

  const ensureChart = useCallback((el: HTMLDivElement) => {
    if (chartRef.current) {
      const dom = chartRef.current.getDom();
      if (dom === el) return chartRef.current;
      disposeChart();
    }
    const chart = echarts.init(el);
    chartRef.current = chart;
    roRef.current = new ResizeObserver(() => {
      chart.resize();
    });
    roRef.current.observe(el);
    return chart;
  }, [disposeChart]);

  const paint = useCallback(() => {
    const el = boxRef.current;
    if (!el || el.clientWidth < 8 || el.clientHeight < 8) return false;

    const chart = ensureChart(el);
    try {
      if (tab === "trends") {
        if (!trends) return false;
        if (!trends.points.length) {
          chart.clear();
          chart.setOption(emptyTitle("暂无分时数据", dark), true);
        } else {
          chart.setOption(buildTrendOption(trends.points, trends.preClose, dark), true);
        }
      } else {
        if (!klines) return false;
        if (!klines.length) {
          chart.clear();
          chart.setOption(emptyTitle("暂无日线数据", dark), true);
        } else {
          chart.setOption(buildKlineOption(klines, dark), true);
          chart.off("click");
          chart.on("click", (p: { dataIndex?: number }) => {
            if (typeof p?.dataIndex === "number") kPickRef.current(p.dataIndex);
          });
          chart.off("updateAxisPointer");
          chart.on("updateAxisPointer", (raw: unknown) => {
            const ev = raw as { axesInfo?: { value?: number | string }[] };
            const axes = ev?.axesInfo || [];
            for (const ax of axes) {
              if (typeof ax.value === "number" && ax.value >= 0 && ax.value < klines.length) {
                kPickRef.current(Math.round(ax.value));
                return;
              }
              if (typeof ax.value === "string") {
                const idx = klines.findIndex((b) => b.date === ax.value);
                if (idx >= 0) {
                  kPickRef.current(idx);
                  return;
                }
              }
            }
          });
        }
      }
      chart.resize();
      return true;
    } catch (e) {
      console.error("chart paint failed", e);
      setError("图表渲染失败");
      return false;
    }
  }, [ensureChart, tab, trends, klines, dark]);

  // 打开时立刻拉分时；切日线时再拉 K 线。数据与挂载解耦。
  useEffect(() => {
    if (!open || !stock) return;
    let cancelled = false;

    const load = async () => {
      setError("");
      try {
        if (tab === "trends") {
          const ckey = `trends:${stock.code}`;
          const cached = cacheGet<{
            points: TrendPoint[];
            preClose: number;
            tradeDate?: string;
          }>(ckey);
          if (cached?.points?.length) {
            setTrends(cached);
            setLoading(false);
          } else {
            setLoading(true);
          }
          const res = await fetch(`/api/stock/${stock.code}/trends`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (cancelled) return;
          const next = {
            points: (data.points || []) as TrendPoint[],
            preClose: Number(data.pre_close) || 0,
            tradeDate: String(data.trade_date || ""),
          };
          setTrends(next);
          if (next.points.length) cacheSet(ckey, next, 20);
        } else {
          const ckey = `kline:${stock.code}:120`;
          const cached = cacheGet<KBar[]>(ckey);
          if (cached?.length && klineCacheFresh(cached)) {
            setKlines(cached);
            setKIndex(cached.length - 1);
            setLoading(false);
          } else {
            setLoading(true);
          }
          const res = await fetch(`/api/stock/${stock.code}/kline?limit=120`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (cancelled) return;
          const bars = (data.bars || []) as KBar[];
          setKlines(bars);
          setKIndex(bars.length ? bars.length - 1 : -1);
          if (bars.length && klineCacheFresh(bars)) cacheSet(ckey, bars, 30);
        }
      } catch (e) {
        if (!cancelled) {
          console.error(e);
          setError(tab === "trends" ? "分时数据加载失败" : "日线数据加载失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, stock, tab]);

  // 数据或 tab 变化后反复尝试绘制（等 Modal 布局完成）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let tries = 0;

    const tick = () => {
      if (cancelled) return;
      if (paint()) return;
      tries += 1;
      if (tries < 40) {
        window.setTimeout(tick, 50);
      }
    };

    // 下一帧开始，避开 Modal 入场动画首帧宽高为 0
    const t0 = window.setTimeout(tick, 0);
    const t1 = window.setTimeout(tick, 100);
    const t2 = window.setTimeout(tick, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [open, stock, tab, trends, klines, paint]);

  // 关闭时清理
  useEffect(() => {
    if (open) return;
    disposeChart();
    setTrends(null);
    setKlines(null);
    setKIndex(-1);
    setError("");
    setTab("trends");
  }, [open, disposeChart]);

  const setBoxRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        disposeChart();
        boxRef.current = null;
        return;
      }
      boxRef.current = el;
      if (open) {
        window.requestAnimationFrame(() => paint());
      }
    },
    [open, paint, disposeChart],
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="78vw"
      style={{ top: "6vh", paddingBottom: 0 }}
      className="stock-chart-modal"
      styles={{
        body: {
          height: "calc(80vh - 72px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          paddingTop: 4,
        },
      }}
      destroyOnHidden
      forceRender={false}
      title={
        <div className="chart-tabbar">
          <span className="chart-stock-name">{stock?.name || "—"}</span>
          <span className="chart-stock-code">{stock?.code}</span>
          <button
            type="button"
            className={tab === "trends" ? "chart-tab on" : "chart-tab"}
            onClick={() => setTab("trends")}
          >
            分时图
          </button>
          <button
            type="button"
            className={tab === "kline" ? "chart-tab on" : "chart-tab"}
            onClick={() => setTab("kline")}
          >
            日线图
          </button>
        </div>
      }
    >
      <div className="stock-chart-sheet">
        {tab === "trends" && trends?.tradeDate ? (
          <div className="chart-k-info">
            <span className="k-date">分时 · {trends.tradeDate}</span>
          </div>
        ) : null}
        {tab === "kline" && klines?.length ? (
          <KInfoBar bars={klines} index={kIndex} />
        ) : null}
        <div className="stock-chart-body">
          <Spin spinning={loading} className="stock-chart-spin">
            <div
              ref={setBoxRef}
              className="stock-chart-box"
              key={`${stock?.code || "x"}-${tab}-${open ? "1" : "0"}`}
            />
            {error ? <div className="chart-error">{error}</div> : null}
          </Spin>
        </div>
      </div>
    </Modal>
  );
}
