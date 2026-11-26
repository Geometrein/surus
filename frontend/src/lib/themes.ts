// The selectable themes. Their colours live in index.css (Surus Dark, the
// defaults) and themes.css; `preview` is only for the swatches in Settings.
import { clearColorCache } from "./theme";

export interface ThemeInfo {
  id: string;
  label: string;
  preview: { app: string; panel: string; accent: string; text: string; agent: string };
}

export const THEMES: ThemeInfo[] = [
  {
    id: "surus-dark",
    label: "Surus Dark",
    preview: { app: "#161619", panel: "#1f1f24", accent: "#3b6fb5", text: "#c8c8d0", agent: "#ae84cb" },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    preview: { app: "#16161e", panel: "#1f2335", accent: "#7aa2f7", text: "#a9b1d6", agent: "#bb9af7" },
  },
];

export const DEFAULT_THEME = THEMES[0].id;

export function isTheme(id: string): boolean {
  return THEMES.some((t) => t.id === id);
}

// Point the page at a theme. Colours read from code are cached, so the cache is
// cleared; components that read them re-render because the store's theme changed.
export function applyTheme(id: string): void {
  if (id === DEFAULT_THEME) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  clearColorCache();
}
