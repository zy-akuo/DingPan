import type { HistoryGroup, StockItem } from "../types";

// 复盘按当日主涨停题材归类，不扩展到个股的全部概念。
export function historyTheme(stock: StockItem): string {
  return stock.reason?.trim() || stock.industry?.trim() || "其他";
}

export function summarizeHistoryGroup(group: HistoryGroup, stocks: StockItem[]): HistoryGroup {
  return {
    ...group,
    stocks,
    count: stocks.length,
    amount: stocks.reduce((sum, stock) => sum + (stock.amount || 0), 0),
    avg_change_pct: stocks.length
      ? stocks.reduce((sum, stock) => sum + (stock.change_pct || 0), 0) / stocks.length
      : 0,
  };
}

export function historyThemeGroups(stocks: StockItem[]): HistoryGroup[] {
  const groups = new Map<string, StockItem[]>();
  const seen = new Set<string>();
  for (const stock of stocks) {
    if (seen.has(stock.code)) continue;
    seen.add(stock.code);
    const theme = historyTheme(stock);
    const members = groups.get(theme) || [];
    members.push(stock);
    groups.set(theme, members);
  }
  return [...groups].map(([label, members]) => summarizeHistoryGroup({
    key: `concept-${label}`, label, stocks: [], count: 0, avg_change_pct: 0,
  }, members)).sort((a, b) => b.count - a.count || (b.amount || 0) - (a.amount || 0) || a.label.localeCompare(b.label));
}

const THEME_COLORS = ["#f06b73", "#f5a34b", "#66c7e8", "#bc96ef", "#eac76a", "#71c6ac", "#e78fc1", "#91aafa"];

export function historyThemeColors(groups: HistoryGroup[]): Map<string, string> {
  // 按完整当日排名分配，筛选时不变色；单只题材保持参考图的灰色。
  return new Map(groups.map((group, index) => [
    group.label,
    group.count > 1 ? THEME_COLORS[index % THEME_COLORS.length] : "var(--muted)",
  ]));
}
