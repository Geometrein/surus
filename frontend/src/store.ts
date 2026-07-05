import { create } from "zustand";
import type { QueryLogEntry } from "./api/client";

export type Page = "editor" | "connections" | "schema" | "logs" | "settings";
export type LogSource = "user" | "agent" | "system";

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  source: LogSource;
  msg: string;
  durationMs?: number;
}

export interface EditorTab {
  id: string;
  title: string;
  sql: string;
  key?: string;
}

export const DEFAULT_TAB_ID = "default";

let tabSeq = 0;
const newTabId = () => `tab-${Date.now()}-${tabSeq++}`;

interface AppState {
  activeConnectionId: string | null;
  serverVersion: string | null;
  statsConnectionId: string | null;
  settingsCategory: string;
  page: Page;
  tabs: EditorTab[];
  activeTabId: string;
  runSignal: number;
  logs: LogEntry[];
  queryLogSeq: number;
  // Log page filters
  logFilterSources: LogSource[];   // empty = all sources
  logFilterLevels: LogEntry["level"][];  // empty = all levels
  logSearch: string;
  // Schema diagram filters
  diagramSearch: string;
  diagramHiddenSchemas: string[];   // schemas the user has hidden from the diagram
  diagramShowColumns: boolean;
  diagramOnlyRelated: boolean;      // hide tables with no FK relationships
  diagramShowSizes: boolean;        // fetch + show on-disk table sizes (opt-in; expensive)
  chatOpen: boolean;
  pendingChatMessage: string | null;
  // Editor write mode: routes editor queries to the write pool. Off by default
  // and never persisted — every reload and connection switch starts read-only,
  // so write access is always a deliberate, in-session opt-in.
  writeMode: boolean;

  setActiveConnection: (id: string | null, version?: string | null) => void;
  setStatsConnection: (id: string | null) => void;
  setSettingsCategory: (c: string) => void;
  setPage: (p: Page) => void;
  setTabSql: (sql: string) => void;
  setActiveTab: (id: string) => void;
  openTab: (title: string, sql: string, run?: boolean, key?: string) => void;
  updateTab: (id: string, updates: Partial<Pick<EditorTab, "title" | "key">>) => void;
  closeTab: (id: string) => void;
  log: (level: LogEntry["level"], msg: string, source?: LogSource) => void;
  ingestQueryLogs: (entries: QueryLogEntry[]) => void;
  clearLogs: () => void;
  setLogFilterSources: (s: LogSource[]) => void;
  setLogFilterLevels: (l: LogEntry["level"][]) => void;
  setLogSearch: (s: string) => void;
  setDiagramSearch: (s: string) => void;
  setDiagramHiddenSchemas: (s: string[]) => void;
  setDiagramShowColumns: (v: boolean) => void;
  setDiagramOnlyRelated: (v: boolean) => void;
  setDiagramShowSizes: (v: boolean) => void;
  setChatOpen: (open: boolean) => void;
  setPendingChatMessage: (msg: string | null) => void;
  setWriteMode: (v: boolean) => void;
}

// Persisted schema-diagram preferences. Every localStorage access is wrapped:
// it can throw when storage is unavailable (tests without a DOM, private mode,
// disabled storage), and a missing value must fall back to its default rather
// than break the store. View toggles are global; hidden schemas are per
// connection (mirrors the editor's Tables panel).
const DIAGRAM_COLUMNS_KEY = "surus:diagram-columns";
const DIAGRAM_ONLY_RELATED_KEY = "surus:diagram-only-related";
const DIAGRAM_SIZES_KEY = "surus:diagram-sizes";

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

function saveBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch { /* ignore */ }
}

function diagramHiddenKey(connectionId: string | null): string {
  return `surus:diagram-hidden-schemas:${connectionId ?? "none"}`;
}

function loadDiagramHidden(connectionId: string | null): string[] {
  try {
    const raw = localStorage.getItem(diagramHiddenKey(connectionId));
    if (raw) return JSON.parse(raw) as string[];
  } catch { /* ignore */ }
  return [];
}

function saveDiagramHidden(connectionId: string | null, schemas: string[]): void {
  try {
    localStorage.setItem(diagramHiddenKey(connectionId), JSON.stringify(schemas));
  } catch { /* ignore */ }
}

