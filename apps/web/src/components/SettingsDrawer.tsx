import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, Drawer, Input, InputNumber, Space, Switch } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { FieldConfig } from "../types";
import {
  DEFAULT_ALERT_SPEECH_TYPES,
  DEFAULT_SPEED_TABLE_COLUMNS,
  normalizeSpeedTableColumns,
} from "../types";

function OrderedFieldManager({ title, description, columns, choices, labels, onChange, keepName = false }: {
  title: string;
  description: string;
  columns: string[];
  choices: readonly string[];
  labels: Record<string, string>;
  onChange: (columns: string[]) => void;
  keepName?: boolean;
}) {
  const [query, setQuery] = useState("");
  const selected = [...new Set(columns)];
  const omitted = choices.filter((key) => !selected.includes(key));
  const move = (index: number, direction: -1 | 1) => {
    const next = [...selected];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <section className="settings-block settings-field-manager">
      <div className="settings-section-heading"><h4>{title}</h4><span className="muted">已展示 {selected.length} 项</span></div>
      <p className="settings-section-description">{description}</p>
      <div className="speed-col-order">
        {selected.map((key, index) => {
          const label = labels[key] || key;
          const required = keepName && key === "name";
          return <div key={key} className="speed-col-order-row">
            <span className="speed-col-order-label"><span className="settings-field-index">{index + 1}.</span>{label}</span>
            <Space size={4}>
              <Button size="small" icon={<ArrowUpOutlined />} disabled={index === 0} title={`上移${label}`} aria-label={`上移${label}`} onClick={() => move(index, -1)} />
              <Button size="small" icon={<ArrowDownOutlined />} disabled={index === selected.length - 1} title={`下移${label}`} aria-label={`下移${label}`} onClick={() => move(index, 1)} />
              <Button size="small" danger icon={<DeleteOutlined />} disabled={required} title={required ? "名称列保留" : `移除${label}`} aria-label={`移除${label}`} onClick={() => onChange(selected.filter((value) => value !== key))} />
            </Space>
          </div>;
        })}
        {!selected.length && <div className="settings-field-empty">暂无展示字段，可从下方添加。</div>}
      </div>
      {omitted.length > 0 && <div className="speed-col-omitted">
        <div className="settings-section-heading"><span className="speed-col-omitted-title">未展示 · {omitted.length} 项</span>
          <Input size="small" allowClear placeholder="搜索可添加字段" value={query} onChange={(event) => setQuery(event.target.value)} style={{ width: 170 }} />
        </div>
        <div className="settings-field-options">
          {omitted.filter((key) => (labels[key] || key).includes(query.trim())).map((key) => <Button key={key} size="small" icon={<PlusOutlined />} onClick={() => onChange([...selected, key])}>{labels[key] || key}</Button>)}
        </div>
      </div>}
    </section>
  );
}

