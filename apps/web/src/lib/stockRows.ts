import type { StockItem } from "../types";

/** 行情快字段是否相等。 */
function quoteEqual(a: StockItem, b: StockItem): boolean {
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
    a.speed === b.speed &&
    a.reason === b.reason &&
    a.risk_hint === b.risk_hint &&
    (a.risk_tags || []).join("|") === (b.risk_tags || []).join("|")
  );
}

function conceptsKey(v: string[] | undefined | null): string {
  return (v || []).join("|");
}

/** 慢字段（基本面 / 基因）是否相等。 */
function slowEqual(a: StockItem, b: StockItem): boolean {
  return (
    a.industry === b.industry &&
    a.region === b.region &&
    conceptsKey(a.concepts) === conceptsKey(b.concepts) &&
    a.free_float_mv === b.free_float_mv &&
    a.top10_holder_pct === b.top10_holder_pct &&
    a.top10_major_holder_pct === b.top10_major_holder_pct &&
    a.zt_success_rate === b.zt_success_rate &&
    a.first_seal_rate === b.first_seal_rate &&
    a.next_red_rate === b.next_red_rate &&
    a.year_seal_rate === b.year_seal_rate &&
    a.year_board_rate === b.year_board_rate
  );
}

/** 行情字段相等则复用旧对象，减少 Table 无意义重绘。 */
export function rowEqual(a: StockItem, b: StockItem): boolean {
  return quoteEqual(a, b) && slowEqual(a, b);
}

function pickSlow<T>(next: T | null | undefined, prev: T | null | undefined): T | null | undefined {
  if (next !== null && next !== undefined && next !== "") return next;
  return prev;
}

/** 合并慢字段：新有则用新；新缺则保留旧（避免轮询偶发空值清空）。 */
function mergeSlowFields(prev: StockItem, next: StockItem): StockItem {
  const concepts =
    next.concepts && next.concepts.length ? next.concepts : prev.concepts;
  return {
    ...next,
    industry: (next.industry || prev.industry) ?? "",
    region: (next.region || prev.region) ?? "",
    concepts: concepts || [],
    free_float_mv: pickSlow(next.free_float_mv, prev.free_float_mv) ?? null,
    top10_holder_pct: pickSlow(next.top10_holder_pct, prev.top10_holder_pct) ?? null,
    top10_major_holder_pct:
      pickSlow(next.top10_major_holder_pct, prev.top10_major_holder_pct) ?? null,
    zt_success_rate: pickSlow(next.zt_success_rate, prev.zt_success_rate) ?? null,
    first_seal_rate: pickSlow(next.first_seal_rate, prev.first_seal_rate) ?? null,
    next_red_rate: pickSlow(next.next_red_rate, prev.next_red_rate) ?? null,
    year_seal_rate: pickSlow(next.year_seal_rate, prev.year_seal_rate) ?? null,
    year_board_rate: pickSlow(next.year_board_rate, prev.year_board_rate) ?? null,
    top10_holders: next.top10_holders ?? prev.top10_holders,
    top10_holders_date: next.top10_holders_date ?? prev.top10_holders_date,
    former_names: next.former_names ?? prev.former_names,
  };
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
    if (!old) return row;
    const merged = mergeSlowFields(old, row);
    if (rowEqual(old, merged)) return old;
    return merged;
  });
  if (sameOrder && out.every((r, i) => r === prev[i])) return prev;
  return out;
}

/** 榜单/观察列表内容签名，用于跳过无变化刷新。 */
export function quoteListSignature(rows: StockItem[]): string {
  return rows
    .map(
      (r) =>
        `${r.code}:${r.speed ?? ""}:${r.change_pct}:${r.price}:${r.amount}:${r.volume}:${r.seal_amount ?? ""}:${r.turnover ?? ""}:${r.free_float_mv ?? ""}:${r.region ?? ""}:${r.top10_holder_pct ?? ""}:${r.top10_major_holder_pct ?? ""}:${r.zt_success_rate ?? ""}:${r.first_seal_rate ?? ""}:${r.next_red_rate ?? ""}:${(r.concepts || []).join(",")}`,
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
