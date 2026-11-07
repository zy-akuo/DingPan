import { Button, Input, InputNumber, Select, Space } from "antd";
import { EMPTY_FILTER, type MonitorFilter } from "../lib/monitorFilter";

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

function RangePrice({
  min,
  max,
  onMin,
  onMax,
}: {
  min: number | null;
  max: number | null;
  onMin: (v: number | null) => void;
  onMax: (v: number | null) => void;
}) {
  return (
    <Space size={4} className="filter-item">
      <span className="filter-label">股价</span>
      <InputNumber
        size="small"
        min={0}
        step={1}
        placeholder="最低"
        value={min}
        onChange={(v) => onMin(typeof v === "number" ? v : null)}
        style={{ width: 72 }}
      />
      <span className="filter-sep">~</span>
      <InputNumber
        size="small"
        min={0}
        step={1}
        placeholder="最高"
        value={max}
        onChange={(v) => onMax(typeof v === "number" ? v : null)}
        style={{ width: 72 }}
      />
      <span className="filter-unit">元</span>
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

      <RangePrice
        min={value.priceMin}
        max={value.priceMax}
        onMin={(v) => patch({ priceMin: v })}
        onMax={(v) => patch({ priceMax: v })}
      />
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
