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

export type CodeListPayload = { codes: string[]; pinned: string[] };

function sortWithPinned(codes: string[], pinned: string[]): string[] {
  const pinSet = new Set(pinned);
  const top = pinned.filter((c) => codes.includes(c));
  const rest = codes.filter((c) => !pinSet.has(c));
  return [...top, ...rest];
}

/** 从本地服务配置读取；兼容迁移旧 localStorage */
export async function loadWatchlist(): Promise<CodeListPayload> {
  try {
    const res = await fetch("/api/watchlist");
    if (res.ok) {
      const data = (await res.json()) as { codes?: unknown; pinned?: unknown };
      const codes = normalizeCodes(data.codes);
      const pinned = normalizeCodes(data.pinned).filter((c) => codes.includes(c));
      if (codes.length) {
        clearLegacyLocal();
        return { codes: sortWithPinned(codes, pinned), pinned };
      }
      return { codes: [], pinned: [] };
    }
  } catch {
    /* fall through to legacy */
  }

  const legacy = loadLegacyLocal();
  if (legacy.length) {
    try {
      const saved = await saveWatchlist(legacy, []);
      clearLegacyLocal();
      return saved;
    } catch {
      return { codes: legacy, pinned: [] };
    }
  }
  return { codes: [], pinned: [] };
}

/** 持久化到本地服务配置文件 */
export async function saveWatchlist(
  codes: string[],
  pinned: string[],
): Promise<CodeListPayload> {
  const normalized = normalizeCodes(codes);
  const pinNorm = normalizeCodes(pinned).filter((c) => normalized.includes(c));
  const res = await fetch("/api/watchlist", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codes: normalized, pinned: pinNorm }),
  });
  if (!res.ok) throw new Error(`save watchlist failed: ${res.status}`);
  const data = (await res.json()) as { codes?: unknown; pinned?: unknown };
  const codesOut = normalizeCodes(data.codes ?? normalized);
  const pinnedOut = normalizeCodes(data.pinned ?? pinNorm).filter((c) =>
    codesOut.includes(c),
  );
  return { codes: sortWithPinned(codesOut, pinnedOut), pinned: pinnedOut };
}

export async function loadAlertlist(): Promise<CodeListPayload> {
  const res = await fetch("/api/alertlist");
  if (!res.ok) return { codes: [], pinned: [] };
  const data = (await res.json()) as { codes?: unknown; pinned?: unknown };
  const codes = normalizeCodes(data.codes);
  const pinned = normalizeCodes(data.pinned).filter((c) => codes.includes(c));
  return { codes: sortWithPinned(codes, pinned), pinned };
}

export async function saveAlertlist(
  codes: string[],
  pinned: string[],
): Promise<CodeListPayload> {
  const normalized = normalizeCodes(codes);
  const pinNorm = normalizeCodes(pinned).filter((c) => normalized.includes(c));
  const res = await fetch("/api/alertlist", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codes: normalized, pinned: pinNorm }),
  });
  if (!res.ok) throw new Error(`save alertlist failed: ${res.status}`);
  const data = (await res.json()) as { codes?: unknown; pinned?: unknown };
  const codesOut = normalizeCodes(data.codes ?? normalized);
  const pinnedOut = normalizeCodes(data.pinned ?? pinNorm).filter((c) =>
    codesOut.includes(c),
  );
  return { codes: sortWithPinned(codesOut, pinnedOut), pinned: pinnedOut };
}
