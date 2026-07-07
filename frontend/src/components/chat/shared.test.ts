import { describe, it, expect } from "vitest";
import { appendEvent, parseChartSpec } from "./shared";
import type { Msg } from "./shared";
import type { AgentEvent } from "../../api/client";

const user: Msg = { role: "user", text: "Are orders trending?", steps: [] };
const ev = (e: Partial<AgentEvent> & { kind: AgentEvent["kind"] }): AgentEvent =>
  ({ kind: e.kind, text: e.text, toolName: e.toolName, toolInput: e.toolInput ?? null, ok: e.ok });

describe("appendEvent", () => {
  it("makes each assistant text block its own bubble", () => {
    let m: Msg[] = [user];
    m = appendEvent(m, ev({ kind: "text", text: "Let me look." }));
    m = appendEvent(m, ev({ kind: "text", text: "Here is the answer." }));
    const assistant = m.filter((x) => x.role === "assistant");
    expect(assistant).toHaveLength(2);
    expect(assistant.map((a) => a.text)).toEqual(["Let me look.", "Here is the answer."]);
  });

  it("attaches a tool trail to the bubble whose text follows it", () => {
    let m: Msg[] = [user];
    m = appendEvent(m, ev({ kind: "text", text: "I'll check the orders table." }));
    m = appendEvent(m, ev({ kind: "tool_call", toolName: "run_query", toolInput: { sql: "select 1" } }));
    m = appendEvent(m, ev({ kind: "tool_result", ok: true }));
    m = appendEvent(m, ev({ kind: "text", text: "Short answer: flat." }));

    // user + two assistant bubbles; the tool trail rides with the 2nd.
    expect(m).toHaveLength(3);
    const [, first, second] = m;
    expect(first).toEqual({ role: "assistant", text: "I'll check the orders table.", steps: [] });
    expect(second.text).toBe("Short answer: flat.");
    expect(second.steps).toEqual([{ toolName: "run_query", toolInput: { sql: "select 1" }, ok: true }]);
  });

  it("keeps a trailing tool call (e.g. submit_query) as its own textless bubble", () => {
    let m: Msg[] = [user];
    m = appendEvent(m, ev({ kind: "text", text: "Working on it." }));
    m = appendEvent(m, ev({ kind: "tool_call", toolName: "submit_query", toolInput: { sql: "select 2" } }));
    m = appendEvent(m, ev({ kind: "tool_result", ok: true }));
    expect(m).toHaveLength(3);
    expect(m[2]).toEqual({
      role: "assistant",
      text: "",
      steps: [{ toolName: "submit_query", toolInput: { sql: "select 2" }, ok: true }],
    });
  });

  it("renders an error as its own bubble when nothing is open", () => {
    const m = appendEvent([user], ev({ kind: "error", text: "Rate limited." }));
    expect(m[1]).toEqual({ role: "assistant", text: "**Error:** Rate limited.", steps: [] });
  });
});

describe("parseChartSpec", () => {
  it("parses a valid render_chart tool input", () => {
    const out = parseChartSpec({
      sql: "select month, orders from t order by month",
      chart_type: "line",
      x: "month",
      y: ["orders"],
      title: "Orders by month",
    });
    expect(out).toEqual({
      sql: "select month, orders from t order by month",
      spec: { chartType: "line", x: "month", y: ["orders"], series: undefined, title: "Orders by month" },
    });
  });

  it("coerces a single y string into an array", () => {
    const out = parseChartSpec({ sql: "select 1", chart_type: "bar", x: "a", y: "b" });
    expect(out?.spec.y).toEqual(["b"]);
  });

  it("rejects malformed specs (bad type, missing fields)", () => {
    expect(parseChartSpec(null)).toBeNull();
    expect(parseChartSpec({ sql: "select 1", chart_type: "pie", x: "a", y: [] })).toBeNull();
    expect(parseChartSpec({ sql: "select 1", chart_type: "donut", x: "a", y: ["b"] })).toBeNull();
    expect(parseChartSpec({ chart_type: "line", x: "a", y: ["b"] })).toBeNull();
  });
});
