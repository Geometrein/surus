import { useStore } from "../store";

// The current theme id. Components that read colours from code (charts, the
// schema diagram) call this so they redraw when the theme changes.
export function useTheme(): string {
  return useStore((s) => s.theme);
}
