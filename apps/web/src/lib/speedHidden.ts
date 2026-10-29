const STORAGE_KEY = "dingpan.speedHiddenCodes";

export type SpeedHiddenEntry = {
  code: string;
  name: string;
  hiddenAt: string;
};

function readRaw(): SpeedHiddenEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const o = x as Record<string, unknown>;
        const code = String(o.code || "").trim();
        if (!code) return null;
        return {
          code,
          name: String(o.name || code),
          hiddenAt: String(o.hiddenAt || ""),
        } satisfies SpeedHiddenEntry;
      })
      .filter((x): x is SpeedHiddenEntry => !!x);
  } catch {
    return [];
  }
}

function writeRaw(list: SpeedHiddenEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function loadSpeedHidden(): SpeedHiddenEntry[] {
  return readRaw();
}

export function loadSpeedHiddenCodes(): Set<string> {
  return new Set(readRaw().map((e) => e.code));
}

export function addSpeedHidden(code: string, name: string): SpeedHiddenEntry[] {
  const list = readRaw().filter((e) => e.code !== code);
  list.unshift({
    code,
    name: name || code,
    hiddenAt: new Date().toISOString(),
  });
  writeRaw(list);
  return list;
}

export function removeSpeedHidden(code: string): SpeedHiddenEntry[] {
  const list = readRaw().filter((e) => e.code !== code);
  writeRaw(list);
  return list;
}

export function clearSpeedHidden(): SpeedHiddenEntry[] {
  writeRaw([]);
  return [];
}
