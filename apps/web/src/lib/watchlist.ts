const LEGACY_KEY = "dingpan.watchlist";

function normalizeCodes(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const c = String(x || "").trim().padStart(6, "0");
    if (!/^\d{6}$/.test(c) || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

function loadLegacyLocal(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    return normalizeCodes(JSON.parse(raw));
  } catch {
    return [];
  }
}

function clearLegacyLocal() {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}

/** 从本地服务配置（%APPDATA%/DingPan/user_config.json）读取；兼容迁移旧 localStorage */
export async function loadWatchlist(): Promise<string[]> {
  try {
    const res = await fetch("/api/watchlist");
    if (res.ok) {
      const data = (await res.json()) as { codes?: unknown };
      const codes = normalizeCodes(data.codes);
      if (codes.length) {
        clearLegacyLocal();
        return codes;
      }
    }
  } catch {
    /* fall through to legacy */
  }

  const legacy = loadLegacyLocal();
  if (legacy.length) {
    try {
      await saveWatchlist(legacy);
      clearLegacyLocal();
    } catch {
      /* keep legacy until next success */
    }
    return legacy;
  }
  return [];
}

/** 持久化到本地服务配置文件 */
export async function saveWatchlist(codes: string[]): Promise<string[]> {
  const normalized = normalizeCodes(codes);
  const res = await fetch("/api/watchlist", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codes: normalized }),
  });
  if (!res.ok) throw new Error(`save watchlist failed: ${res.status}`);
  const data = (await res.json()) as { codes?: unknown };
  return normalizeCodes(data.codes ?? normalized);
}
