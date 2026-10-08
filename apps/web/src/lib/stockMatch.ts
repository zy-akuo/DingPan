import { match } from "pinyin-pro";

/** 股票名称 / 名称首字母模糊匹配（不改动数据，仅用于高亮判断） */
export function matchNameOrInitials(name: string, keyword: string): boolean {
  const q = keyword.trim();
  if (!q || !name) return false;

  if (name.includes(q)) return true;

  // 纯字母/数字：按字做首字母或全拼匹配，避免单字母命中音节中间（如 shen/chuan 中的 h）
  if (/^[a-z0-9]+$/i.test(q)) {
    const hit = match(name, q.toLowerCase(), { continuous: true });
    return Array.isArray(hit) && hit.length > 0;
  }

  return false;
}
