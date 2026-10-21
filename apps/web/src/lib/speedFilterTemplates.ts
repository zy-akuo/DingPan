import {
  normalizeSpeedFilter,
  type SpeedFilter,
} from "./speedFilter";

const KEY = "dingpan.speedFilterTemplates";

export interface SpeedFilterTemplate {
  id: string;
  name: string;
  filter: SpeedFilter;
  createdAt: number;
}

export function loadSpeedFilterTemplates(): SpeedFilterTemplate[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        id: String(x.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        name: String(x.name || "未命名模板"),
        filter: normalizeSpeedFilter(x.filter as Partial<SpeedFilter>),
        createdAt: typeof x.createdAt === "number" ? x.createdAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

export function saveSpeedFilterTemplates(list: SpeedFilterTemplate[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function addSpeedFilterTemplate(
  name: string,
  filter: SpeedFilter,
): SpeedFilterTemplate[] {
  const list = loadSpeedFilterTemplates();
  const next: SpeedFilterTemplate = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || "未命名模板",
    filter: normalizeSpeedFilter(filter),
    createdAt: Date.now(),
  };
  const out = [next, ...list].slice(0, 30);
  saveSpeedFilterTemplates(out);
  return out;
}

export function removeSpeedFilterTemplate(id: string): SpeedFilterTemplate[] {
  const out = loadSpeedFilterTemplates().filter((t) => t.id !== id);
  saveSpeedFilterTemplates(out);
  return out;
}
