export type ThemeMode = "light" | "dark";

const KEY = "dingpan.theme";

export function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light") return v;
  } catch {
    /* ignore */
  }
  return "dark";
}

export function saveTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
}

export function applyThemeToDom(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode;
}
