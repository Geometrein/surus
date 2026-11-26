import { useEffect, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { useQuery } from "@tanstack/react-query";
import { Settings, Logs, MessageSquare } from "lucide-react";
import { useStore, type Page } from "./store";
import { api } from "./api/client";
import { shortVersion, QUERY_LOG_POLL_MS } from "./utils";
import { Sidebar, ConnectionsSidebar, LogsSidebar } from "./components/Sidebar";
import { EditorResults } from "./components/EditorResults";
import { StatsPage } from "./components/StatsPage";
import { LogsPage } from "./components/LogsPage";
import { SchemaDiagramPage, SchemaDiagramSidebar } from "./components/SchemaDiagramPage";
import { SettingsPage, SettingsSidebar } from "./components/SettingsPage";
import { ChatPanel } from "./components/ChatPanel";
import { AskPage } from "./components/AskPage";
import { useAiEnabled } from "./hooks/useAiEnabled";

function useQueryLogPoller() {
  const ingest = useStore((s) => s.ingestQueryLogs);
  useQuery({
    queryKey: ["query-logs"],
    queryFn: async () => {
      const after = useStore.getState().queryLogSeq;
      const res = await api.queryLogsSince(after);
      if (res.entries.length) ingest(res.entries);
      return res.lastSeq;
    },
    refetchInterval: QUERY_LOG_POLL_MS,
    refetchOnWindowFocus: false,
  });
}

export function App() {
  const page = useStore((s) => s.page);
  useQueryLogPoller();

  const chatPanelRef = useRef<ImperativePanelHandle>(null);
  const chatOpen = useStore((s) => s.chatOpen);
  const setChatOpen = useStore((s) => s.setChatOpen);
  const setPage = useStore((s) => s.setPage);
  const aiEnabled = useAiEnabled();

  // Turning AI off while on the Ask page would leave an empty screen.
  useEffect(() => {
    if (!aiEnabled && page === "ask") setPage("editor");
  }, [aiEnabled, page, setPage]);

  // Keep the panel in sync when chatOpen is toggled elsewhere (e.g. the
  // EditorResults toolbar). Imperative expand/collapse only — the panel's own
  // onCollapse/onExpand callbacks drive chatOpen the other direction, and
  // calling expand()/collapse() when already in that state is a no-op.
  //
  // With AI off the panel stays in the layout, collapsed to nothing: removing it
  // would make the panel library rebuild every width from its defaults.
  useEffect(() => {
    if (aiEnabled && chatOpen) chatPanelRef.current?.expand();
    else chatPanelRef.current?.collapse();
  }, [chatOpen, aiEnabled]);

  return (
    <div className="h-screen flex flex-col bg-app text-strong">
      <header className="h-12 shrink-0 flex items-center bg-raised border-b border-line">
        <div className="w-10 shrink-0 flex items-center justify-center">
          <img src="/surus_logo.png" alt="Surus" className="h-7 w-7 rounded" />
        </div>
        <span className="pl-2 text-lg font-semibold tracking-tight">Surus</span>
      </header>

      <div className="flex flex-1 min-h-0">
        <ActivityBar page={page} />

        {/* ── Editor ── always mounted so panel sizes survive page switches */}
        <div className={`flex-1 min-w-0 min-h-0 ${page === "editor" ? "flex" : "hidden"}`}>
          <PanelGroup direction="horizontal" className="flex-1 min-w-0 min-h-0">
            <Panel id="editor-sidebar" order={1} defaultSize={22} minSize={14} maxSize={40}>
              <Sidebar />
            </Panel>
            <HResize />
            <Panel id="editor-main" order={2} defaultSize={52} minSize={30} className="flex flex-col min-w-0">
              <EditorResults />
            </Panel>
            <HResize hidden={!aiEnabled} />
            <Panel
              id="editor-chat"
              order={3}
              ref={chatPanelRef}
              defaultSize={26}
              minSize={16}
              maxSize={46}
              collapsible
              // Collapsing because AI was turned off is not the user closing the
              // agent, so it must not change whether it reopens later.
              onCollapse={() => aiEnabled && setChatOpen(false)}
              onExpand={() => setChatOpen(true)}
            >
              {aiEnabled && <ChatPanel onCollapse={() => chatPanelRef.current?.collapse()} />}
            </Panel>
          </PanelGroup>
        </div>

        {/* ── Ask ── sidebar = chat history, central = chat with the database */}
        {page === "ask" && aiEnabled && <AskPage />}

        {/* ── Connections ── sidebar = list, central = stats */}
        {page === "connections" && (
          <PanelGroup direction="horizontal" className="flex-1 min-w-0 min-h-0">
            <Panel defaultSize={22} minSize={14} maxSize={40}>
              <ConnectionsSidebar />
            </Panel>
            <HResize />
            <Panel defaultSize={78} minSize={40} className="flex flex-col min-w-0">
              <StatsPage />
            </Panel>
          </PanelGroup>
        )}

        {/* ── Schema diagram ── sidebar = filters, central = ER diagram */}
        {page === "schema" && (
          <PanelGroup direction="horizontal" className="flex-1 min-w-0 min-h-0">
            <Panel defaultSize={22} minSize={14} maxSize={40}>
              <SchemaDiagramSidebar />
            </Panel>
            <HResize />
            <Panel defaultSize={78} minSize={40} className="flex flex-col min-w-0">
              <SchemaDiagramPage />
            </Panel>
          </PanelGroup>
        )}

        {/* ── Logs ── sidebar = filters, central = log stream */}
        {page === "logs" && (
          <PanelGroup direction="horizontal" className="flex-1 min-w-0 min-h-0">
            <Panel defaultSize={22} minSize={14} maxSize={40}>
              <LogsSidebar />
            </Panel>
            <HResize />
            <Panel defaultSize={78} minSize={40} className="flex flex-col min-w-0">
              <LogsPage />
            </Panel>
          </PanelGroup>
        )}

        {/* ── Settings ── sidebar = categories, central = settings form */}
        {page === "settings" && (
          <PanelGroup direction="horizontal" className="flex-1 min-w-0 min-h-0">
            <Panel defaultSize={22} minSize={14} maxSize={40}>
              <SettingsSidebar />
            </Panel>
            <HResize />
            <Panel defaultSize={78} minSize={40} className="flex flex-col min-w-0">
              <SettingsPage />
            </Panel>
          </PanelGroup>
        )}
      </div>

      <StatusBar />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity bar
// ---------------------------------------------------------------------------

function ActivityBar({ page }: { page: Page }) {
  const aiEnabled = useAiEnabled();
  return (
    <nav className="w-10 shrink-0 flex flex-col items-center py-1 bg-raised border-r border-line">
      <ActivityTab active={page === "connections"} page="connections" title="Connections">
        <IconConnections />
      </ActivityTab>
      <ActivityTab active={page === "schema"} page="schema" title="Schema Diagram">
        <IconSchema />
      </ActivityTab>
      <ActivityTab active={page === "editor"} page="editor" title="Editor">
        <IconEditor />
      </ActivityTab>
      {aiEnabled && (
        <ActivityTab active={page === "ask"} page="ask" title="Ask your data">
          <MessageSquare size={20} strokeWidth={1.5} />
        </ActivityTab>
      )}
      <div className="mt-auto w-full">
        <ActivityTab active={page === "logs"} page="logs" title="Logs">
          <IconLogs />
        </ActivityTab>
        <ActivityTab active={page === "settings"} page="settings" title="Settings">
          <IconSettings />
        </ActivityTab>
      </div>
    </nav>
  );
}

function ActivityTab({ active, page, title, children }: {
  active: boolean; page: Page; title: string; children: ReactNode;
}) {
  const setPage = useStore((s) => s.setPage);
  return (
    <button
      onClick={() => setPage(page)}
      className={`group relative w-full flex items-center justify-center h-11 transition-colors ${
        active ? "text-white" : "text-muted hover:text-soft hover:bg-raised-hover"
      }`}
    >
      {active && (
        <span className="absolute left-0 top-[10px] bottom-[10px] w-[2px] rounded-r bg-accent" />
      )}
      {children}
      <span className="pointer-events-none absolute left-full ml-2 px-2 py-1 rounded bg-line border border-line-strong text-strong text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity delay-300 z-50 shadow-lg">
        {title}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function IconConnections() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="10" cy="6" rx="6" ry="2.5" />
      <path d="M4 6v8c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V6" />
      <path d="M4 10c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5" />
    </svg>
  );
}

function IconEditor() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 6L3 10l4 4" />
      <path d="M13 6l4 4-4 4" />
      <path d="M11.5 4l-3 12" />
    </svg>
  );
}

function IconSchema() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="6" height="5" rx="1" />
      <rect x="11.5" y="12.5" width="6" height="5" rx="1" />
      <rect x="11.5" y="3" width="5" height="4" rx="1" />
      <path d="M5.5 7.5v3.5h6" />
      <path d="M14 7v5.5" />
    </svg>
  );
}

