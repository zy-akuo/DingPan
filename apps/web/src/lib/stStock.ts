/** ST / *ST / 退市 名称判定（与后端 _is_st_like_name 对齐） */
export function isStLikeName(name?: string | null): boolean {
  let n = (name || "").trim().replace(/ＳＴ/g, "ST").replace(/＊/g, "*");
  if (!n) return false;
  return (
    n.startsWith("*ST") ||
    n.startsWith("ST*") ||
    n.startsWith("ST") ||
    n.startsWith("退市")
  );
}

export function isStStock(item: {
  name?: string | null;
  risk_tags?: string[] | null;
}): boolean {
  if (isStLikeName(item.name)) return true;
  const tags = item.risk_tags || [];
  return tags.includes("st") || tags.includes("delist");
}

export function filterStItems<T extends { name?: string | null; risk_tags?: string[] | null }>(
  items: T[] | null | undefined,
  showSt: boolean,
): T[] {
  const list = items || [];
  if (showSt) return list;
  return list.filter((x) => !isStStock(x));
}
