// Shared chat primitives used by both the editor's ChatPanel and the Ask page:
// mode metadata, message/step types, history rehydration, and small view helpers.
import type { AgentEvent, ChatMessageT, ChatSessionT } from "../../api/client";

// The backend surfaces "Invalid API key. Check Settings." as plain text. Turn
// the "Check Settings" hint into a markdown link with a sentinel href that the
// chat renderer intercepts (see the custom `a` component) to jump to the API-key
// settings instead of making the user hunt for them.
export function linkifyError(text: string): string {
  return text.replace(/Check Settings\.?/i, "[Check Settings](#api-key).");
}

export type AgentMode = "sql" | "question" | "teach";

export const MODES: { value: AgentMode; label: string; description: string; placeholder: string; hint: string }[] = [
  {
    value: "sql",
    label: "SQL",
    description: "Write a performant query",
    placeholder: "Ask for a query in plain English…",
    hint: "Ask for data in plain English. I'll write SQL, run EXPLAIN, tune it, and return a performant query.",
  },
  {
    value: "question",
    label: "Question",
    description: "Get an answer about your data",
    placeholder: "Ask anything about your database…",
    hint: "Ask anything about your data. I'll look into the data and answer to the best of my ability.",
  },
  {
    value: "teach",
    label: "Teach",
    description: "Learn SQL with explanations",
    placeholder: "Ask for a query and I'll explain how it works…",
    hint: "Ask for a query and I'll build it step by step, explaining every clause so you can learn from it.",
  },
];

export interface Step {
  toolName?: string;
  toolInput?: Record<string, unknown> | null;
  ok?: boolean;
}
export interface Msg {
  role: "user" | "assistant";
  text: string;
  steps: Step[];
}

// Fold one streamed AgentEvent into the message list, returning a *new* array.
//
// Each complete assistant text block the backend emits becomes its own bubble;
// tool calls attach to the current "open" bubble (the trail shown above its
// text). A bubble is open while it has no text yet — once text lands, the next
// text block or tool call starts a fresh bubble. This keeps an agent turn like
// "plan → run a query → answer" as three legible pieces instead of one blob.
export function appendEvent(messages: Msg[], e: AgentEvent): Msg[] {
  const copy = [...messages];
  const last = copy[copy.length - 1];
  const open = last && last.role === "assistant" && !last.text ? last : null;

  if (e.kind === "text") {
    const text = e.text ?? "";
    if (open) copy[copy.length - 1] = { ...open, text };
    else copy.push({ role: "assistant", text, steps: [] });
  } else if (e.kind === "tool_call") {
    const step: Step = { toolName: e.toolName, toolInput: e.toolInput };
    if (open) copy[copy.length - 1] = { ...open, steps: [...open.steps, step] };
    else copy.push({ role: "assistant", text: "", steps: [step] });
  } else if (e.kind === "tool_result") {
    if (last && last.role === "assistant" && last.steps.length) {
      const steps = [...last.steps];
      steps[steps.length - 1] = { ...steps[steps.length - 1], ok: e.ok };
      copy[copy.length - 1] = { ...last, steps };
    }
  } else if (e.kind === "error") {
    const text = `**Error:** ${linkifyError(e.text ?? "")}`;
    if (open) copy[copy.length - 1] = { ...open, text };
    else copy.push({ role: "assistant", text, steps: [] });
  }
  return copy;
}

export function msgsFromHistory(raw: ChatMessageT[]): Msg[] {
  return raw.map((m) => {
    const steps: Step[] = m.steps_json
      ? (JSON.parse(m.steps_json) as { kind: string; toolName?: string; toolInput?: Record<string, unknown>; ok?: boolean }[])
          .filter((s) => s.kind === "tool_call")
          .map((s) => ({ toolName: s.toolName, toolInput: s.toolInput, ok: s.ok }))
      : [];
    return { role: m.role as "user" | "assistant", text: m.content, steps };
  });
}

