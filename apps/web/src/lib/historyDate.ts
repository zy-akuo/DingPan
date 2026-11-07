import dayjs from "dayjs";

const HISTORY_DATE_KEY = "dingpan.historyDate";

export function normalizeYmd(s: string | undefined | null, fallback?: string): string {
  const raw = (s || "").replace(/-/g, "").trim();
  if (raw.length === 8 && /^\d{8}$/.test(raw)) return raw;
  const fb = (fallback || "").replace(/-/g, "").trim();
  if (fb.length === 8 && /^\d{8}$/.test(fb)) return fb;
  return dayjs().format("YYYYMMDD");
}

function readStoredDate(): string | null {
  try {
    const v = sessionStorage.getItem(HISTORY_DATE_KEY);
    if (v && /^\d{8}$/.test(v)) return v;
  } catch {
    /* ignore */
  }
  return null;
}

/** 供 App 初始化历史日期：优先会话缓存，其次交易日 */
export function resolveHistoryDate(tradeDate?: string): string {
  return normalizeYmd(readStoredDate(), tradeDate);
}

export function writeStoredDate(ds: string) {
  try {
    sessionStorage.setItem(HISTORY_DATE_KEY, ds);
  } catch {
    /* ignore */
  }
}
