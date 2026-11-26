// Colour tokens (defined in index.css) for code that styles things itself.
//
// HTML style props and CSS-based libraries take `cssVar(token)`, which follows
// the theme on its own. SVG presentation attributes, chart props and canvas
// drawing can't read CSS variables, so they take `color(token)`: the token's
// current value, cached until `clearColorCache()` runs on a theme change.

const cache = new Map<string, string>();

export function cssVar(token: string): string {
  return `var(--color-${token})`;
}

export function color(token: string): string {
  let value = cache.get(token);
  if (value === undefined) {
    value = getComputedStyle(document.documentElement).getPropertyValue(`--color-${token}`).trim();
    // Not cached while empty, i.e. before the stylesheet has loaded.
    if (value) cache.set(token, value);
  }
  return value;
}

export function clearColorCache(): void {
  cache.clear();
}

const CHART_SERIES = 8;

// The colour of the i-th chart series, cycling through the palette.
export function chartColor(i: number): string {
  return color(`chart-${(i % CHART_SERIES) + 1}`);
}

export function chartTooltipStyle() {
  return {
    contentStyle: {
      background: color("raised"),
      border: `1px solid ${color("line")}`,
      borderRadius: 6,
      fontSize: 12,
    },
    labelStyle: { color: color("body") },
  };
}

// The colours offered for a connection. The saved value is the colour code,
// drawn as the current theme's version of that swatch; any other saved value
// (none today) is drawn as is.
export const CONNECTION_COLORS = [
  "#c2554f", "#c47f3d", "#b9a23f", "#4f9d63", "#3a9a92", "#4a7fc5", "#8266c4", "#b85e94",
];

export function connectionColor(saved: string): string {
  if (!saved) return "transparent";
  const i = CONNECTION_COLORS.indexOf(saved.toLowerCase());
  return i === -1 ? saved : cssVar(`swatch-${i + 1}`);
}