export const useStore = create<AppState>((set, get) => ({
  activeConnectionId: null,
  serverVersion: null,
  statsConnectionId: null,
  settingsCategory: "agent",
  page: "connections",
  tabs: [{ id: DEFAULT_TAB_ID, title: "Console", sql: "SELECT 1;" }],
  activeTabId: DEFAULT_TAB_ID,
  runSignal: 0,
  logs: [],
  queryLogSeq: 0,
  logFilterSources: [],
  logFilterLevels: [],
  logSearch: "",
  diagramSearch: "",
  diagramHiddenSchemas: loadDiagramHidden(null),
  diagramShowColumns: loadBool(DIAGRAM_COLUMNS_KEY, true),
  diagramOnlyRelated: loadBool(DIAGRAM_ONLY_RELATED_KEY, false),
  diagramShowSizes: loadBool(DIAGRAM_SIZES_KEY, false),
  chatOpen: true,
  pendingChatMessage: null,
  writeMode: false,

  setActiveConnection: (id, version = null) =>
    // Reload this connection's persisted hidden-schema filter as we switch, and
    // drop back to read-only so write mode never silently carries to another DB.
    set({
      activeConnectionId: id,
      serverVersion: version,
      diagramHiddenSchemas: loadDiagramHidden(id),
      writeMode: false,
    }),
  setStatsConnection: (id) => set({ statsConnectionId: id }),
  setSettingsCategory: (settingsCategory) => set({ settingsCategory }),
  setPage: (page) => set({ page }),

  setTabSql: (sql) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, sql } : t)),
    })),
  setActiveTab: (activeTabId) => set({ activeTabId }),
  openTab: (title, sql, run = false, key) =>
    set((s) => {
      const existing = key ? s.tabs.find((t) => t.key === key) : undefined;
      if (existing) return { activeTabId: existing.id, page: "editor" };
      const id = newTabId();
      return {
        tabs: [...s.tabs, { id, title, sql, key }],
        activeTabId: id,
        page: "editor",
        runSignal: run ? s.runSignal + 1 : s.runSignal,
      };
    }),
  updateTab: (id, updates) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)) })),
  closeTab: (id) =>
    set((s) => {
      if (id === DEFAULT_TAB_ID) return s;
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id ? (tabs[idx - 1] ?? tabs[idx] ?? tabs[0]).id : s.activeTabId;
      return { tabs, activeTabId };
    }),
  log: (level, msg, source = "user") =>
    set((s) => ({
      logs: [
        ...s.logs.slice(-499),
        { ts: new Date().toLocaleTimeString(), level, source, msg },
      ],
    })),
  ingestQueryLogs: (entries) =>
    set((s) => {
      const fresh = entries.filter((e) => e.seq > s.queryLogSeq);
      if (fresh.length === 0) return s;
      const mapped: LogEntry[] = fresh.map((e) => ({
        ts: new Date(e.ts * 1000).toLocaleTimeString(),
        level: e.error ? "error" : "info",
        source: e.source,
        durationMs: e.durationMs,
        msg:
          `${e.pool ? `[${e.pool}] ` : ""}` +
          `${e.rowCount != null ? `${e.rowCount} rows · ` : ""}` +
          `${e.error ? `${e.error} · ` : ""}` +
          `${e.sql ?? ""}`,
      }));
      const queryLogSeq = fresh.reduce((m, e) => Math.max(m, e.seq), s.queryLogSeq);
      return { logs: [...s.logs, ...mapped].slice(-500), queryLogSeq };
    }),
  clearLogs: () => set({ logs: [] }),
  setLogFilterSources: (logFilterSources) => set({ logFilterSources }),
  setLogFilterLevels: (logFilterLevels) => set({ logFilterLevels }),
  setLogSearch: (logSearch) => set({ logSearch }),
  setDiagramSearch: (diagramSearch) => set({ diagramSearch }),
  setDiagramHiddenSchemas: (diagramHiddenSchemas) => {
    saveDiagramHidden(get().activeConnectionId, diagramHiddenSchemas);
    set({ diagramHiddenSchemas });
  },
  setDiagramShowColumns: (diagramShowColumns) => {
    saveBool(DIAGRAM_COLUMNS_KEY, diagramShowColumns);
    set({ diagramShowColumns });
  },
  setDiagramOnlyRelated: (diagramOnlyRelated) => {
    saveBool(DIAGRAM_ONLY_RELATED_KEY, diagramOnlyRelated);
    set({ diagramOnlyRelated });
  },
  setDiagramShowSizes: (diagramShowSizes) => {
    saveBool(DIAGRAM_SIZES_KEY, diagramShowSizes);
    set({ diagramShowSizes });
  },
  setChatOpen: (chatOpen) => set({ chatOpen }),
  setPendingChatMessage: (pendingChatMessage) => set({ pendingChatMessage }),
  setWriteMode: (writeMode) => set({ writeMode }),
}));
