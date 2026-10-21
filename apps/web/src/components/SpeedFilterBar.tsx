import {
  Button,
  Dropdown,
  Input,
  InputNumber,
  Modal,
  Space,
  message,
} from "antd";
import type { MenuProps } from "antd";
import { useCallback, useMemo, useState, type MouseEvent } from "react";
import {
  EMPTY_SPEED_FILTER,
  isSpeedFilterActive,
  summarizeSpeedFilter,
  type SpeedFilter,
} from "../lib/speedFilter";
import {
  addSpeedFilterTemplate,
  loadSpeedFilterTemplates,
  removeSpeedFilterTemplate,
  type SpeedFilterTemplate,
} from "../lib/speedFilterTemplates";

export type { SpeedFilter };
export { EMPTY_SPEED_FILTER, applySpeedFilter } from "../lib/speedFilter";

function RangeField({
  label,
  min,
  max,
  onMin,
  onMax,
  unit,
  step = 0.5,
  width = 72,
}: {
  label: string;
  min: number | null;
  max: number | null;
  onMin: (v: number | null) => void;
  onMax: (v: number | null) => void;
  unit: string;
  step?: number;
  width?: number;
}) {
  return (
    <Space size={4} className="filter-item">
      <span className="filter-label">{label}</span>
      <InputNumber
        size="small"
        min={0}
        step={step}
        placeholder="最小"
        value={min}
        onChange={(v) => onMin(typeof v === "number" ? v : null)}
        style={{ width }}
      />
      <span className="filter-sep">~</span>
      <InputNumber
        size="small"
        min={0}
        step={step}
        placeholder="最大"
        value={max}
        onChange={(v) => onMax(typeof v === "number" ? v : null)}
        style={{ width }}
      />
      <span className="filter-unit">{unit}</span>
    </Space>
  );
}

export function SpeedFilterBar({
  value,
  onChange,
  resultCount,
  totalCount,
}: {
  value: SpeedFilter;
  onChange: (v: SpeedFilter) => void;
  resultCount: number;
  totalCount: number;
}) {
  const patch = (p: Partial<SpeedFilter>) => onChange({ ...value, ...p });
  const [templates, setTemplates] = useState<SpeedFilterTemplate[]>(() =>
    loadSpeedFilterTemplates(),
  );
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  const defaultName = useMemo(() => summarizeSpeedFilter(value), [value]);
  const active = isSpeedFilterActive(value);

  const openSave = useCallback(() => {
    if (!active) {
      message.info("请先设置筛选条件");
      return;
    }
    setSaveName(defaultName);
    setSaveOpen(true);
  }, [active, defaultName]);

  const confirmSave = useCallback(() => {
    const name = saveName.trim() || defaultName;
    const next = addSpeedFilterTemplate(name, value);
    setTemplates(next);
    setSaveOpen(false);
    message.success("已保存筛选模板");
  }, [saveName, defaultName, value]);

  const applyTemplate = useCallback(
    (t: SpeedFilterTemplate) => {
      onChange({ ...t.filter });
      message.success(`已应用模板：${t.name}`);
    },
    [onChange],
  );

  const deleteTemplate = useCallback((id: string, e: MouseEvent) => {
    e.stopPropagation();
    const next = removeSpeedFilterTemplate(id);
    setTemplates(next);
    message.success("已删除模板");
  }, []);

  const menuItems = useMemo<MenuProps["items"]>(() => {
    if (!templates.length) {
      return [
        {
          key: "empty",
          disabled: true,
          label: "暂无模板，先保存当前筛选",
        },
      ];
    }
    return templates.map((t) => ({
      key: t.id,
      label: (
        <div className="speed-tpl-item">
          <div className="speed-tpl-main">
            <div className="speed-tpl-name">{t.name}</div>
            <div className="speed-tpl-summary">{summarizeSpeedFilter(t.filter)}</div>
          </div>
          <Button
            type="link"
            size="small"
            danger
            className="speed-tpl-del"
            onClick={(e) => deleteTemplate(t.id, e)}
          >
            删除
          </Button>
        </div>
      ),
      onClick: ({ domEvent }) => {
        const el = domEvent.target as HTMLElement | null;
        if (el?.closest?.(".speed-tpl-del")) return;
        applyTemplate(t);
      },
    }));
  }, [templates, applyTemplate, deleteTemplate]);

  return (
    <div className="monitor-filter-bar speed-filter-bar">
      <RangeField
        label="成交额"
        min={value.amountMinYi}
        max={value.amountMaxYi}
        onMin={(v) => patch({ amountMinYi: v })}
        onMax={(v) => patch({ amountMaxYi: v })}
        unit="亿"
      />
      <RangeField
        label="自由流通"
        min={value.freeFloatMinYi}
        max={value.freeFloatMaxYi}
        onMin={(v) => patch({ freeFloatMinYi: v })}
        onMax={(v) => patch({ freeFloatMaxYi: v })}
        unit="亿"
      />
      <RangeField
        label="股价"
        min={value.priceMin}
        max={value.priceMax}
        onMin={(v) => patch({ priceMin: v })}
        onMax={(v) => patch({ priceMax: v })}
        unit="元"
        step={1}
      />
      <RangeField
        label="持股≥5%"
        min={value.majorHolderMin}
        max={value.majorHolderMax}
        onMin={(v) => patch({ majorHolderMin: v })}
        onMax={(v) => patch({ majorHolderMax: v })}
        unit="%"
        step={1}
      />
      <RangeField
        label="涨停成功率"
        min={value.ztSuccessMin}
        max={value.ztSuccessMax}
        onMin={(v) => patch({ ztSuccessMin: v })}
        onMax={(v) => patch({ ztSuccessMax: v })}
        unit="%"
        step={1}
      />

      <Space size={8} className="filter-actions">
        <span className="filter-count">
          {resultCount}/{totalCount}
        </span>
        <Button size="small" disabled={!active} onClick={openSave}>
          保存模板
        </Button>
        <Dropdown
          menu={{ items: menuItems }}
          trigger={["click"]}
          placement="bottomRight"
          overlayClassName="speed-tpl-dropdown"
        >
          <Button size="small">
            模板{templates.length ? ` (${templates.length})` : ""}
          </Button>
        </Dropdown>
        <Button
          size="small"
          disabled={!active}
          onClick={() => onChange({ ...EMPTY_SPEED_FILTER })}
        >
          重置
        </Button>
      </Space>

      <Modal
        title="保存筛选模板"
        open={saveOpen}
        onOk={confirmSave}
        onCancel={() => setSaveOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <div className="speed-tpl-save">
          <div className="speed-tpl-save-hint">将当前筛选条件保存为模板，便于下次一键回显。</div>
          <Input
            placeholder="模板名称"
            value={saveName}
            maxLength={60}
            allowClear
            onChange={(e) => setSaveName(e.target.value)}
            onPressEnter={confirmSave}
          />
          <div className="speed-tpl-summary muted">{defaultName}</div>
        </div>
      </Modal>
    </div>
  );
}
