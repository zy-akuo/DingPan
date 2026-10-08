/** Browser-side TTL cache (memory + localStorage) for instant re-open. */

type Entry = { exp: number; data: unknown };

const mem = new Map<string, Entry>();
const PREFIX = "dingpan.cache.";

function now() {
  return Date.now();
}

export function cacheGet<T>(key: string): T | null {
  const m = mem.get(key);
  if (m && m.exp > now()) return m.data as T;
  if (m) mem.delete(key);
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Entry;
    if (!parsed || parsed.exp < now()) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    mem.set(key, parsed);
    return parsed.data as T;
  } catch {
    return null;
  }
}

export function cacheSet(key: string, data: unknown, ttlSec: number) {
  const entry: Entry = { exp: now() + Math.max(1, ttlSec) * 1000, data };
  mem.set(key, entry);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    /* quota — ignore */
  }
  // soft cleanup occasionally
  if (mem.size > 200) {
    for (const [k, v] of mem) {
      if (v.exp < now()) mem.delete(k);
    }
  }
}

/** Purge expired localStorage cache keys (call on app start). */
export function cachePurgeExpired() {
  const t = now();
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      try {
        const parsed = JSON.parse(localStorage.getItem(k) || "") as Entry;
        if (!parsed?.exp || parsed.exp < t) localStorage.removeItem(k);
      } catch {
        localStorage.removeItem(k);
      }
    }
  } catch {
    /* ignore */
  }
  for (const [k, v] of mem) {
    if (v.exp < t) mem.delete(k);
  }
}
