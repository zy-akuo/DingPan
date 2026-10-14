import type { StockItem } from "../types";

/** 行情字段相等则复用旧对象，减少 Table 无意义重绘。 */
export function rowEqual(a: StockItem, b: StockItem): boolean {
  return (
    a.code === b.code &&
    a.name === b.name &&
    a.price === b.price &&
    a.change_pct === b.change_pct &&
    a.amount === b.amount &&
    a.volume === b.volume &&
    a.seal_amount === b.seal_amount &&
    a.float_mv === b.float_mv &&
    a.total_mv === b.total_mv &&
    a.turnover === b.turnover &&
    a.first_seal_time === b.first_seal_time &&
    a.last_seal_time === b.last_seal_time &&
    a.break_time === b.break_time &&
    a.board_count === b.board_count &&
    a.open_times === b.open_times &&
    a.board_tag === b.board_tag &&
    a.status === b.status &&
    a.industry === b.industry &&
    a.region === b.region &&
    a.speed === b.speed &&
    a.reason === b.reason &&
    a.risk_hint === b.risk_hint &&
    (a.concepts || []).join("|") === (b.concepts || []).join("|") &&
    (a.risk_tags || []).join("|") === (b.risk_tags || []).join("|")
  );
}

/** 按新列表顺序合并；未变化的行保留旧引用。 */
export function mergeRows(
  prev: StockItem[],
  next: StockItem[],
  opts?: { keepOnEmpty?: boolean },
): StockItem[] {
  const keepOnEmpty = !!opts?.keepOnEmpty;
  // 轮询偶发空包时保留旧列表，避免闪成「暂无数据」
  if (!next.length) return keepOnEmpty && prev.length ? prev : next;
  if (!prev.length) return next;
  const prevMap = new Map(prev.map((r) => [r.code, r]));
  let sameOrder = prev.length === next.length;
  const out = next.map((row, i) => {
    if (sameOrder && prev[i]?.code !== row.code) sameOrder = false;
    const old = prevMap.get(row.code);
    if (old && rowEqual(old, row)) return old;
    return row;
  });
  if (sameOrder && out.every((r, i) => r === prev[i])) return prev;
  return out;
}

/** 榜单/观察列表内容签名，用于跳过无变化刷新。 */
export function quoteListSignature(rows: StockItem[]): string {
  return rows
    .map(
      (r) =>
        `${r.code}:${r.speed ?? ""}:${r.change_pct}:${r.price}:${r.amount}:${r.volume}:${r.seal_amount ?? ""}:${r.turnover ?? ""}`,
    )
    .join("|");
}

/** @deprecated 使用 quoteListSignature */
export const speedListSignature = quoteListSignature;

/** 若顺序与引用均未变则返回旧数组，避免 Table 无意义刷新。 */
export function stabilizeList(
  prev: StockItem[] | undefined,
  next: StockItem[],
): StockItem[] {
  if (
    prev &&
    prev.length === next.length &&
    next.every((r, i) => r === prev[i])
  ) {
    return prev;
  }
  return next;
}
