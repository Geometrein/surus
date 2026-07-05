import { describe, it, expect, beforeEach } from "vitest";
import { useStore, DEFAULT_TAB_ID } from "./store";
import type { QueryLogEntry } from "./api/client";

// The store is a module singleton; reset the slices under test before each case.
beforeEach(() => {
  useStore.setState({
    tabs: [{ id: DEFAULT_TAB_ID, title: "Console", sql: "SELECT 1;" }],
    activeTabId: DEFAULT_TAB_ID,
    runSignal: 0,
    logs: [],
    queryLogSeq: 0,
    page: "connections",
  });
});

const s = () => useStore.getState();

describe("tabs", () => {
  it("openTab appends a tab, activates it, and switches to the editor", () => {
    s().openTab("Query 1", "select 2");
    expect(s().tabs).toHaveLength(2);
    expect(s().tabs[1]).toMatchObject({ title: "Query 1", sql: "select 2" });
    expect(s().activeTabId).toBe(s().tabs[1].id);
    expect(s().page).toBe("editor");
  });

  it("openTab dedupes by key — re-opening focuses the existing tab", () => {
    s().openTab("A", "sqlA", false, "saved:1");
    const firstId = s().tabs.find((t) => t.key === "saved:1")!.id;
    s().openTab("A (again)", "sqlA2", false, "saved:1");
    expect(s().tabs.filter((t) => t.key === "saved:1")).toHaveLength(1);
    expect(s().activeTabId).toBe(firstId);
  });

  it("openTab with run=true bumps the run signal", () => {
    const before = s().runSignal;
    s().openTab("R", "select 1", true);
    expect(s().runSignal).toBe(before + 1);
  });

  it("closeTab never closes the default console tab", () => {
    s().closeTab(DEFAULT_TAB_ID);
    expect(s().tabs).toHaveLength(1);
  });

  it("closeTab on the active tab reselects the previous one", () => {
    s().openTab("T1", "1");
    s().openTab("T2", "2");
    const [, t1, t2] = s().tabs;
    expect(s().activeTabId).toBe(t2.id);
    s().closeTab(t2.id);
    expect(s().tabs.map((t) => t.id)).not.toContain(t2.id);
    expect(s().activeTabId).toBe(t1.id);
  });

  it("closeTab on a background tab keeps the active tab", () => {
    s().openTab("T1", "1");
    s().openTab("T2", "2");
    const [, t1, t2] = s().tabs;
    s().closeTab(t1.id);
    expect(s().activeTabId).toBe(t2.id);
  });
});

describe("logs", () => {
  it("log appends entries and caps the buffer at 500", () => {
    for (let i = 0; i < 600; i++) s().log("info", `msg ${i}`);
    expect(s().logs).toHaveLength(500);
    expect(s().logs.at(-1)?.msg).toBe("msg 599");
  });

  it("clearLogs empties the buffer", () => {
    s().log("info", "hi");
    s().clearLogs();
    expect(s().logs).toEqual([]);
  });
});

describe("ingestQueryLogs", () => {
  const entry = (over: Partial<QueryLogEntry>): QueryLogEntry => ({
    seq: 1,
    ts: 1_700_000_000,
    source: "user",
    connectionId: "c1",
    pool: "main",
    sql: "select 1",
    durationMs: 3,
    rowCount: 5,
    error: null,
    ...over,
  });

  it("ingests only entries newer than the current seq and advances it", () => {
    s().ingestQueryLogs([entry({ seq: 1 }), entry({ seq: 2 })]);
    expect(s().logs).toHaveLength(2);
    expect(s().queryLogSeq).toBe(2);

    // Re-delivering the same seqs is a no-op.
    s().ingestQueryLogs([entry({ seq: 1 }), entry({ seq: 2 })]);
    expect(s().logs).toHaveLength(2);

    s().ingestQueryLogs([entry({ seq: 3 })]);
    expect(s().logs).toHaveLength(3);
    expect(s().queryLogSeq).toBe(3);
  });

  it("formats a successful entry as pool · rows · sql", () => {
    s().ingestQueryLogs([entry({ seq: 1, pool: "main", rowCount: 5, sql: "select 1" })]);
    const log = s().logs.at(-1)!;
    expect(log.level).toBe("info");
    expect(log.msg).toBe("[main] 5 rows · select 1");
  });

  it("marks errored entries and includes the error text", () => {
    s().ingestQueryLogs([entry({ seq: 1, error: "syntax error", rowCount: null })]);
    const log = s().logs.at(-1)!;
    expect(log.level).toBe("error");
    expect(log.msg).toContain("syntax error");
  });
});
