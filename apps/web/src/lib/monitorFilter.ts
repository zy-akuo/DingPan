import type { StockItem } from "../types";

export interface MonitorFilter {
  keyword: string;
  sealTimeFrom: string;
  sealTimeTo: string;
  priceMin: number | null;
  priceMax: number | null;
  amountMinYi: number | null;
  amountMaxYi: number | null;
  freeFloatMinYi: number | null;
  freeFloatMaxYi: number | null;
  floatMinYi: number | null;
  floatMaxYi: number | null;
  region: string;
}

export const EMPTY_FILTER: MonitorFilter = {
  keyword: "",
  sealTimeFrom: "",
  sealTimeTo: "",
  priceMin: null,
  priceMax: null,
  amountMinYi: null,
  amountMaxYi: null,
  freeFloatMinYi: null,
  freeFloatMaxYi: null,
  floatMinYi: null,
  floatMaxYi: null,
  region: "",
};

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

function inYiRange(value: number | null | undefined, minYi: number | null, maxYi: number | null): boolean {
  if (minYi == null && maxYi == null) return true;
  if (value == null || Number.isNaN(value)) return false;
  const yi = value / 1e8;
  if (minYi != null && yi < minYi) return false;
  if (maxYi != null && yi > maxYi) return false;
  return true;
}

function inPriceRange(
  value: number | null | undefined,
  min: number | null,
  max: number | null,
): boolean {
  if (min == null && max == null) return true;
  if (value == null || Number.isNaN(Number(value))) return false;
  const price = Number(value);
  if (min != null && price < min) return false;
  if (max != null && price > max) return false;
  return true;
}

export function applyMonitorFilter(list: StockItem[], f: MonitorFilter): StockItem[] {
  const fromSec = timeToSec(f.sealTimeFrom);
  const toSec = timeToSec(f.sealTimeTo);
  const region = (f.region || "").trim();
  const keyword = (f.keyword || "").trim().toLowerCase();

  return list.filter((s) => {
    if (keyword) {
      const name = (s.name || "").toLowerCase();
      const code = (s.code || "").toLowerCase();
      if (!name.includes(keyword) && !code.includes(keyword)) return false;
    }
    if (fromSec != null || toSec != null) {
      const t = timeToSec(s.first_seal_time);
      if (t == null) return false;
      if (fromSec != null && t < fromSec) return false;
      if (toSec != null && t > toSec) return false;
    }
    if (!inPriceRange(s.price, f.priceMin, f.priceMax)) return false;
    if (!inYiRange(s.amount, f.amountMinYi, f.amountMaxYi)) return false;
    if (!inYiRange(s.free_float_mv, f.freeFloatMinYi, f.freeFloatMaxYi)) return false;
    if (!inYiRange(s.float_mv, f.floatMinYi, f.floatMaxYi)) return false;
    if (region && !(s.region || "").includes(region)) return false;
    return true;
  });
}

export function collectRegions(list: StockItem[]): string[] {
  const set = new Set<string>();
  for (const s of list) {
    const r = (s.region || "").trim();
    if (r) set.add(r);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
}
