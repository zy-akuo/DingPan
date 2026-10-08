import { pinyin } from "pinyin-pro";

/** 股票名称 / 名称首字母模糊匹配（不改动数据，仅用于高亮判断） */
export function matchNameOrInitials(name: string, keyword: string): boolean {
  const q = keyword.trim();
  if (!q || !name) return false;

  if (name.includes(q)) return true;

  const ql = q.toLowerCase();
  // 纯字母/数字：按首字母或全拼模糊
  if (/^[a-z0-9]+$/i.test(q)) {
    const chars = [...name].filter((ch) => /[\u4e00-\u9fffA-Za-z0-9]/.test(ch));
    if (!chars.length) return false;

    const initials = pinyin(chars.join(""), {
      pattern: "first",
      toneType: "none",
      type: "array",
      nonZh: "consecutive",
    })
      .join("")
      .toLowerCase();
    if (initials.includes(ql)) return true;

    const full = pinyin(chars.join(""), {
      toneType: "none",
      type: "array",
      nonZh: "consecutive",
    })
      .join("")
      .toLowerCase()
      .replace(/\s+/g, "");
    if (full.includes(ql)) return true;
  }

  return false;
}
