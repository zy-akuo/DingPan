import type { StockItem } from "../types";

export function displayedLadderTheme(stock: StockItem): string {
  return stock.reason?.trim() || stock.concepts?.[0]?.trim() || stock.industry?.trim() || "暂无题材信息";
}

export function ladderThemeOptions(stocks: StockItem[]) {
  const members = new Map<string, Set<string>>();
  for (const stock of stocks) {
    const theme = displayedLadderTheme(stock);
    if (theme === "暂无题材信息") continue;
    if (!members.has(theme)) members.set(theme, new Set());
    members.get(theme)!.add(stock.code);
  }
  return [...members].map(([value, codes]) => ({ value, count: codes.size, label: `${value}（${codes.size}）` }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh-CN"));
}
