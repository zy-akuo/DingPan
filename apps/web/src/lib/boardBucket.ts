/** 板块分桶：与东财 fs / 代码规则对齐 */

export type BoardBucket = "all" | "main" | "cyb" | "kcb" | "bj";

export const BOARD_TAB_OPTIONS: { label: string; value: BoardBucket }[] = [
  { label: "全部", value: "all" },
  { label: "主板", value: "main" },
  { label: "创业板", value: "cyb" },
  { label: "科创板", value: "kcb" },
  { label: "北交所", value: "bj" },
];

export function boardBucketOf(code: string): Exclude<BoardBucket, "all"> {
  const c = (code || "").trim().padStart(6, "0");
  if (c.startsWith("688") || c.startsWith("689")) return "kcb";
  if (c.startsWith("300") || c.startsWith("301")) return "cyb";
  // 北交所：8xxxxx / 4xxxxx / 92xxxx
  if (c.startsWith("8") || c.startsWith("4") || c.startsWith("92")) return "bj";
  return "main";
}

export function matchBoardBucket(code: string, bucket: BoardBucket): boolean {
  if (bucket === "all") return true;
  return boardBucketOf(code) === bucket;
}
