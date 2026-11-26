export const QUERY_LOG_POLL_MS = 2000;
export const FILE_TREE_POLL_MS = 3000;
export const SCHEMA_STALE_MS = 60_000;

export function shortVersion(v: string): string {
  return v.split(" ").slice(0, 2).join(" ");
}

// Timezone helpers. `tz` is an IANA zone (e.g. "Europe/Paris"); "" or an invalid
// zone falls back to the browser's local timezone. `input` is epoch ms or an ISO
// string (backend timestamps are UTC, tagged with a trailing "Z").
function tzOpts(tz: string): { timeZone?: string } {
  return tz ? { timeZone: tz } : {};
}

/** Wall-clock time, e.g. "14:30:05" — used for the dense log stream. */
export function formatClock(input: number | string, tz: string): string {
  try {
    return new Date(input).toLocaleTimeString(undefined, { hour12: false, ...tzOpts(tz) });
  } catch {
    return new Date(input).toLocaleTimeString(undefined, { hour12: false });
  }
}

/** Absolute date + time, e.g. "Jul 7, 2026, 14:30" — used for tooltips. */
export function formatDateTime(input: number | string, tz: string): string {
  try {
    return new Date(input).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      hour12: false, ...tzOpts(tz),
    });
  } catch {
    return new Date(input).toLocaleString();
  }
}

/** The label to show for the "automatic" timezone option. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: i === 0 ? 0 : 2 }).format(v) + " " + units[i];
}

export function formatCount(n: number): string {
  if (n <= 0) return "0";
  return new Intl.NumberFormat(undefined, { notation: "compact", compactDisplay: "short", maximumFractionDigits: 1 }).format(n);
}

export const LEVEL_COLORS: Record<string, string> = {
  info:  "text-soft",
  warn:  "text-amber-400",
  error: "text-red-400",
};

export type LogSource = "user" | "agent" | "system";

export const SOURCE_LABELS: Record<LogSource, string> = {
  user:   "User",
  agent:  "Agent",
  system: "System",
};

export function sourceBadge(source: string): string {
  if (source === "agent")  return "bg-agent-bg-strong text-agent-strong";
  if (source === "system") return "bg-system-bg text-key";
  return "bg-accent-bg text-accent-text-strong";
}

export function sourceLabel(source: string): string {
  if (source === "agent")  return "🤖 agent";
  if (source === "system") return "⚙ system";
  return "👤 user";
}

// Activity kind — *what* a log entry is about, orthogonal to its source. Lets the
// logs be filtered by type of work (raw SQL vs. a chart the agent drew, etc.).
export type ActivityKind = "sql" | "visualize" | "schema" | "saved" | "chat" | "app";

export const ALL_ACTIVITY_KINDS: ActivityKind[] = ["sql", "visualize", "schema", "saved", "chat", "app"];

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  sql: "SQL",
  visualize: "Visualize",
  schema: "Schema",
  saved: "Saved",
  chat: "Chat",
  app: "App",
};

// Tag/chip colors per activity kind (background + text).
export const ACTIVITY_BADGE: Record<ActivityKind, string> = {
  sql:       "bg-accent-bg-dim text-accent-text-strong",
  visualize: "bg-agent-bg-soft text-agent-strong",
  schema:    "bg-success-bg text-key",
  saved:     "bg-warning-bg-soft text-warning",
  chat:      "bg-chat-badge-bg text-chat-badge",
  app:       "bg-raised-hover text-subtle",
};

// Map an agent tool name to its activity kind (for tool-call log entries).
export function toolActivityKind(tool?: string): ActivityKind {
  switch (tool) {
    case "render_chart": return "visualize";
    case "inspect_schema": return "schema";
    case "list_saved_queries": return "saved";
    default: return "sql"; // run_query, run_explain, submit_query
  }
}

export function levelColor(lvl: string): string {
  return LEVEL_COLORS[lvl] ?? "text-soft";
}

export function abbrevType(t: string): string {
  return t
    .replace("character varying", "varchar")
    .replace("timestamp without time zone", "timestamp")
    .replace("timestamp with time zone", "timestamptz")
    .replace("double precision", "float8")
    .replace(/^character\(/, "char(");
}

// A shorter type for narrow places such as diagram cards, where ClickHouse's
// wrapper types would not fit. The full type belongs in a tooltip next to it.
export function compactType(t: string): string {
  return abbrevType(t)
    .replace(/DateTime64\((\d+), '[^']*'\)/g, "DateTime64($1)")
    .replace(/^SimpleAggregateFunction\((\w+), (.*)\)$/, "$1($2)")
    .replace(/Nullable\(([^()]*(?:\([^()]*\))?)\)/g, "$1?")
    .replace(/^LowCardinality\((.*)\)$/, "LC($1)");
}

// Cut ``s`` to ``maxChars``, ending with an ellipsis when it was longer.
export function fitText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(1, maxChars - 1)) + "…";
}
