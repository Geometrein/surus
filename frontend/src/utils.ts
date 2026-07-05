export const QUERY_LOG_POLL_MS = 2000;
export const FILE_TREE_POLL_MS = 3000;
export const SCHEMA_STALE_MS = 60_000;

export function shortVersion(v: string): string {
  return v.split(" ").slice(0, 2).join(" ");
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
  info:  "text-[#a0a0a8]",
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
  if (source === "agent")  return "bg-[#3a2f55] text-[#c9a8ff]";
  if (source === "system") return "bg-[#2a3330] text-[#86c5a8]";
  return "bg-[#1e3550] text-[#8fb6e8]";
}

export function sourceLabel(source: string): string {
  if (source === "agent")  return "🤖 agent";
  if (source === "system") return "⚙ system";
  return "👤 user";
}

export function levelColor(lvl: string): string {
  return LEVEL_COLORS[lvl] ?? "text-[#a0a0a8]";
}

export function abbrevType(t: string): string {
  return t
    .replace("character varying", "varchar")
    .replace("timestamp without time zone", "timestamp")
    .replace("timestamp with time zone", "timestamptz")
    .replace("double precision", "float8")
    .replace(/^character\(/, "char(");
}