export function groupSessionsByDate(sessions: ChatSessionT[]): { label: string; items: ChatSessionT[] }[] {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const weekAgo = today - 6 * 86400000;

  const buckets: { label: string; items: ChatSessionT[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This week", items: [] },
    { label: "Older", items: [] },
  ];

  for (const s of sessions) {
    const t = startOfDay(new Date(s.created_at));
    if (t >= today) buckets[0].items.push(s);
    else if (t >= yesterday) buckets[1].items.push(s);
    else if (t >= weekAgo) buckets[2].items.push(s);
    else buckets[3].items.push(s);
  }

  return buckets.filter((b) => b.items.length > 0);
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Charts (render_chart tool) ───────────────────────────────────────────────

export type ChartType = "line" | "bar" | "area" | "pie" | "scatter";

export interface ChartSpec {
  chartType: ChartType;
  x: string;
  y: string[];
  series?: string;
  title?: string;
}

/** Parse a render_chart tool_call's input into a spec, or null if malformed. */
export function parseChartSpec(
  input: Record<string, unknown> | null | undefined
): { sql: string; spec: ChartSpec } | null {
  if (!input) return null;
  const sql = typeof input.sql === "string" ? input.sql : "";
  const chartType = input.chart_type as ChartType;
  const x = typeof input.x === "string" ? input.x : "";
  const yRaw = input.y;
  const y = Array.isArray(yRaw) ? yRaw.map(String) : typeof yRaw === "string" ? [yRaw] : [];
  const series = typeof input.series === "string" && input.series ? input.series : undefined;
  const title = typeof input.title === "string" ? input.title : undefined;
  const valid: ChartType[] = ["line", "bar", "area", "pie", "scatter"];
  if (!sql || !valid.includes(chartType) || !x || y.length === 0) return null;
  return { sql, spec: { chartType, x, y, series, title } };
}

export function oneLine(text: string, max = 200): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// "claude-opus-4-8" -> "Opus 4.8", "claude-haiku-4-5-20251001" -> "Haiku 4.5".
// GPT and Gemini ids keep their conventional casing, with any trailing tier or
// codename spelled out: "gpt-4.1" -> "GPT-4.1", "gpt-5.6-sol" -> "GPT-5.6 Sol",
// "gemini-3.1-pro-preview" -> "Gemini 3.1 Pro Preview".
export function modelLabel(id: string): string {
  if (/^(gpt|o\d|gemini)/i.test(id)) {
    const [family, ...rest] = id.split("-");
    const version = /^\d/.test(rest[0] ?? "") ? rest.shift() : undefined;
    const isGpt = /^gpt$/i.test(family);
    const head = isGpt ? "GPT" : title(family);
    // OpenAI hyphenates the version ("GPT-5"), Google spaces it ("Gemini 3.5").
    const base = version ? `${head}${isGpt ? "-" : " "}${version}` : head;
    const suffix = rest.map(title).join(" ");
    return suffix ? `${base} ${suffix}` : base;
  }
  const parts = id.replace(/^claude-/, "").split("-");
  const name = title(parts[0]);
  const nums = parts.slice(1).filter((p) => /^\d+$/.test(p) && p.length <= 2);
  return nums.length ? `${name} ${nums.join(".")}` : name;
}

export function toolLabel(name?: string) {
  return (
    {
      run_explain: "Running EXPLAIN",
      run_query: "Sampling rows",
      inspect_schema: "Inspecting schema",
      list_saved_queries: "Reading saved queries",
      render_chart: "Drawing chart",
      submit_query: "Finalizing query",
    }[name ?? ""] ?? name
  );
}

// Describes what the agent is currently doing, for the live indicator.
export function activityLabel(messages: Msg[]): string {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.steps.length && !last.text) {
    return toolLabel(last.steps[last.steps.length - 1].toolName) ?? "Working";
  }
  return "Thinking";
}
