import type { StockItem } from "../types";

export interface SpeedFilter {
  amountMinYi: number | null;
  amountMaxYi: number | null;
  freeFloatMinYi: number | null;
  freeFloatMaxYi: number | null;
  priceMin: number | null;
  priceMax: number | null;
  majorHolderMin: number | null;
  majorHolderMax: number | null;
  ztSuccessMin: number | null;
  ztSuccessMax: number | null;
}

export const EMPTY_SPEED_FILTER: SpeedFilter = {
  amountMinYi: null,
  amountMaxYi: null,
  freeFloatMinYi: null,
  freeFloatMaxYi: null,
  priceMin: null,
  priceMax: null,
  majorHolderMin: null,
  majorHolderMax: null,
  ztSuccessMin: null,
  ztSuccessMax: null,
};

export function isSpeedFilterActive(f: SpeedFilter): boolean {
  return Object.values(f).some((v) => v != null);
}

function inRange(
  value: number | null | undefined,
  min: number | null,
  max: number | null,
  scale = 1,
): boolean {
  if (min == null && max == null) return true;
  if (value == null || Number.isNaN(value)) return false;
  const v = value / scale;
  if (min != null && v < min) return false;
  if (max != null && v > max) return false;
  return true;
}

export function applySpeedFilter(list: StockItem[], f: SpeedFilter): StockItem[] {
  return list.filter((s) => {
    if (!inRange(s.amount, f.amountMinYi, f.amountMaxYi, 1e8)) return false;
    if (!inRange(s.free_float_mv, f.freeFloatMinYi, f.freeFloatMaxYi, 1e8)) return false;
    if (!inRange(s.price, f.priceMin, f.priceMax)) return false;
    if (!inRange(s.top10_major_holder_pct, f.majorHolderMin, f.majorHolderMax)) return false;
    if (!inRange(s.zt_success_rate, f.ztSuccessMin, f.ztSuccessMax)) return false;
    return true;
  });
}

function fmtBound(min: number | null, max: number | null, unit: string): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${min}~${max}${unit}`;
  if (min != null) return `≥${min}${unit}`;
  return `≤${max}${unit}`;
}

/** 根据当前筛选值生成可读摘要（也可用作默认模板名） */
export function summarizeSpeedFilter(f: SpeedFilter): string {
  const parts = [
    fmtBound(f.amountMinYi, f.amountMaxYi, "亿成交"),
    fmtBound(f.freeFloatMinYi, f.freeFloatMaxYi, "亿流通"),
    fmtBound(f.priceMin, f.priceMax, "元"),
    fmtBound(f.majorHolderMin, f.majorHolderMax, "%持股"),
    fmtBound(f.ztSuccessMin, f.ztSuccessMax, "%成功率"),
  ].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : "空筛选";
}

export function normalizeSpeedFilter(
  raw: Partial<SpeedFilter> | null | undefined,
): SpeedFilter {
  const base = { ...EMPTY_SPEED_FILTER };
  if (!raw || typeof raw !== "object") return base;
  for (const k of Object.keys(base) as (keyof SpeedFilter)[]) {
    const v = raw[k];
    base[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return base;
}
