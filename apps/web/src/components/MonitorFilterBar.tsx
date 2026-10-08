import { Button, Input, InputNumber, Select, Space } from "antd";
import type { StockItem } from "../types";

export interface MonitorFilter {
  keyword: string;
  sealTimeFrom: string;
  sealTimeTo: string;
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

function RangeYi({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min: number | null;
  max: number | null;
  onMin: (v: number | null) => void;
  onMax: (v: number | null) => void;
}) {
  return (
    <Space size={4} className="filter-item">
      <span className="filter-label">{label}</span>
      <InputNumber
        size="small"
        min={0}
        step={0.5}
        placeholder="最小"
        value={min}
        onChange={(v) => onMin(typeof v === "number" ? v : null)}
        style={{ width: 72 }}
      />
      <span className="filter-sep">~</span>
      <InputNumber
        size="small"
        min={0}
        step={0.5}
        placeholder="最大"
        value={max}
        onChange={(v) => onMax(typeof v === "number" ? v : null)}
        style={{ width: 72 }}
      />
      <span className="filter-unit">亿</span>
    </Space>
  );
}

export function MonitorFilterBar({
  value,
  onChange,
  regions,
  resultCount,
  totalCount,
}: {
  value: MonitorFilter;
  onChange: (v: MonitorFilter) => void;
  regions: string[];
  resultCount: number;
  totalCount: number;
}) {
  const patch = (p: Partial<MonitorFilter>) => onChange({ ...value, ...p });

  return (
    <div className="monitor-filter-bar">
      <Space size={4} className="filter-item">
        <span className="filter-label">名称</span>
        <Input
          size="small"
          allowClear
          placeholder="名称/代码模糊搜索"
          value={value.keyword}
          onChange={(e) => patch({ keyword: e.target.value })}
          style={{ width: 160 }}
        />
      </Space>

      <Space size={4} className="filter-item" wrap>
        <span className="filter-label">涨停时间</span>
        <Input
          size="small"
          placeholder="09:30"
          value={value.sealTimeFrom}
          onChange={(e) => patch({ sealTimeFrom: e.target.value })}
          style={{ width: 72 }}
          allowClear
        />
        <span className="filter-sep">~</span>
        <Input
          size="small"
          placeholder="15:00"
          value={value.sealTimeTo}
          onChange={(e) => patch({ sealTimeTo: e.target.value })}
          style={{ width: 72 }}
          allowClear
        />
      </Space>

      <RangeYi
        label="成交额"
        min={value.amountMinYi}
        max={value.amountMaxYi}
        onMin={(v) => patch({ amountMinYi: v })}
        onMax={(v) => patch({ amountMaxYi: v })}
      />
      <RangeYi
        label="自由流通"
        min={value.freeFloatMinYi}
        max={value.freeFloatMaxYi}
        onMin={(v) => patch({ freeFloatMinYi: v })}
        onMax={(v) => patch({ freeFloatMaxYi: v })}
      />
      <RangeYi
        label="实际流通"
        min={value.floatMinYi}
        max={value.floatMaxYi}
        onMin={(v) => patch({ floatMinYi: v })}
        onMax={(v) => patch({ floatMaxYi: v })}
      />

      <Space size={4} className="filter-item">
        <span className="filter-label">地域</span>
        <Select
          size="small"
          allowClear
          showSearch
          placeholder="全部"
          value={value.region || undefined}
          onChange={(v) => patch({ region: v || "" })}
          options={regions.map((r) => ({ label: r, value: r }))}
          style={{ width: 110 }}
          optionFilterProp="label"
        />
      </Space>

      <Space size={8} className="filter-actions">
        <span className="filter-count">
          {resultCount}/{totalCount}
        </span>
        <Button size="small" onClick={() => onChange({ ...EMPTY_FILTER })}>
          重置
        </Button>
      </Space>
    </div>
  );
}
