import { Drawer, Spin, Tag } from "antd";
import * as echarts from "echarts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cacheGet, cacheSet } from "../lib/localCache";
import type { StockItem, TopHolder } from "../types";
import { formatMoney, formatPct } from "../types";

const LABELS: Record<string, string> = {
  price: "股价",
  change_pct: "涨跌幅",
  total_mv: "总市值",
  float_mv: "流通市值",
  free_float_mv: "自由流通市值",
  top10_holder_pct: "十大股东持股占比",
  year_seal_rate: "近一年封板率",
  year_board_rate: "近一年连板率",
  concepts: "概念",
  region: "地域",
  industry: "行业",
  turnover: "换手率",
  zt_stats: "涨停统计",
  seal_amount: "封单",
  amount: "成交额",
  volume: "成交量",
  first_seal_time: "首封时间",
  last_seal_time: "末封时间",
  board_tag: "板型",
  reason: "异动原因",
};

function formatVolume(v?: number | null): string {
  if (v == null || Number.isNaN(v) || v <= 0) return "—";
  // 展示为手（1手=100股）更符合盯盘习惯
  const hands = v >= 100 ? v / 100 : v;
  if (hands >= 1e8) return `${(hands / 1e8).toFixed(2)}亿手`;
  if (hands >= 1e4) return `${(hands / 1e4).toFixed(2)}万手`;
  return `${hands.toFixed(0)}手`;
}

function formatShares(v?: number | null): string {
  if (v == null || Number.isNaN(v) || v <= 0) return "—";
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿股`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万股`;
  return `${v.toFixed(0)}股`;
}

function renderValue(key: string, stock: StockItem): ReactNode {
  switch (key) {
    case "price":
      return stock.price ? stock.price.toFixed(2) : "—";
    case "change_pct":
      return (
        <span className={stock.change_pct >= 0 ? "up" : "down"}>
          {formatPct(stock.change_pct)}
        </span>
      );
    case "volume":
      return formatVolume(stock.volume);
    case "total_mv":
    case "float_mv":
    case "free_float_mv":
    case "seal_amount":
    case "amount":
      return formatMoney(stock[key as keyof StockItem] as number | null);
    case "top10_holder_pct":
    case "year_seal_rate":
    case "year_board_rate":
    case "turnover":
      return formatPct(stock[key as keyof StockItem] as number | null);
    case "concepts":
      return stock.concepts?.length
        ? stock.concepts.map((c) => (
            <Tag key={c} color="orange">
              {c}
            </Tag>
          ))
        : "—";
    default:
      return (stock[key as keyof StockItem] as string) || "—";
  }
}

interface RadarData {
  code: string;
  name: string;
  as_of?: string;
  gene: {
    zt_days?: number;
    dt_days?: number;
    premium5_days?: number;
    zt_success_rate?: number | null;
    first_seal_rate?: number | null;
    next_red_rate?: number | null;
    board_rate?: number | null;
  };
  prices: { date: string; close: number }[];
  marks: { date: string; close: number; kind: string }[];
  details: {
    date: string;
    kind: string;
    tag: string;
    close: number;
    change_pct: number;
    seal_amount: number | null;
    seal_ratio: number | null;
    reason: string | null;
  }[];
}

