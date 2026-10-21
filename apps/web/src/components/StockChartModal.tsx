import { Modal, Spin } from "antd";
import * as echarts from "echarts";
import { useCallback, useEffect, useRef, useState } from "react";
import { cacheGet, cacheSet } from "../lib/localCache";

type ChartStock = { code: string; name: string };
type TrendPoint = {
  time: string;
  price: number;
  avg: number;
  volume: number;
  amount?: number | null;
};
type KBar = {
  date: string;
  open: number;
  close: number;
  low: number;
  high: number;
  volume?: number;
  amount?: number | null;
  amplitude?: number | null;
  pct?: number;
  change?: number | null;
  turnover?: number | null;
};

const UP = "#e11d2e";
const DOWN = "#0a8f3d";
const PRICE_LINE = "#2563eb";
const AVG_LINE = "#f59e0b";
const MA5_C = "#94a3b8";
const MA10_C = "#eab308";
const MA20_C = "#a855f7";
const MA30_C = "#22c55e";
const MA60_C = "#3b82f6";
const VOL_MA5_C = "#f59e0b";
const VOL_MA10_C = "#a855f7";

const KLINE_LIMIT = 500;
const KLINE_VIEW = 100;

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
      bg: "#12181f",
      text: "#e6edf3",
      muted: "#8b949e",
      grid: "#1e2730",
      axisLine: "#30363d",
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
    text: "#111827",
    muted: "#6b7280",
    grid: "#eef2f7",
    axisLine: "#d1d5db",
    midLabel: "#111827",
    tooltipBg: "rgba(255,255,255,0.98)",
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

function barChange(bars: KBar[], index: number): number {
  const b = bars[index];
  if (!b) return 0;
  if (typeof b.change === "number" && !Number.isNaN(b.change)) return b.change;
  const prev = index > 0 ? bars[index - 1].close : 0;
  if (prev > 0) return b.close - prev;
  return 0;
}

function barAmplitude(bars: KBar[], index: number): number | null {
  const b = bars[index];
  if (!b) return null;
  if (typeof b.amplitude === "number" && !Number.isNaN(b.amplitude)) return b.amplitude;
  const prev = index > 0 ? bars[index - 1].close : 0;
  if (prev > 0 && b.high > 0 && b.low > 0) {
    return ((b.high - b.low) / prev) * 100;
  }
  return null;
}

function fmtVolHands(volume?: number | null): string {
  if (volume == null || Number.isNaN(volume) || volume <= 0) return "—";
  const hands = volume >= 100 ? volume / 100 : volume;
  if (hands >= 1e8) return `${(hands / 1e8).toFixed(2)}亿`;
  if (hands >= 1e4) return `${(hands / 1e4).toFixed(2)}万`;
  return `${hands.toFixed(0)}`;
}

