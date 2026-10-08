import { LineChartOutlined } from "@ant-design/icons";
import { Button, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { StockItem } from "../types";
import { formatMoney, formatPct, formatVolume } from "../types";
import { RiskBadge } from "./RiskPanel";

function buildColumns(
  keys: string[],
  onOpenChart?: (s: StockItem) => void,
  extraActions?: (s: StockItem) => ReactNode,
): ColumnsType<StockItem> {
  const ALL: Record<string, ColumnsType<StockItem>[number]> = {
    name: {
      title: "名称",
      dataIndex: "name",
      width: 168,
      fixed: "left",
      render: (_, r) => (
        <div className="name-cell">
          <div className="name-row">
            <span className="mkt">{r.market}</span>
            <span className="nm">{r.name}</span>
            <RiskBadge tags={r.risk_tags} hint={r.risk_hint} />
            {onOpenChart ? (
              <Button
                type="text"
                size="small"
                className="name-chart-btn"
                icon={<LineChartOutlined />}
                title="查看分时/日线"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenChart(r);
                }}
              />
            ) : null}
            {extraActions ? (
              <span
                className="name-extra"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {extraActions(r)}
              </span>
            ) : null}
          </div>
          <div className="code">{r.code}</div>
        </div>
      ),
    },
    board: {
      title: "板数",
      dataIndex: "board_tag",
      width: 110,
      render: (_: string, r) => {
        if (!r.board_tag && !r.first_seal_time) return "—";
        return (
          <div>
            <div>{r.board_count <= 1 ? "首板" : `${r.board_count}连板`}</div>
            {r.board_tag ? (
              <Tag color={r.open_times > 0 ? "orange" : "red"} style={{ marginTop: 2 }}>
                {r.open_times > 0 ? "回封" : "硬板"}
              </Tag>
            ) : null}
          </div>
        );
      },
    },
    first_seal_time: {
      title: "首封",
      dataIndex: "first_seal_time",
      width: 96,
      render: (v: string) => v || "—",
    },
    seal_amount: {
      title: "封单",
      dataIndex: "seal_amount",
      width: 90,
      render: (v: number) => (v ? <span className="up">{formatMoney(v)}</span> : "—"),
    },
    amount: {
      title: "成交额",
      dataIndex: "amount",
      width: 90,
      render: (v: number) => formatMoney(v),
    },
    volume: {
      title: "成交量",
      dataIndex: "volume",
      width: 96,
      render: (v: number) => formatVolume(v),
    },
    float_mv: {
      title: "实际流通",
      dataIndex: "float_mv",
      width: 100,
      render: (v: number) => formatMoney(v),
    },
    total_mv: {
      title: "总市值",
      dataIndex: "total_mv",
      width: 100,
      render: (v: number) => formatMoney(v),
    },
    free_float_mv: {
      title: "自由流通",
      dataIndex: "free_float_mv",
      width: 100,
      render: (v: number | null) => formatMoney(v),
    },
    price: {
      title: "股价",
      dataIndex: "price",
      width: 80,
      render: (v: number) => (v ? v.toFixed(2) : "—"),
    },
    change_pct: {
      title: "涨跌幅",
      dataIndex: "change_pct",
      width: 80,
      render: (v: number) => (
        <span className={v >= 0 ? "up" : "down"}>{formatPct(v)}</span>
      ),
    },
    speed: {
      title: "涨速",
      dataIndex: "speed",
      width: 72,
      render: (v: number | null | undefined) => {
        if (v == null || Number.isNaN(v)) return "—";
        return <span className={v >= 0 ? "up" : "down"}>{formatPct(v)}</span>;
      },
    },
    concepts: {
      title: "概念",
      dataIndex: "concepts",
      ellipsis: true,
      render: (v: string[]) => v?.slice(0, 3).join(" / ") || "—",
    },
    industry: {
      title: "行业",
      dataIndex: "industry",
      width: 100,
      render: (v: string) => v || "—",
    },
    region: {
      title: "地域",
      dataIndex: "region",
      width: 90,
      render: (v: string) => v || "—",
    },
    top10_holder_pct: {
      title: "十大股东占比",
      dataIndex: "top10_holder_pct",
      width: 110,
      render: (v: number | null) => formatPct(v),
    },
    year_seal_rate: {
      title: "近一年封板率",
      dataIndex: "year_seal_rate",
      width: 110,
      render: (v: number | null) => formatPct(v),
    },
    year_board_rate: {
      title: "近一年连板率",
      dataIndex: "year_board_rate",
      width: 110,
      render: (v: number | null) => formatPct(v),
    },
    turnover: {
      title: "换手率",
      dataIndex: "turnover",
      width: 80,
      render: (v: number) => formatPct(v),
    },
    zt_stats: {
      title: "涨停统计",
      dataIndex: "zt_stats",
      width: 90,
      render: (v: string) => v || "—",
    },
    last_seal_time: {
      title: "末封",
      dataIndex: "last_seal_time",
      width: 96,
      render: (v: string) => v || "—",
    },
    reason: {
      title: "异动原因",
      dataIndex: "reason",
      ellipsis: true,
      width: 220,
      render: (v: string | undefined) => v || "—",
    },
  };

  return keys.map((k) => ALL[k]).filter(Boolean) as ColumnsType<StockItem>;
}

export function MonitorTable({
  data,
  columns,
  onRowClick,
  selectedCode,
  onOpenChart,
  extraActions,
  scrollY = "calc(100vh - 340px)",
}: {
  data: StockItem[];
  columns: string[];
  onRowClick: (s: StockItem) => void;
  selectedCode?: string | null;
  onOpenChart?: (s: StockItem) => void;
  extraActions?: (s: StockItem) => ReactNode;
  scrollY?: number | string;
}) {
  const cols = useMemo(
    () => buildColumns(columns, onOpenChart, extraActions),
    [columns, onOpenChart, extraActions],
  );
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedCode || !wrapRef.current) return;
    const timer = window.setTimeout(() => {
      const root = wrapRef.current;
      if (!root) return;
      const row = root.querySelector(
        `tr[data-row-key="${selectedCode}"]`,
      ) as HTMLElement | null;
      const body = root.querySelector(".ant-table-body") as HTMLElement | null;
      if (!row || !body) return;
      const rowRect = row.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      if (rowRect.top >= bodyRect.top && rowRect.bottom <= bodyRect.bottom) return;
      const delta =
        rowRect.top - bodyRect.top - body.clientHeight / 2 + rowRect.height / 2;
      body.scrollTo({ top: Math.max(0, body.scrollTop + delta), behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [selectedCode]);

  return (
    <div ref={wrapRef} className="monitor-table-wrap">
      <Table
        size="small"
        rowKey="code"
        pagination={false}
        scroll={{ y: scrollY, x: 1000 }}
        dataSource={data}
        columns={cols}
        rowClassName={(r) => (r.code === selectedCode ? "monitor-row-selected" : "")}
        onRow={(record) => ({
          onClick: () => onRowClick(record),
        })}
      />
    </div>
  );
}
