import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Save, Check, Play, SquareIcon, BugPlay, Download, AlignJustify, LayoutGrid, BotMessageSquare, ChartSpline, ArrowDownToLine, Lock, PenLine, TriangleAlert } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { keymap, EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { AgGridReact } from "ag-grid-react";
import { themeQuartz, type ColDef } from "ag-grid-community";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type QueryResult, type TableDetail } from "../api/client";
import { useStore, DEFAULT_TAB_ID } from "../store";
import { ChartView } from "./ChartView";
import { Modal } from "./Modal";
import { SCHEMA_STALE_MS, abbrevType } from "../utils";
import { parseExplainTree, splitNodeLine, isLargeSeqScan, type ExplainNode } from "../lib/explain";

// Sentinel error value: signals "no active connection" so the results area can
// render a friendly notice with a Connect link instead of a raw error string.
const NOT_CONNECTED = "\0not-connected";

function extractParams(sqlText: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const re = /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sqlText)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); result.push(m[1]); }
  }
  return result;
}


function StructureView({
  connectionId,
  schema,
  table,
}: {
  connectionId: string;
  schema: string;
  table: string;
}) {
  const detail = useQuery({
    queryKey: ["table-detail", connectionId, schema, table],
    queryFn: () => api.tableDetail(connectionId, schema, table),
    staleTime: SCHEMA_STALE_MS,
  });

  if (detail.isLoading)
    return <div className="p-4 text-sm text-[#6a6a72]">Loading structure…</div>;
  if (detail.error)
    return <div className="p-4 text-sm text-red-400">Failed to load structure</div>;

  const d = detail.data as TableDetail;
  const fkCols = new Set(d.foreignKeys.map((fk) => fk.column));

  const thClass = "text-left py-1.5 pr-4 text-[11px] font-semibold text-[#6a6a72] tracking-wide border-b border-[#2c2c33]";
  const tdClass = "py-1 pr-4 text-[12px] border-b border-[#1e1e22]";

  return (
    <div className="h-full overflow-auto p-4 text-[12px]">
      {/* Columns */}
      <div className="mb-2 text-[11px] font-bold tracking-wider text-[#6a6a72]">COLUMNS</div>
      <table className="w-full border-collapse mb-6">
        <thead>
          <tr>
            <th className={thClass}>Name</th>
            <th className={thClass}>Type</th>
            <th className={thClass}>Nullable</th>
            <th className={thClass}>Default</th>
          </tr>
        </thead>
        <tbody>
          {d.columns.map((col) => (
            <tr key={col.name} className="hover:bg-[#1d1d22]">
              <td className={`${tdClass} font-medium`}>
                <span className={col.isPk ? "text-yellow-300" : "text-[#c8c8d0]"}>
                  {col.isPk && <span className="text-yellow-400 mr-1.5 text-[10px]">⬡</span>}
                  {fkCols.has(col.name) && !col.isPk && (
                    <span className="text-[#5a8ab0] mr-1.5 text-[10px]">→</span>
                  )}
                  {col.name}
                </span>
              </td>
              <td className={`${tdClass} font-mono text-[#5a9ab0]`}>{abbrevType(col.type)}</td>
              <td className={`${tdClass} text-[#6a6a72]`}>{col.nullable ? "YES" : "NO"}</td>
              <td className={`${tdClass} font-mono text-[11px] text-[#5a5a6a] max-w-[220px] truncate`}>
                {col.default ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Indexes */}
      {d.indexes.length > 0 && (
        <>
          <div className="mb-2 text-[11px] font-bold tracking-wider text-[#6a6a72]">INDEXES</div>
          <table className="w-full border-collapse mb-6">
            <thead>
              <tr>
                <th className={thClass}>Name</th>
                <th className={thClass}>Type</th>
                <th className={thClass}>Definition</th>
              </tr>
            </thead>
            <tbody>
              {d.indexes.map((idx) => (
                <tr key={idx.name} className="hover:bg-[#1d1d22]">
                  <td className={`${tdClass} text-[#c8c8d0]`}>{idx.name}</td>
                  <td className={`${tdClass} text-[#6a6a72]`}>
                    {idx.isPrimary ? "PRIMARY" : idx.isUnique ? "UNIQUE" : "INDEX"}
                  </td>
                  <td className={`${tdClass} font-mono text-[11px] text-[#5a5a6a] max-w-[320px] truncate`}
                      title={idx.definition}>
                    {idx.definition}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Foreign Keys */}
      {d.foreignKeys.length > 0 && (
        <>
          <div className="mb-2 text-[11px] font-bold tracking-wider text-[#6a6a72]">FOREIGN KEYS</div>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thClass}>Column</th>
                <th className={thClass}>References</th>
              </tr>
            </thead>
            <tbody>
              {d.foreignKeys.map((fk) => (
                <tr key={fk.column} className="hover:bg-[#1d1d22]">
                  <td className={`${tdClass} text-[#c8c8d0]`}>{fk.column}</td>
                  <td className={`${tdClass} font-mono text-[11px] text-[#5a9ab0]`}>{fk.references}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// Serialize a result set to RFC-4180 CSV (quote fields containing , " or newlines).
function toCsv(columns: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

const gridTheme = themeQuartz.withParams({
  backgroundColor: "#161619",
  foregroundColor: "#e2e2e8",
  headerBackgroundColor: "#1f1f24",
  headerTextColor: "#c8c8d0",
  borderColor: "#2c2c33",
  oddRowBackgroundColor: "#1a1a1e",
  rowHoverColor: "#26262d",
  fontSize: 12,
  headerFontSize: 12,
});

export function EditorResults() {
  const qc = useQueryClient();
  const { activeConnectionId, tabs, activeTabId, setTabSql, setActiveTab, openTab, updateTab, closeTab, runSignal, log, chatOpen, setChatOpen, setPendingChatMessage, writeMode, setWriteMode } =
    useStore();
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const tabSql = activeTab.sql;

  // Result state is kept per tab so switching tabs preserves each tab's output.
  const [results, setResults] = useState<Record<string, QueryResult | null>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [runningTabs, setRunningTabs] = useState<Record<string, boolean>>({});
  const [resultView, setResultView] = useState<"data" | "structure" | "chart">("data");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [saveDialog, setSaveDialog] = useState<{ defaultName: string; onSave: (name: string) => void } | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1800);
  }, []);

  // Track the last-saved SQL per tab so we can detect unsaved changes.
  const [savedSqls, setSavedSqls] = useState<Record<string, string>>({});
  useEffect(() => {
    setSavedSqls((prev) => {
      const next = { ...prev };
      for (const tab of tabs) {
        if (tab.key?.startsWith("saved:") && !(tab.id in next)) {
          next[tab.id] = tab.sql;
        }
      }
      return next;
    });
  }, [tabs]);
  const markSaved = useCallback((tabId: string, sql: string) => {
    setSavedSqls((prev) => ({ ...prev, [tabId]: sql }));
  }, []);

  const isDirty =
    !activeTab.key?.startsWith("saved:") ||
    tabSql !== (savedSqls[activeTabId] ?? null);

  const params = useMemo(() => extractParams(tabSql), [tabSql]);
  const paramsKey = params.join('\0');

  // Sync param inputs when the detected params change (e.g. user edits SQL or switches tabs).
  useEffect(() => {
    setParamValues(prev => {
      const next: Record<string, string> = {};
      for (const name of params) next[name] = prev[name] ?? "";
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  // Derive whether the active tab is a table preview and which table.
  const tableKey = activeTab.key?.startsWith("table:") ? activeTab.key.slice("table:".length) : null;
  const dotIdx = tableKey?.indexOf(".") ?? -1;
  const tableSchema = tableKey && dotIdx >= 0 ? tableKey.slice(0, dotIdx) : null;
  const tableName = tableKey && dotIdx >= 0 ? tableKey.slice(dotIdx + 1) : null;

  // Reset to data view when switching to a non-table tab.
  useEffect(() => {
    if (!tableKey) setResultView("data");
  }, [tableKey]);

  const result = results[activeTabId] ?? null;
  const status = statuses[activeTabId] ?? "";
  const error = errors[activeTabId] ?? null;
  const running = !!runningTabs[activeTabId];
  const isExplainResult = result !== null && result.columns.length === 1 && result.columns[0] === "QUERY PLAN";

  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!running) { setElapsedMs(0); return; }
    const start = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - start), 100);
    return () => clearInterval(id);
  }, [running]);

  const sqlRef = useRef(tabSql);
  sqlRef.current = tabSql;
  const tabIdRef = useRef(activeTabId);
  tabIdRef.current = activeTabId;
  const lastRunSignal = useRef(0);
  const paramValuesRef = useRef(paramValues);
  paramValuesRef.current = paramValues;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const editorViewRef = useRef<EditorView | null>(null);

  const run = useCallback(async (allRows = false) => {
    const tabId = tabIdRef.current;
    // Use selected text if there is one, otherwise run the full editor content.
    const view = editorViewRef.current;
    let rawSql = sqlRef.current;
    if (view) {
      const { from, to } = view.state.selection.main;
      if (from !== to) rawSql = view.state.sliceDoc(from, to);
    }
    let text = rawSql.trim();
    if (!text) return;
    // Substitute named params (:name → user-supplied value)
    for (const name of paramsRef.current) {
      const val = paramValuesRef.current[name] ?? "";
      text = text.replace(new RegExp(`(?<!:):${name}\\b`, 'g'), val);
    }
    const cid = useStore.getState().activeConnectionId;
    if (!cid) {
      setErrors((e) => ({ ...e, [tabId]: NOT_CONNECTED }));
      setStatuses((s) => ({ ...s, [tabId]: "not connected" }));
      return;
    }
    setRunningTabs((r) => ({ ...r, [tabId]: true }));
    setErrors((e) => ({ ...e, [tabId]: null }));
    setStatuses((s) => ({ ...s, [tabId]: "running…" }));
    try {
      // allRows opts out of the preview cap (maxRows: 0 → server fetches all).
      // Read writeMode live (this callback has no reactive deps) so the query
      // hits the write pool only when the toggle is currently on.
      const r = await api.runQuery(cid, text, allRows ? 0 : undefined, useStore.getState().writeMode);
      setResults((res) => ({ ...res, [tabId]: r }));
      setStatuses((s) => ({
        ...s,
        // Writes/DDL return no columns — surface the server tag (e.g. "UPDATE 5")
        // rather than a misleading "N rows".
        [tabId]:
          r.columns.length === 0 && r.notice
            ? `${r.notice} · ${r.durationMs} ms`
            : `${r.rowCount} rows${r.truncated ? " (truncated)" : ""} · ${r.durationMs} ms`,
      }));
      // The query itself is logged authoritatively by the backend (query log).
    } catch (e) {
      setResults((res) => ({ ...res, [tabId]: null }));
      setStatuses((s) => ({ ...s, [tabId]: "error" }));
      setErrors((er) => ({ ...er, [tabId]: (e as Error).message }));
    } finally {
      setRunningTabs((r) => ({ ...r, [tabId]: false }));
    }
  }, []);

  // Run when a table preview / chat action bumps the run signal. Guard against
  // the effect firing more than once per signal value (e.g. StrictMode), so a
  // single openTab(run) never executes the query twice.
  useEffect(() => {
    if (runSignal > 0 && runSignal !== lastRunSignal.current) {
      lastRunSignal.current = runSignal;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSignal]);

  const schemaColumns = useQuery({
    queryKey: ["schema-columns", activeConnectionId],
    queryFn: () => api.schemaColumns(activeConnectionId!),
    enabled: !!activeConnectionId,
    staleTime: SCHEMA_STALE_MS,
  });

  const flatSchema = useMemo(() => {
    if (!schemaColumns.data) return {};
    const flat: Record<string, string[]> = {};
    const seen = new Set<string>();
    // Sort so "public" schema is processed first — it wins unqualified name conflicts.
    const sorted = Object.entries(schemaColumns.data).sort(([a], [b]) =>
      a === "public" ? -1 : b === "public" ? 1 : a.localeCompare(b)
    );
    for (const [schema, tables] of sorted) {
      for (const [table, cols] of Object.entries(tables)) {
        flat[`${schema}.${table}`] = cols;
        if (!seen.has(table)) {
          flat[table] = cols;
          seen.add(table);
        }
      }
    }
    return flat;
  }, [schemaColumns.data]);

  const extensions = useMemo(
    () => [
      sql({ dialect: PostgreSQL, schema: flatSchema }),
      keymap.of([
        { key: "Mod-Enter", run: () => (run(), true) },
        { key: "Ctrl-Enter", run: () => (run(), true) },
      ]),
    ],
    [run, flatSchema]
  );

  const exportCsv = useCallback(() => {
    if (!result || result.columns.length === 0) return;
    const csv = toCsv(result.columns, result.rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query-results-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log("info", `exported ${result.rowCount} rows to CSV`);
  }, [result, log]);

  const explainWithAI = useCallback(() => {
    if (!result) return;
    const plan = result.rows.map((r) => String(r[0] ?? "")).join("\n");
    const sql = tabSql.trim();
    const prompt =
      `Here is a PostgreSQL query plan. Please explain it in plain language, identify any bottlenecks or red flags, and suggest specific optimizations.\n\n` +
      (sql ? `**SQL:**\n\`\`\`sql\n${sql}\n\`\`\`\n\n` : "") +
      `**EXPLAIN output:**\n\`\`\`\n${plan}\n\`\`\``;
    setChatOpen(true);
    setPendingChatMessage(prompt);
  }, [result, tabSql, setChatOpen, setPendingChatMessage]);

  // Hand the failing query + its error to the agent and ask it to explain why it
  // won't run. Only meaningful when the current tab has a real error.
  const debugWithAI = useCallback(() => {
    const sql = tabSql.trim();
    if (!sql || !error || error === NOT_CONNECTED) return;
    const prompt =
      `This PostgreSQL query fails to run. Explain why it doesn't work and how to fix it.\n\n` +
      `**SQL:**\n\`\`\`sql\n${sql}\n\`\`\`\n\n` +
      `**Error:**\n\`\`\`\n${error}\n\`\`\``;
    setChatOpen(true);
    setPendingChatMessage(prompt);
  }, [tabSql, error, setChatOpen, setPendingChatMessage]);

  const colDefs = useMemo<ColDef[]>(
    () => (result?.columns ?? []).map((c) => ({ field: c, headerName: c })),
    [result]
  );
  const rowData = useMemo(
    () =>
      (result?.rows ?? []).map((row) =>
        Object.fromEntries((result?.columns ?? []).map((c, i) => [c, row[i]]))
      ),
    [result]
  );

  return (
    <>
    <SaveDialog state={saveDialog} onCancel={() => setSaveDialog(null)} />
    <PanelGroup direction="vertical" className="h-full min-h-0">
      {/* Editor */}
      <Panel defaultSize={45} minSize={15} className="flex flex-col min-h-0">
        {/* Tab strip */}
        <div className="flex items-stretch h-9 shrink-0 bg-[#17171a] border-b border-[#2c2c33] overflow-x-auto">
          {tabs.map((t) => {
            const isActive = t.id === activeTabId;
            return (
              <div
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                title={t.title}
                className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-[#2c2c33] whitespace-nowrap ${
                  isActive
                    ? "bg-[#1f1f24] text-[#e2e2e8]"
                    : "text-[#8a8a92] hover:bg-[#1d1d22]"
                }`}
              >
                <span className="max-w-[140px] truncate">{t.title}</span>
                {t.id !== DEFAULT_TAB_ID && (
                  <button
                    className="opacity-60 group-hover:opacity-100 text-[#8a8a92] hover:text-white leading-none"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                    title="Close tab"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <button
            className="px-2.5 text-[#8a8a92] hover:text-white hover:bg-[#1d1d22]"
            onClick={() => openTab("Untitled", "", false)}
            title="New tab"
          >
            +
          </button>
        </div>
        <div className="flex items-center gap-2 px-3 h-9 shrink-0 bg-[#1f1f24] border-b border-[#2c2c33]">
          <span className="text-xs text-[#8a8a92]">{"</> Query"}</span>
          <div className="flex-1" />
          <button
            className={`px-2.5 py-1 rounded text-xs flex items-center gap-1.5 transition-colors ${
              writeMode
                ? "bg-[#e0564e] text-white hover:bg-[#e8665e]"
                : "text-[#8a8a92] hover:bg-[#26262d]"
            }`}
            onClick={() => setWriteMode(!writeMode)}
            title={
              writeMode
                ? "Write mode is ON — statements can modify data. Click to return to read-only."
                : "Read-only. Click to enable write mode (INSERT/UPDATE/DELETE/DDL)."
            }
          >
            {writeMode ? <PenLine size={13} /> : <Lock size={13} />}
            {writeMode ? "Write mode" : "Read-only"}
          </button>
          <button
            className="px-2.5 py-1 rounded text-xs flex items-center gap-1.5 hover:bg-[#26262d] transition-colors"
            style={{ color: savedFlash ? "#34d399" : isDirty ? "#a0a0a8" : "#52a06a" }}
            title={savedFlash ? "Saved" : isDirty ? "Save query (⌘/Ctrl+S)" : "Saved — no changes"}
            onClick={async () => {
              const sqlText = tabSql.trim();
              if (!sqlText) return;
              const savedPath = activeTab.key?.startsWith("saved:") ? activeTab.key.slice(6) : null;
              if (savedPath) {
                if (!isDirty) { flashSaved(); return; }
                const segments = savedPath.split("/");
                const name = segments[segments.length - 1].replace(/\.sql$/, "");
                const folderId = segments.length > 1 ? segments.slice(0, -1).join("/") : null;
                try {
                  await api.updateQuery(savedPath, name, sqlText, activeConnectionId, folderId);
                  log("info", `saved "${name}"`);
                  markSaved(activeTabId, sqlText);
                  qc.invalidateQueries({ queryKey: ["queries"] });
                } finally {
                  flashSaved();
                }
              } else {
                // New file — ask for a name via custom dialog
                const defaultName = activeTab.title !== "Untitled" ? activeTab.title : "";
                setSaveDialog({
                  defaultName,
                  onSave: async (name: string) => {
                    setSaveDialog(null);
                    const result = await api.saveQuery(name, sqlText, activeConnectionId);
                    updateTab(activeTabId, { title: name, key: `saved:${result.id}` });
                    markSaved(activeTabId, sqlText);
                    log("info", `saved query "${name}"`);
                    qc.invalidateQueries({ queryKey: ["queries"] });
                    flashSaved();
                  },
                });
              }
            }}
          >
            {savedFlash ? <Check size={13} /> : <Save size={13} />}
            {savedFlash ? "Saved" : isDirty ? (activeTab.key?.startsWith("saved:") ? "Save" : "Save…") : "Saved"}
          </button>
          {running ? (
            <button
              className="px-2.5 py-1 rounded text-xs flex items-center gap-1.5 bg-[#3a1a1a] hover:bg-[#4a2020] text-[#e06a6a] transition-colors"
              onClick={() => activeConnectionId && api.cancelQuery(activeConnectionId)}
              title="Stop query (pg_cancel_backend)"
            >
              <SquareIcon size={12} /> Stop
            </button>
          ) : (
            <button
              className={`px-2.5 py-1 rounded text-xs flex items-center gap-1.5 disabled:opacity-40 transition-colors ${
                writeMode
                  ? "bg-[#e0564e] text-white hover:bg-[#e8665e]"
                  : "hover:bg-[#26262d] text-[#5b9bd8]"
              }`}
              onClick={() => run()}
              disabled={params.some(n => !(paramValues[n] ?? "").trim())}
              title={
                params.some(n => !(paramValues[n] ?? "").trim())
                  ? "Fill in all parameters to run"
                  : !activeConnectionId
                  ? "Not connected — running will prompt you to connect"
                  : writeMode
                  ? "Run against the write pool (⌘/Ctrl+Enter)"
                  : "Run query (⌘/Ctrl+Enter)"
              }
            >
              <Play size={13} /> {writeMode ? "Run write" : "Run"}
            </button>
          )}
          <button
            className={`px-2.5 py-1 rounded text-xs flex items-center gap-1.5 transition-colors ${chatOpen ? "bg-[#2a1a3e] text-[#c9a3e0]" : "text-[#a98fc0] hover:bg-[#26262d] hover:text-[#c9a3e0]"}`}
            onClick={() => setChatOpen(!chatOpen)}
            title={chatOpen ? "Close agent" : "Open agent"}
          >
            <BotMessageSquare size={13} /> Agent
          </button>
        </div>
        {/* Unmistakable banner so it's never a surprise that a Run can mutate data. */}
        {writeMode && (
          <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 bg-[#3a1512] border-b border-[#e0564e]/40 text-[11px] text-[#f0a29c]">
            <TriangleAlert size={13} className="text-[#e0564e] shrink-0" />
            <span>
              <span className="font-semibold text-[#f5b8b2]">Write mode.</span>{" "}
              Statements run on the write pool and can modify or drop data. The agent stays read-only.
            </span>
          </div>
        )}
        {/* Named parameter inputs — shown when the SQL contains :param_name tokens */}
        {params.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 bg-[#17171a] border-b border-[#2c2c33]">
            {params.map(name => (
              <label key={name} className="flex items-center gap-1.5">
                <span className="text-[11px] font-mono text-[#6aa3e8]">:{name}</span>
                <input
                  type="text"
                  value={paramValues[name] ?? ""}
                  onChange={e => setParamValues(v => ({ ...v, [name]: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter") run(); }}
                  className="bg-[#161619] border border-[#3a3a42] rounded px-2 py-0.5 text-xs w-32 outline-none focus:border-[#3b6fb5] font-mono"
                  placeholder="value"
                />
              </label>
            ))}
          </div>
        )}
        <div className={`flex-1 min-h-0 overflow-auto ${writeMode ? "ring-1 ring-inset ring-[#e0564e]/50" : ""}`}>
          <CodeMirror
            value={tabSql}
            onChange={setTabSql}
            onCreateEditor={(view) => { editorViewRef.current = view; }}
            extensions={extensions}
            theme={oneDark}
            height="100%"
            style={{ height: "100%", fontSize: 13 }}
          />
        </div>
      </Panel>

      <PanelResizeHandle className="h-[3px] bg-[#2c2c33] hover:bg-[#3b6fb5] data-[resize-handle-state=drag]:bg-[#3b6fb5] transition-colors" />

      {/* Results */}
      <Panel defaultSize={55} minSize={15} className="flex flex-col min-h-0">
        {/* Results tab strip */}
        <div className="flex items-center bg-[#1f1f24] border-b border-[#2c2c33]">
          <button
            className={`px-3 py-1.5 text-xs border-r border-[#2c2c33] transition-colors flex items-center gap-1.5 ${
              resultView === "data"
                ? "text-[#e2e2e8] bg-[#161619]"
                : "text-[#8a8a92] hover:bg-[#1d1d22]"
            }`}
            onClick={() => setResultView("data")}
          >
            <AlignJustify size={13} /> Results
          </button>
          {tableKey && (
            <button
              className={`px-3 py-1.5 text-xs border-r border-[#2c2c33] transition-colors flex items-center gap-1.5 ${
                resultView === "structure"
                  ? "text-[#e2e2e8] bg-[#161619]"
                  : "text-[#8a8a92] hover:bg-[#1d1d22]"
              }`}
              onClick={() => setResultView("structure")}
            >
              <LayoutGrid size={13} /> Structure
            </button>
          )}
          {result && result.columns.length > 0 && !isExplainResult && (
            <button
              className={`px-3 py-1.5 text-xs border-r border-[#2c2c33] transition-colors flex items-center gap-1.5 ${
                resultView === "chart"
                  ? "text-[#e2e2e8] bg-[#161619]"
                  : "text-[#8a8a92] hover:bg-[#1d1d22]"
              }`}
              onClick={() => setResultView("chart")}
            >
              <ChartSpline size={13} /> Chart
            </button>
          )}
          <div className="flex-1" />
          {resultView === "data" && (
            <>
              <span className="text-[11px] text-[#6a6a72] px-2 font-mono">
                {running ? `${(elapsedMs / 1000).toFixed(1)}s` : status}
              </span>
              {result?.truncated && !running && (
                <button
                  className="px-2 py-1.5 text-xs text-[#5b9bd8] hover:bg-[#26262d] border-l border-[#2c2c33] flex items-center gap-1.5 transition-colors"
                  onClick={() => run(true)}
                  title="Re-run this query and fetch every row (no preview cap)"
                >
                  <ArrowDownToLine size={13} /> Load all rows
                </button>
              )}
              {error && error !== NOT_CONNECTED ? (
                <button
                  className="px-2 py-1.5 text-xs text-[#ae84cb] hover:bg-[#2a1a3e] border-l border-[#2c2c33] flex items-center gap-1.5 transition-colors"
                  onClick={debugWithAI}
                  title="Ask the agent why this query failed"
                >
                  <BugPlay size={13} /> Debug with AI
                </button>
              ) : isExplainResult ? (
                <button
                  className="px-2 py-1.5 text-xs text-[#ae84cb] hover:bg-[#2a1a3e] border-l border-[#2c2c33] flex items-center gap-1.5 transition-colors"
                  onClick={explainWithAI}
                  title="Explain query plan with AI"
                >
                  <BotMessageSquare size={13} /> Explain with AI
                </button>
              ) : (
                <button
                  className="px-2 py-1.5 text-xs text-[#a0a0a8] hover:bg-[#26262d] disabled:opacity-40 disabled:hover:bg-transparent border-l border-[#2c2c33] flex items-center gap-1.5"
                  onClick={exportCsv}
                  disabled={!result || result.columns.length === 0}
                  title="Export results as CSV"
                >
                  <Download size={13} /> CSV
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex-1 min-h-0 relative">
          {resultView === "chart" && result && result.columns.length > 0 ? (
            <ChartView result={result} />
          ) : resultView === "structure" && tableSchema && tableName && activeConnectionId ? (
            <StructureView
              connectionId={activeConnectionId}
              schema={tableSchema}
              table={tableName}
            />
          ) : error === NOT_CONNECTED ? (
            <NotConnectedNotice />
          ) : error ? (
            <pre className="text-red-400 text-xs whitespace-pre-wrap p-3">{error}</pre>
          ) : isExplainResult ? (
            <ExplainResultView rows={result!.rows} />
          ) : result && result.columns.length > 0 ? (
            <AgGridReact
              theme={gridTheme}
              columnDefs={colDefs}
              rowData={rowData}
              enableCellTextSelection
              ensureDomOrder
              defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 90 }}
              pagination
              paginationPageSize={100}
              paginationPageSizeSelector={[20, 50, 100, 500, 1000]}
            />
          ) : result && result.columns.length === 0 ? (
            // A statement that returns no rows (INSERT/UPDATE/DELETE/DDL). Show
            // the server's command tag ("UPDATE 5") so a successful write isn't
            // mistaken for "nothing happened".
            <div className="flex items-start gap-2 p-4 text-sm">
              <Check size={15} className="text-[#52a06a] mt-px shrink-0" />
              <span className="text-[#c8c8d0] font-mono">
                {result.notice ?? "Statement executed."}
                <span className="text-[#6a6a72]"> · {result.durationMs} ms</span>
              </span>
            </div>
          ) : !activeConnectionId ? (
            <NotConnectedNotice />
          ) : (
            <div className="text-[#6a6a72] text-sm p-3">
              {running ? "" : "Run a query, or click a table to preview it."}
            </div>
          )}
          {running && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#161619]/70 z-10">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 rounded-full border-2 border-[#2c2c33] border-t-[#3b6fb5] animate-spin" />
                <span className="text-[12px] text-[#6a6a72] font-mono">{(elapsedMs / 1000).toFixed(1)}s</span>
              </div>
            </div>
          )}
        </div>
      </Panel>
    </PanelGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// EXPLAIN output renderer
// ---------------------------------------------------------------------------


function ExplainNodeView({ node, collapsed, onToggle }: {
  node: ExplainNode;
  collapsed: Set<number>;
  onToggle: (id: number) => void;
}) {
  const isCollapsed = collapsed.has(node.id);
  const hasChildren = node.children.length > 0;
  const isNode = node.arrowPos !== null; // root (-1) or -> line; null = attribute
  const seqScan = isNode && isLargeSeqScan(node.line);
  const { name, stats } = isNode ? splitNodeLine(node.line) : { name: node.line, stats: "" };

  return (
    <>
      <div className={`group flex items-start hover:bg-[#1d1d22] ${seqScan ? "border-l-2 border-red-500/70" : ""}`}>
        {hasChildren ? (
          <button
            className="w-4 shrink-0 text-center text-[9px] py-px text-[#3a3a42] group-hover:text-[#6a6a72] hover:!text-[#c8c8d0] leading-[1.65]"
            onClick={() => onToggle(node.id)}
          >
            {isCollapsed ? "▶" : "▼"}
          </button>
        ) : (
          <div className="w-4 shrink-0" />
        )}
        <span className="whitespace-pre py-px pr-3">
          {isNode ? (
            <>
              <span className={`font-semibold ${seqScan ? "text-red-400" : ""}`}>{name}</span>
              {stats && <span className="text-[#6a6a72]">{stats}</span>}
            </>
          ) : (
            // Attribute lines (Index Cond:, Filter:, Sort Key:, …) are secondary
            <span className="text-[#6a6a72]">{name}</span>
          )}
        </span>
      </div>
      {!isCollapsed && node.children.map((child) => (
        <ExplainNodeView key={child.id} node={child} collapsed={collapsed} onToggle={onToggle} />
      ))}
    </>
  );
}

function ExplainResultView({ rows }: { rows: unknown[][] }) {
  const tree = useMemo(() => parseExplainTree(rows), [rows]);
  const [collapsed, setCollapsed] = useState(new Set<number>());
  const onToggle = useCallback((id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  if (!tree) return null;
  return (
    <div className="h-full overflow-auto py-1 font-mono text-[12px] leading-[1.65]">
      <ExplainNodeView node={tree} collapsed={collapsed} onToggle={onToggle} />
    </div>
  );
}

function NotConnectedNotice() {
  const setPage = useStore((s) => s.setPage);
  return (
    <div className="text-sm text-[#a0a0a8] p-3">
      Not connected to any data source.{" "}
      <button
        className="text-[#6aa3e8] hover:underline"
        onClick={() => setPage("connections")}
      >
        Connect here
      </button>
    </div>
  );
}

function SaveDialog({
  state,
  onCancel,
}: {
  state: { defaultName: string; onSave: (name: string) => void } | null;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");

  // Seed the field from the default name each time the dialog (re)opens with a
  // new state object — adjusted during render rather than in an effect.
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (state) setName(state.defaultName);
  }

  if (!state) return null;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    state.onSave(trimmed);
  };

  return (
    <Modal
      title="Save query as"
      onClose={onCancel}
      footer={
        <>
          <button
            className="px-3 py-1.5 rounded text-xs text-[#8a8a92] hover:bg-[#2c2c33] hover:text-white"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 rounded text-xs bg-[#3b6fb5] hover:bg-[#4a7fc5] text-white disabled:opacity-40"
            disabled={!name.trim()}
            onClick={submit}
          >
            Save
          </button>
        </>
      }
    >
      <input
        autoFocus
        className="w-full bg-[#131316] border border-[#2c2c33] rounded px-2.5 py-1.5 text-sm text-[#c8c8d0] outline-none focus:border-[#3b6fb5] mb-4"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Query name"
      />
    </Modal>
  );
}