function GeneGrid({ gene, asOf }: { gene: RadarData["gene"]; asOf?: string }) {
  const cells = [
    {
      label: "涨/跌停天数",
      node: (
        <>
          <span className="up">{gene.zt_days ?? 0}</span>
          <span className="muted"> / </span>
          <span className="down">{gene.dt_days ?? 0}</span>
        </>
      ),
    },
    { label: "溢价5%天数", node: <>{gene.premium5_days ?? 0}</> },
    {
      label: "涨停成功率",
      node: <>{gene.zt_success_rate != null ? formatPct(gene.zt_success_rate) : "—"}</>,
    },
    {
      label: "首板封板率",
      node: <>{gene.first_seal_rate != null ? formatPct(gene.first_seal_rate) : "—"}</>,
    },
    {
      label: "次日红盘率",
      node: <>{gene.next_red_rate != null ? formatPct(gene.next_red_rate) : "—"}</>,
    },
    {
      label: "连板率",
      node: <>{gene.board_rate != null ? formatPct(gene.board_rate) : "—"}</>,
    },
  ];
  return (
    <div className="radar-block">
      <div className="radar-block-title">
        涨停基因
        {asOf && <span className="radar-asof">近一年（截至 {asOf}）</span>}
      </div>
      <div className="gene-grid">
        {cells.map((c) => (
          <div key={c.label} className="gene-cell">
            <div className="gene-label">{c.label}</div>
            <div className="gene-value">{c.node}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RadarChart({
  prices,
  marks,
}: {
  prices: RadarData["prices"];
  marks: RadarData["marks"];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !prices.length) return;
    const chart = echarts.init(ref.current);
    const zt = marks.filter((m) => m.kind === "zt");
    const dt = marks.filter((m) => m.kind === "dt");
    chart.setOption({
      animation: false,
      grid: { left: 40, right: 12, top: 28, bottom: 28 },
      legend: {
        top: 0,
        textStyle: { fontSize: 11, color: "#6b7280" },
        data: ["股价(元)", "涨停", "跌停"],
      },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        data: prices.map((p) => p.date),
        axisLabel: {
          fontSize: 10,
          color: "#9ca3af",
          interval: Math.max(0, Math.floor(prices.length / 4) - 1),
        },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { type: "dashed", color: "#eef2f7" } },
        axisLabel: { fontSize: 10, color: "#9ca3af" },
      },
      series: [
        {
          name: "股价(元)",
          type: "line",
          data: prices.map((p) => p.close),
          showSymbol: false,
          lineStyle: { width: 1.5, color: "#3b82f6" },
        },
        {
          name: "涨停",
          type: "scatter",
          data: zt.map((m) => [m.date, m.close]),
          symbolSize: 8,
          itemStyle: { color: "#e11d2e" },
        },
        {
          name: "跌停",
          type: "scatter",
          data: dt.map((m) => [m.date, m.close]),
          symbolSize: 8,
          itemStyle: { color: "#0a8f3d" },
        },
      ],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [prices, marks]);
  return <div ref={ref} className="radar-chart" />;
}

function DetailsList({ details }: { details: RadarData["details"] }) {
  if (!details.length) {
    return <div className="muted">暂无涨跌停明细</div>;
  }
  // group by year
  const years = new Map<string, RadarData["details"]>();
  for (const d of details) {
    const y = d.date.slice(0, 4) || "未知";
    if (!years.has(y)) years.set(y, []);
    years.get(y)!.push(d);
  }
  return (
    <div className="radar-details">
      {[...years.entries()].map(([year, rows]) => (
        <div key={year} className="radar-year">
          <div className="radar-year-title">{year}年</div>
          {rows.map((d) => (
            <div key={`${d.date}-${d.kind}`} className="radar-detail-card">
              <div className="radar-detail-head">
                <span className="radar-date">{d.date.slice(5)}</span>
                <span className={`radar-tag ${d.kind === "zt" ? "zt" : "dt"}`}>
                  {d.tag}
                </span>
              </div>
              <div className="radar-detail-grid">
                <div>
                  <span className="muted">收盘价</span>
                  <strong>{d.close ? d.close.toFixed(2) : "—"}</strong>
                </div>
                <div>
                  <span className="muted">涨幅</span>
                  <strong className={d.change_pct >= 0 ? "up" : "down"}>
                    {formatPct(d.change_pct)}
                  </strong>
                </div>
                <div>
                  <span className="muted">封单额</span>
                  <strong>{formatMoney(d.seal_amount)}</strong>
                </div>
                <div>
                  <span className="muted">封成比</span>
                  <strong>
                    {d.seal_ratio != null ? formatPct(d.seal_ratio) : "—"}
                  </strong>
                </div>
              </div>
              {d.reason && (
                <div className="radar-reason">
                  <span className="muted">异动原因</span>
                  <div>{d.reason}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function FormerNamesBlock({
  names,
  loading,
}: {
  names?: string[] | null;
  loading?: boolean;
}) {
  return (
    <div className="radar-block">
      <div className="radar-block-title">历史曾用名</div>
      {names == null && loading ? (
        <div className="muted">
          <Spin size="small" /> 加载中…
        </div>
      ) : names?.length ? (
        <div className="former-names">
          {names.map((n) => (
            <Tag key={n}>{n}</Tag>
          ))}
        </div>
      ) : (
        <div className="muted">暂无曾用名</div>
      )}
    </div>
  );
}

function sumMajorHolderPct(holders?: TopHolder[] | null): number | null {
  if (!holders?.length) return null;
  let sum = 0;
  let hit = false;
  for (const h of holders) {
    if (h.ratio != null && !Number.isNaN(h.ratio) && h.ratio >= 5) {
      sum += h.ratio;
      hit = true;
    }
  }
  return hit ? Math.round(sum * 100) / 100 : 0;
}

function HoldersBlock({
  holders,
  endDate,
  totalPct,
  loading,
}: {
  holders?: TopHolder[] | null;
  endDate?: string;
  totalPct?: number | null;
  loading?: boolean;
}) {
  const majorPct = sumMajorHolderPct(holders);
  return (
    <div className="radar-block">
      <div className="radar-block-title">
        十大股东
        {endDate && <span className="radar-asof">截至 {endDate}</span>}
        {totalPct != null && (
          <span className="radar-asof">合计 {formatPct(totalPct)}</span>
        )}
        {majorPct != null && (
          <span className="radar-asof">持股≥5% {formatPct(majorPct)}</span>
        )}
      </div>
      {holders == null && loading ? (
        <div className="muted">
          <Spin size="small" /> 加载股东明细…
        </div>
      ) : !holders?.length ? (
        <div className="muted">暂无股东明细</div>
      ) : (
        <div className="holders-list">
          {holders.map((h) => (
            <div
              key={`${h.rank}-${h.name}`}
              className={`holder-row${h.ratio != null && h.ratio >= 5 ? " holder-major" : ""}`}
            >
              <div className="holder-rank">{h.rank}</div>
              <div className="holder-main">
                <div className="holder-name" title={h.name}>
                  {h.name || "—"}
                </div>
                <div className="holder-meta">
                  <span>{formatShares(h.shares)}</span>
                  {h.change ? <span>变动 {h.change}</span> : null}
                  {h.shares_type ? <span>{h.shares_type}</span> : null}
                </div>
              </div>
              <div className="holder-ratio">{formatPct(h.ratio)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function StockDetailDrawer({
  stock,
  fields,
  open,
  loading,
  onClose,
}: {
  stock: StockItem | null;
  fields: string[];
  open: boolean;
  loading?: boolean;
  onClose: () => void;
}) {
  const [radar, setRadar] = useState<RadarData | null>(null);
  const [radarLoading, setRadarLoading] = useState(false);

  useEffect(() => {
    if (!open || !stock?.code) {
      setRadar(null);
      return;
    }
    let cancelled = false;
    const key = `radar:${stock.code}`;
    const cached = cacheGet<RadarData>(key);
    if (cached?.prices) {
      setRadar(cached);
      setRadarLoading(false);
    } else {
      setRadarLoading(true);
    }
    fetch(`/api/stock/${stock.code}/radar`)
      .then((r) => r.json())
      .then((data: RadarData) => {
        if (cancelled) return;
        setRadar(data);
        if (data?.prices?.length) {
          cacheSet(key, data, 30 * 60);
        }
      })
      .catch(() => {
        if (!cancelled && !cached) setRadar(null);
      })
      .finally(() => {
        if (!cancelled) setRadarLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, stock?.code]);

  // hide legacy rate fields when radar gene is shown
  const basicFields = fields.filter(
    (k) => k !== "year_seal_rate" && k !== "year_board_rate" && k !== "zt_stats",
  );

  return (
    <Drawer
      title={
        stock ? (
          <div className="drawer-title">
            <span>{stock.name}</span>
            <span className="code">{stock.code}</span>
            {stock.price > 0 && (
              <span className="up drawer-price">
                {stock.price.toFixed(2)}{" "}
                <small>{formatPct(stock.change_pct)}</small>
              </span>
            )}
          </div>
        ) : (
          "详情"
        )
      }
      open={open}
      onClose={onClose}
      width={460}
    >
      {(loading || radarLoading) && (
        <div className="muted" style={{ marginBottom: 12 }}>
          <Spin size="small" /> 正在拉取涨停雷达…
        </div>
      )}

      {radar && (
        <>
          <GeneGrid gene={radar.gene || {}} asOf={radar.as_of} />
          <div className="radar-block">
            <RadarChart prices={radar.prices || []} marks={radar.marks || []} />
          </div>
          <div className="radar-block">
            <div className="radar-block-title">涨跌停明细</div>
            <DetailsList details={radar.details || []} />
          </div>
        </>
      )}

      {stock && (
        <>
          <div className="radar-block">
            <div className="radar-block-title">基本面</div>
            <div className="detail-grid">
              {basicFields.map((key) => (
                <div key={key} className="detail-row">
                  <div className="detail-label">{LABELS[key] || key}</div>
                  <div className="detail-value">{renderValue(key, stock)}</div>
                </div>
              ))}
            </div>
          </div>
          <FormerNamesBlock names={stock.former_names} loading={loading} />
          <HoldersBlock
            holders={stock.top10_holders}
            endDate={stock.top10_holders_date}
            totalPct={stock.top10_holder_pct}
            loading={loading}
          />
        </>
      )}
    </Drawer>
  );
}