export function SettingsDrawer({
  open,
  onClose,
  available,
  value,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  available: Record<string, string>;
  value: FieldConfig;
  onSave: (v: FieldConfig) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft({
        ...value,
        table_columns: [...new Set(value.table_columns.includes("name") ? value.table_columns : ["name", ...value.table_columns])],
        detail_fields: [...new Set(value.detail_fields)],
        speed_table_columns: normalizeSpeedTableColumns(value.speed_table_columns),
      });
    }
  }, [open, value]);

  const pollSec = draft.poll_interval_sec ?? 2.5;
  const speedSec = draft.speed_poll_interval_sec ?? 1.5;
  const auctionSec = draft.auction_poll_interval_sec ?? 1;
  const alertSec = draft.alert_speech_interval_sec ?? 1;
  const alertTypes = draft.alert_speech_types ?? [...DEFAULT_ALERT_SPEECH_TYPES];
  const alertEnabled = draft.alert_speech_enabled !== false;
  const rangeWindowSec = draft.alert_range_window_sec ?? 60;
  const rangePct = draft.alert_range_pct ?? 3;
  const speedCols = useMemo(
    () => normalizeSpeedTableColumns(draft.speed_table_columns),
    [draft.speed_table_columns],
  );

  return (
    <Drawer
      title="显示与播报设置"
      open={open}
      onClose={onClose}
      width="min(560px, 100vw)"
      rootClassName="settings-drawer"
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave({
                  ...draft,
                  speech_enabled: !!draft.speech_enabled,
                  speech_mode: "realtime",
                  speech_types: draft.speech_types?.length
                    ? draft.speech_types
                    : ["zt", "lb", "zb"],
                  poll_interval_sec: Math.max(
                    1,
                    Math.min(30, Number(draft.poll_interval_sec) || 2.5),
                  ),
                  speed_poll_interval_sec: Math.max(
                    0.5,
                    Math.min(10, Number(draft.speed_poll_interval_sec) || 1.5),
                  ),
                  auction_poll_interval_sec: Math.max(
                    1,
                    Math.min(5, Number(draft.auction_poll_interval_sec) || 1),
                  ),
                  alert_speech_interval_sec: Math.max(
                    0.5,
                    Math.min(5, Number(draft.alert_speech_interval_sec) || 1),
                  ),
                  alert_range_window_sec: Math.max(
                    15,
                    Math.min(600, Number(draft.alert_range_window_sec) || 60),
                  ),
                  alert_range_pct: Math.max(
                    0.5,
                    Math.min(20, Number(draft.alert_range_pct) || 3),
                  ),
                  alert_speech_types:
                    draft.alert_speech_types ?? [...DEFAULT_ALERT_SPEECH_TYPES],
                  alert_speech_enabled: draft.alert_speech_enabled !== false,
                  show_st_stocks: draft.show_st_stocks !== false,
                  speed_table_columns: normalizeSpeedTableColumns(
                    draft.speed_table_columns,
                  ),
                });
                onClose();
              } finally {
                setSaving(false);
              }
            }}
          >
            保存
          </Button>
        </Space>
      }
    >
      <div className="settings-block">
        <h4>实时刷新</h4>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space align="center">
            <span>盘中轮询间隔</span>
            <InputNumber
              min={1}
              max={30}
              step={0.5}
              value={pollSec}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  poll_interval_sec: typeof v === "number" ? v : 2.5,
                })
              }
              addonAfter="秒"
              style={{ width: 140 }}
            />
          </Space>
          <Space align="center">
            <span>涨速榜刷新</span>
            <InputNumber
              min={0.5}
              max={10}
              step={0.5}
              value={speedSec}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  speed_poll_interval_sec: typeof v === "number" ? v : 1.5,
                })
              }
              addonAfter="秒"
              style={{ width: 140 }}
            />
          </Space>
          <Space align="center">
            <span>早盘竞价刷新</span>
            <InputNumber
              min={1}
              max={5}
              step={0.5}
              value={auctionSec}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  auction_poll_interval_sec: typeof v === "number" ? v : 1,
                })
              }
              addonAfter="秒"
              style={{ width: 140 }}
            />
          </Space>
        </Space>
        <div style={{ marginTop: 8, color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
          盘中轮询建议 2～5 秒；涨速榜默认 1.5 秒（过短收益有限，服务端约 0.5 秒缓存）；早盘竞价观察池约 350 只、默认 1 秒刷新（9:10 清空昨数据，9:15–9:25 定时拉，三时点快照冻结后停轮询，不再刷实时涨幅）。保存后下一轮生效。
        </div>
      </div>

      <div className="settings-block">
        <h4>连板天梯</h4>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space>
            <span>展示封板/炸板时间</span>
            <Switch
              checked={draft.ladder_show_times !== false}
              onChange={(v) => setDraft({ ...draft, ladder_show_times: v })}
            />
          </Space>
          <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
            开启后在晋级成功标的下方显示首封/回封时间，炸板标的显示炸板时间。
          </div>
        </Space>
      </div>

      <div className="settings-block">
        <h4>ST 股票</h4>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space>
            <span>显示 ST / *ST / 退市股</span>
            <Switch
              checked={draft.show_st_stocks !== false}
              onChange={(v) => setDraft({ ...draft, show_st_stocks: v })}
            />
          </Space>
          <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
            关闭后，实时监控、连板天梯、涨速榜、竞价、历史回溯、重点观察与异动播报均不再展示或拉取
            ST/*ST/退市股。避雷啦面板不受影响。
          </div>
        </Space>
      </div>

      <div className="settings-block">
        <h4>语音播报</h4>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space>
            <span>启用实时播报</span>
            <Switch
              checked={!!draft.speech_enabled}
              onChange={(v) =>
                setDraft({ ...draft, speech_enabled: v, speech_mode: "realtime" })
              }
            />
          </Space>
          <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
            默认关闭。开启后仅在新涨停、连板晋级、炸板时播报一次。
          </div>

          <div>
            <div style={{ marginBottom: 8, color: "var(--muted)", fontSize: 13 }}>事件类型</div>
            <Checkbox.Group
              options={[
                { label: "新涨停", value: "zt" },
                { label: "连板晋级", value: "lb" },
                { label: "炸板", value: "zb" },
              ]}
              value={draft.speech_types}
              onChange={(v) => setDraft({ ...draft, speech_types: v as string[] })}
            />
          </div>
        </Space>
      </div>

      <div className="settings-block">
        <h4>异动播报</h4>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space>
            <span>启用异动语音</span>
            <Switch
              checked={alertEnabled}
              onChange={(v) => setDraft({ ...draft, alert_speech_enabled: v })}
            />
          </Space>
          <Space align="center">
            <span>轮询间隔</span>
            <InputNumber
              min={0.5}
              max={5}
              step={0.5}
              value={alertSec}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  alert_speech_interval_sec: typeof v === "number" ? v : 1,
                })
              }
              addonAfter="秒"
              style={{ width: 140 }}
            />
          </Space>
          <Space align="center" wrap>
            <span>急涨急跌窗口</span>
            <InputNumber
              min={15}
              max={600}
              step={15}
              value={rangeWindowSec}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  alert_range_window_sec: typeof v === "number" ? v : 60,
                })
              }
              addonAfter="秒"
              style={{ width: 140 }}
            />
            <span>阈值</span>
            <InputNumber
              min={0.5}
              max={20}
              step={0.5}
              value={rangePct}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  alert_range_pct: typeof v === "number" ? v : 3,
                })
              }
              addonAfter="%"
              style={{ width: 120 }}
            />
          </Space>
          <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
            仅监控「异动播报」栏中的股票。封涨大减/大增：相对基线每变动≥10%播报一次。冲击涨停：距涨停≤1个点且上冲时提醒。急涨急跌默认
            60 秒内涨跌幅≥3%。
          </div>
          <div>
            <div style={{ marginBottom: 8, color: "var(--muted)", fontSize: 13 }}>异动类型</div>
            <Checkbox.Group
              options={[
                { label: "冲击涨停", value: "impact_zt" },
                { label: "封死涨停", value: "seal_firm" },
                { label: "封涨大减", value: "seal_drop" },
                { label: "封涨大增", value: "seal_rise" },
                { label: "急涨急跌", value: "range_move" },
                { label: "涨停打开", value: "zt_open" },
                { label: "涨停被砸", value: "zt_smash" },
              ]}
              value={alertTypes}
              onChange={(v) => setDraft({ ...draft, alert_speech_types: v as string[] })}
            />
          </div>
        </Space>
      </div>

      <OrderedFieldManager
        title="表格列管理"
        description="按列表顺序展示监控表格列。使用箭头调整顺序，移除后可随时添加，名称列保留。"
        columns={draft.table_columns}
        choices={Object.keys(available)} labels={available} keepName
        onChange={(columns) => setDraft({ ...draft, table_columns: columns })}
      />
      <OrderedFieldManager
        title="涨速榜列管理"
        description="调整涨速榜展示列与顺序，名称列保留。此配置与监控表格独立。"
        columns={speedCols}
        choices={DEFAULT_SPEED_TABLE_COLUMNS} labels={available} keepName
        onChange={(columns) => setDraft({ ...draft, speed_table_columns: columns })}
      />
      <OrderedFieldManager
        title="个股抽屉详情管理"
        description="按列表顺序展示个股详情中的基本字段，使用箭头排序，移除后可在下方补回。"
        columns={draft.detail_fields}
        choices={Object.keys(available)} labels={available}
        onChange={(columns) => setDraft({ ...draft, detail_fields: columns })}
      />
    </Drawer>
  );
}