function IconLogs() {
  return <Logs size={20} strokeWidth={1.5} />;
}

function IconSettings() {
  return <Settings size={20} strokeWidth={1.5} />;
}

// ---------------------------------------------------------------------------
// Status bar (footer)
// ---------------------------------------------------------------------------

function StatusBar() {
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const serverVersion = useStore((s) => s.serverVersion);
  const setPage = useStore((s) => s.setPage);
  const setStatsConnection = useStore((s) => s.setStatsConnection);
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const active = conns.data?.find((c) => c.id === activeConnectionId) ?? null;

  return (
    <footer className={`h-6 shrink-0 flex items-center text-[11px] select-none border-t border-line transition-colors ${active ? "bg-emerald-900/40" : "bg-red-900/40"}`}>
      {active ? (
        <button
          className="flex-1 h-full flex items-center gap-2 px-3 hover:bg-emerald-900/30 text-emerald-400 transition-colors"
          onClick={() => { setStatsConnection(active.id); setPage("connections"); }}
          title="View connection stats"
        >
          {/* Always green — this signals "connected", not the connection's accent color. */}
          <span className="h-2 w-2 rounded-full shrink-0 bg-emerald-500" />
          <span className="font-medium">{active.name}</span>
          <span className="text-emerald-600/80">·</span>
          <span className="text-emerald-500/70 font-mono">{active.host}:{active.port}/{active.dbname}</span>
          <div className="flex-1" />
          {serverVersion && (
            <span className="text-emerald-700/80 font-mono">{shortVersion(serverVersion)}</span>
          )}
        </button>
      ) : (
        <>
          <button
            className="h-full flex items-center gap-2 px-3 text-red-300/90 hover:text-red-200 hover:bg-red-900/30 transition-colors"
            onClick={() => setPage("connections")}
            title="Go to connections"
          >
            <span className="h-2 w-2 rounded-full shrink-0 bg-red-500" />
            <span className="font-medium">Not connected</span>
          </button>
          <div className="flex-1" />
          {serverVersion && (
            <span className="px-3 text-faint font-mono">{shortVersion(serverVersion)}</span>
          )}
        </>
      )}
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function HResize({ hidden = false }: { hidden?: boolean }) {
  return (
    <PanelResizeHandle
      disabled={hidden}
      className={hidden ? "hidden" : "w-[3px] bg-line hover:bg-accent data-[resize-handle-state=drag]:bg-accent transition-colors"}
    />
  );
}
