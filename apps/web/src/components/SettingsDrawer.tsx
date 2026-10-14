import { Button, Checkbox, Drawer, InputNumber, Space, Switch } from "antd";
import { useEffect, useState } from "react";
import type { FieldConfig } from "../types";
import { DEFAULT_ALERT_SPEECH_TYPES } from "../types";

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
    if (open) setDraft(value);
  }, [open, value]);

  const pollSec = draft.poll_interval_sec ?? 2.5;
  const speedSec = draft.speed_poll_interval_sec ?? 1.5;
  const auctionSec = draft.auction_poll_interval_sec ?? 1;
  const alertSec = draft.alert_speech_interval_sec ?? 1;
  const alertTypes = draft.alert_speech_types ?? [...DEFAULT_ALERT_SPEECH_TYPES];
  const alertEnabled = draft.alert_speech_enabled !== false;

  return (
    <Drawer
      title="显示与播报设置"
      open={open}
      onClose={onClose}
      width={440}
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
                  alert_speech_types:
                    draft.alert_speech_types ?? [...DEFAULT_ALERT_SPEECH_TYPES],
                  alert_speech_enabled: draft.alert_speech_enabled !== false,
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
          盘中轮询建议 2～5 秒；涨速榜默认 1.5 秒；早盘竞价观察池约 350 只、默认 1 秒刷新（9:10 清空昨数据，9:15–9:30 定时拉，三时点快照首次有效后冻结）。保存后下一轮生效。
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
          <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
            仅监控「异动播报」栏中的股票。默认全部类型开启，间隔 1 秒。音色与普通播报区分。
          </div>
          <div>
            <div style={{ marginBottom: 8, color: "var(--muted)", fontSize: 13 }}>异动类型</div>
            <Checkbox.Group
              options={[
                { label: "冲击涨停", value: "impact_zt" },
                { label: "封死涨停", value: "seal_firm" },
                { label: "封涨大减", value: "seal_drop" },
                { label: "封涨大增", value: "seal_rise" },
                { label: "涨停打开", value: "zt_open" },
                { label: "涨停被砸", value: "zt_smash" },
              ]}
              value={alertTypes}
              onChange={(v) => setDraft({ ...draft, alert_speech_types: v as string[] })}
            />
          </div>
        </Space>
      </div>

      <div className="settings-block">
        <h4>表格列（可配置基本面）</h4>
        <Checkbox.Group
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
          options={Object.entries(available).map(([k, label]) => ({
            label,
            value: k,
          }))}
          value={draft.table_columns}
          onChange={(v) => setDraft({ ...draft, table_columns: v as string[] })}
        />
      </div>

      <div className="settings-block">
        <h4>详情抽屉字段</h4>
        <Checkbox.Group
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
          options={Object.entries(available).map(([k, label]) => ({
            label,
            value: k,
          }))}
          value={draft.detail_fields}
          onChange={(v) => setDraft({ ...draft, detail_fields: v as string[] })}
        />
      </div>
    </Drawer>
  );
}