function fmtAmount(amount?: number | null): string {
  if (amount == null || Number.isNaN(amount) || amount <= 0) return "—";
  if (amount >= 1e8) return `${(amount / 1e8).toFixed(2)}亿`;
  if (amount >= 1e4) return `${(amount / 1e4).toFixed(2)}万`;
  return amount.toFixed(0);
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

function tipRow(
  label: string,
  value: string,
  color?: string,
): string {
  const valStyle = color
    ? `color:${color};font-weight:600`
    : "font-weight:600";
  return `<div style="display:flex;justify-content:space-between;gap:24px;line-height:1.7"><span style="color:inherit;opacity:.72">${label}</span><span style="${valStyle}">${value}</span></div>`;
}

function priceTone(v: number, base: number): string {
  if (v > base + 1e-9) return UP;
  if (v < base - 1e-9) return DOWN;
  return "inherit";
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
    return { value: v / 100, itemStyle: { color: up ? UP : DOWN } };
  });

  const labelSet = new Set([
    "09:30",
    "10:30",
    "11:30",
    "13:00",
    "14:00",
    "15:00",
    "14:57",
  ]);

  return {
    backgroundColor: pal.bg,
    animation: false,
    axisPointer: {
      link: [{ xAxisIndex: "all" }],
      label: { show: false },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "cross",
        label: { show: false },
        lineStyle: { color: pal.pointer, type: "dashed", width: 1 },
      },
      backgroundColor: pal.tooltipBg,
      borderColor: pal.tooltipBorder,
      borderWidth: 1,
      padding: [8, 12],
      extraCssText: "box-shadow:0 4px 14px rgba(0,0,0,.12);",
      textStyle: { color: pal.text, fontSize: 12 },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [];
        if (!list.length) return "";
        const idx = (list[0] as { dataIndex?: number }).dataIndex ?? 0;
        const p = filled[idx];
        if (!p) return `${times[idx] || ""}<br/>暂无数据`;
        const chg = ((p.price - pre) / pre) * 100;
        const chgColor = chg >= 0 ? UP : DOWN;
        const rows = [
          `<div style="font-weight:700;margin-bottom:4px">${p.time}</div>`,
          tipRow("价格", p.price.toFixed(2), chgColor),
          tipRow("均价", p.avg.toFixed(2), AVG_LINE),
          tipRow(
            "涨跌幅",
            `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`,
            chgColor,
          ),
          tipRow("成交量", `${fmtVolHands(p.volume)}手`),
        ];
        if (p.amount != null && p.amount > 0) {
          rows.push(tipRow("成交额", fmtAmount(p.amount)));
        }
        return rows.join("");
      },
    },
    grid: [
      { left: 56, right: 56, top: 18, height: "62%" },
      { left: 56, right: 56, top: "78%", height: "16%" },
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
          formatter: (value: string) => {
            if (value === "11:30") return "11:30/13:00";
            if (value === "14:57") return "15:00";
            return labelSet.has(value) ? value : "";
          },
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
        axisPointer: { label: { show: false } },
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
        axisPointer: { label: { show: false } },
        axisLabel: {
          fontSize: 11,
          formatter: (v: number) => {
            if (v > 1e-6) return `{up|${Math.abs(v).toFixed(2)}%}`;
            if (v < -1e-6) return `{down|-${Math.abs(v).toFixed(2)}%}`;
            return `{mid|0.00%}`;
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
        axisPointer: { label: { show: false } },
        axisLabel: {
          show: true,
          color: pal.muted,
          fontSize: 10,
          formatter: (v: number) => {
            if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
            return `${Math.round(v)}`;
          },
        },
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

function normBarDate(d: string): string {
  const raw = (d || "").replace(/-/g, "").trim();
  if (raw.length >= 8) return raw.slice(0, 8);
  return "";
}

function buildKlineOption(bars: KBar[], dark: boolean, focusDate?: string) {
  const pal = chartPalette(dark);
  const dates = bars.map((b) => b.date);
  const values = bars.map((b) => [b.open, b.close, b.low, b.high]);
  const vols = bars.map((b) => b.volume ?? 0);
  const closes = bars.map((b) => b.close);
  const n = dates.length;
  const view = Math.min(KLINE_VIEW, n);
  const focus = normBarDate(focusDate || "");
  let startPct = n > 0 ? Math.max(0, ((n - view) / n) * 100) : 0;
  let endPct = 100;
  if (focus && n > 0) {
    const idx = dates.findIndex((d) => normBarDate(d) === focus);
    if (idx >= 0) {
      const half = Math.floor(view / 2);
      const from = Math.max(0, idx - half);
      const to = Math.min(n - 1, from + view - 1);
      const from2 = Math.max(0, to - view + 1);
      startPct = (from2 / n) * 100;
      endPct = ((to + 1) / n) * 100;
    }
  }
  const ptrBg = dark ? "#484f58" : "#334155";

  return {
    backgroundColor: pal.bg,
    animation: false,
    legend: { show: false },
    axisPointer: {
      link: [{ xAxisIndex: "all" }],
      label: { backgroundColor: ptrBg, color: "#fff" },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "cross",
        label: { backgroundColor: ptrBg },
        lineStyle: { color: pal.pointer, type: "dashed", width: 1 },
      },
      backgroundColor: pal.tooltipBg,
      borderColor: pal.tooltipBorder,
      borderWidth: 1,
      padding: [10, 12],
      extraCssText: "box-shadow:0 6px 18px rgba(0,0,0,.14);min-width:168px;",
      textStyle: { color: pal.text, fontSize: 12 },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [];
        if (!list.length) return "";
        const idx = (list[0] as { dataIndex?: number }).dataIndex ?? 0;
        const b = bars[idx];
        if (!b) return "";
        const prevClose = idx > 0 ? bars[idx - 1].close : b.open;
        const pct = barPct(bars, idx);
        const chg = barChange(bars, idx);
        const amp = barAmplitude(bars, idx);
        const tone = pct >= 0 ? UP : DOWN;
        return [
          `<div style="font-weight:700;margin-bottom:6px">${b.date}</div>`,
          tipRow("开盘", b.open.toFixed(2), priceTone(b.open, prevClose)),
          tipRow("收盘", b.close.toFixed(2), tone),
          tipRow("最高", b.high.toFixed(2), priceTone(b.high, prevClose)),
          tipRow("最低", b.low.toFixed(2), priceTone(b.low, prevClose)),
          tipRow("涨跌幅", `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`, tone),
          tipRow("涨跌额", `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}`, tone),
          tipRow("成交量", `${fmtVolHands(b.volume)}手`),
          tipRow("成交额", fmtAmount(b.amount)),
          tipRow("振幅", amp != null ? `${amp.toFixed(2)}%` : "—"),
          tipRow(
            "换手率",
            b.turnover != null && !Number.isNaN(b.turnover)
              ? `${b.turnover.toFixed(2)}%`
              : "—",
          ),
        ].join("");
      },
    },
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: [0, 1],
        start: startPct,
        end: endPct,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
        preventDefaultMouseMove: true,
      },
    ],
    grid: [
      { left: 12, right: 64, top: 28, height: "58%" },
      { left: 12, right: 64, top: "74%", height: "18%" },
    ],
    xAxis: [
      {
        type: "category",
        data: dates,
        boundaryGap: true,
        axisLabel: {
          color: pal.muted,
          fontSize: 11,
          hideOverlap: true,
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
        axisLabel: {
          show: true,
          color: pal.muted,
          fontSize: 10,
          formatter: (v: number) => {
            const hands = v / 100;
            if (hands >= 1e4) return `${(hands / 1e4).toFixed(1)}万`;
            return `${Math.round(hands)}`;
          },
        },
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
        name: "MA30",
        type: "line",
        data: smaSeries(closes, 30),
        showSymbol: false,
        lineStyle: { width: 1, color: MA30_C },
        z: 3,
      },
      {
        name: "MA60",
        type: "line",
        data: smaSeries(closes, 60),
        showSymbol: false,
        lineStyle: { width: 1, color: MA60_C },
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
        barMaxWidth: 8,
      },
      {
        name: "VOL-MA5",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: smaSeries(vols, 5),
        showSymbol: false,
        lineStyle: { width: 1, color: VOL_MA5_C },
        z: 3,
      },
      {
        name: "VOL-MA10",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: smaSeries(vols, 10),
        showSymbol: false,
        lineStyle: { width: 1, color: VOL_MA10_C },
        z: 3,
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
  const closes = bars.map((x) => x.close);
  const vols = bars.map((x) => x.volume ?? 0);
  const ma5 = smaAt(closes, i, 5);
  const ma10 = smaAt(closes, i, 10);
  const ma20 = smaAt(closes, i, 20);
  const ma30 = smaAt(closes, i, 30);
  const ma60 = smaAt(closes, i, 60);
  const vma5 = smaAt(vols, i, 5);
  const vma10 = smaAt(vols, i, 10);
  return (
    <div className="chart-k-info">
      <span className="k-date">{b.date}</span>
      <span>
        MA5: <b style={{ color: MA5_C }}>{fmtNum(ma5)}</b>
      </span>
      <span>
        MA10: <b style={{ color: MA10_C }}>{fmtNum(ma10)}</b>
      </span>
      <span>
        MA20: <b style={{ color: MA20_C }}>{fmtNum(ma20)}</b>
      </span>
      <span>
        MA30: <b style={{ color: MA30_C }}>{fmtNum(ma30)}</b>
      </span>
      <span>
        MA60: <b style={{ color: MA60_C }}>{fmtNum(ma60)}</b>
      </span>
      <span>
        成交量: <b>{fmtVolHands(b.volume)}</b>
      </span>
      <span>
        MA5: <b style={{ color: VOL_MA5_C }}>{fmtVolHands(vma5)}</b>
      </span>
      <span>
        MA10: <b style={{ color: VOL_MA10_C }}>{fmtVolHands(vma10)}</b>
      </span>
    </div>
  );
}

export function StockChartModal({
  stock,
  open,
  onClose,
  asOfDate,
}: {
  stock: ChartStock | null;
  open: boolean;
  onClose: () => void;
  /** 历史回溯指定交易日 YYYYMMDD / YYYY-MM-DD，分时按该日、日K定位到该日 */
  asOfDate?: string | null;
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
  const focusDay = normBarDate(asOfDate || "");
  const focusDayLabel = focusDay
    ? `${focusDay.slice(0, 4)}-${focusDay.slice(4, 6)}-${focusDay.slice(6, 8)}`
    : "";

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

  useEffect(() => {
    if (!open) return;
    setTab("trends");
    setTrends(null);
    setKlines(null);
    setKIndex(-1);
    setError("");
  }, [open, stock?.code, focusDay]);

  const disposeChart = useCallback(() => {
    roRef.current?.disconnect();
    roRef.current = null;
    chartRef.current?.dispose();
    chartRef.current = null;
  }, []);

  const ensureChart = useCallback(
    (el: HTMLDivElement) => {
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
    },
    [disposeChart],
  );

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
          chart.setOption(buildKlineOption(klines, dark, focusDay || undefined), true);
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
  }, [ensureChart, tab, trends, klines, dark, focusDay]);

  useEffect(() => {
    if (!open || !stock) return;
    let cancelled = false;

    const load = async () => {
      setError("");
      try {
        if (tab === "trends") {
          const ckey = `trends:${stock.code}:${focusDay || "latest"}`;
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
          const q = focusDay
            ? `?date=${encodeURIComponent(focusDay)}`
            : "";
          const res = await fetch(`/api/stock/${stock.code}/trends${q}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (cancelled) return;
          const next = {
            points: (data.points || []) as TrendPoint[],
            preClose: Number(data.pre_close) || 0,
            tradeDate: String(data.trade_date || focusDay || ""),
          };
          setTrends(next);
          if (next.points.length) {
            cacheSet(ckey, next, focusDay ? 30 * 60 : 20);
          } else if (focusDay) {
            setError(`暂无 ${focusDay.slice(0, 4)}-${focusDay.slice(4, 6)}-${focusDay.slice(6, 8)} 分时数据`);
          }
        } else {
          const ckey = `kline:v4:${stock.code}:${KLINE_LIMIT}`;
          const cached = cacheGet<KBar[]>(ckey);
          if (cached?.length && (focusDay || klineCacheFresh(cached))) {
            setKlines(cached);
            const fi = focusDay
              ? cached.findIndex((b) => normBarDate(b.date) === focusDay)
              : -1;
            setKIndex(fi >= 0 ? fi : cached.length - 1);
            setLoading(false);
          } else {
            setLoading(true);
          }
          const res = await fetch(
            `/api/stock/${stock.code}/kline?limit=${KLINE_LIMIT}`,
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (cancelled) return;
          const bars = (data.bars || []) as KBar[];
          setKlines(bars);
          const fi = focusDay
            ? bars.findIndex((b) => normBarDate(b.date) === focusDay)
            : -1;
          setKIndex(fi >= 0 ? fi : bars.length ? bars.length - 1 : -1);
          if (bars.length && (focusDay || klineCacheFresh(bars))) {
            cacheSet(ckey, bars, 30);
          }
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
  }, [open, stock, tab, focusDay]);

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
            分时
          </button>
          <button
            type="button"
            className={tab === "kline" ? "chart-tab on" : "chart-tab"}
            onClick={() => setTab("kline")}
          >
            日K
          </button>
        </div>
      }
    >
      <div className="stock-chart-sheet">
        {tab === "trends" && (trends?.tradeDate || focusDayLabel) ? (
          <div className="chart-k-info">
            <span className="k-date">
              分时 ·{" "}
              {(() => {
                const raw = String(trends?.tradeDate || focusDayLabel || "");
                const d = normBarDate(raw);
                return d
                  ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
                  : raw;
              })()}
            </span>
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
              key={`${stock?.code || "x"}-${tab}-${focusDay || "live"}-${open ? "1" : "0"}`}
            />
            {error ? <div className="chart-error">{error}</div> : null}
          </Spin>
        </div>
      </div>
    </Modal>
  );
}
