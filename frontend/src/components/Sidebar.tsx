import React, { useState, useRef, useEffect, useMemo, type KeyboardEvent } from "react";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  Plus, ExternalLink,
  Pencil, Trash2, Folder, FolderOpen, FileCode2,
  User, Bot, Cog,
} from "lucide-react";

const SOURCE_ICONS: Record<string, React.ElementType> = { user: User, agent: Bot, system: Cog };
import { api, type Connection, type SavedQuery, type QueryFolder } from "../api/client";
import { useStore } from "../store";
import { SchemaExplorer } from "./SchemaExplorer";
import { ConnectionDialog } from "./ConnectionDialog";
import { Modal } from "./Modal";
import { SidebarPanel, SidebarHeader } from "./SidebarPanel";
import { SearchInput } from "./SearchInput";
import { ToggleSwitch } from "./ToggleSwitch";
import {
  SOURCE_LABELS, FILE_TREE_POLL_MS, type LogSource,
  ALL_ACTIVITY_KINDS, ACTIVITY_LABELS, ACTIVITY_BADGE, type ActivityKind,
} from "../utils";

// ---------------------------------------------------------------------------
// Editor sidebar — queries + schema tree
// ---------------------------------------------------------------------------

export function Sidebar() {
  const [refreshing, setRefreshing] = useState(false);
  const { activeConnectionId, log } = useStore();
  const qc = useQueryClient();

  async function refreshSchema() {
    if (!activeConnectionId || refreshing) return;
    setRefreshing(true);
    try {
      await api.refreshSchema(activeConnectionId);
      await qc.invalidateQueries({ queryKey: ["schema", activeConnectionId] });
      log("info", "refreshed schema");
    } catch (e) {
      log("error", `schema refresh failed: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <SidebarPanel>
      <PanelGroup direction="vertical" className="flex-1 min-h-0">
        <Panel defaultSize={45} minSize={15}>
          <QueriesPanel />
        </Panel>
        <PanelResizeHandle className="h-[3px] bg-[#2c2c33] hover:bg-[#3d3d50] active:bg-[#5a5a80] cursor-row-resize transition-colors" />
        <Panel defaultSize={55} minSize={15}>
          <TablesPanel refreshing={refreshing} onRefresh={refreshSchema} />
        </Panel>
      </PanelGroup>
    </SidebarPanel>
  );
}

// ---------------------------------------------------------------------------
// Connections sidebar — list of connections, clicking selects for stats
// ---------------------------------------------------------------------------

export function ConnectionsSidebar() {
  const { activeConnectionId, statsConnectionId, setActiveConnection, setStatsConnection, log } = useStore();
  const [dialog, setDialog] = useState<{ open: boolean; edit?: Connection }>({ open: false });
  const [search, setSearch] = useState("");
  const { confirmState, confirm, clearConfirm } = useConfirm();
  const qc = useQueryClient();

  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });

  const term = search.trim().toLowerCase();
  const visible = (conns.data ?? []).filter(
    (c) =>
      !term ||
      c.name.toLowerCase().includes(term) ||
      c.host.toLowerCase().includes(term) ||
      c.dbname.toLowerCase().includes(term)
  );

  const connect = useMutation({
    mutationFn: (id: string) => api.connect(id),
    onSuccess: (res, id) => {
      setActiveConnection(id, res.version);
      log("info", `connected to ${id}`);
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["schema", id] });
    },
    onError: (e: Error) => log("error", `connect failed: ${e.message}`),
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.disconnect(id),
    onSuccess: (_res, id) => {
      if (activeConnectionId === id) setActiveConnection(null);
      log("info", `disconnected from ${id}`);
      qc.invalidateQueries({ queryKey: ["connections"] });
    },
    onError: (e: Error) => log("error", `disconnect failed: ${e.message}`),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: (_r, id) => {
      if (activeConnectionId === id) setActiveConnection(null);
      qc.invalidateQueries({ queryKey: ["connections"] });
    },
  });

  return (
    <SidebarPanel>
      <SidebarHeader label="CONNECTIONS">
        <button
          className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33]"
          title="Add connection"
          onClick={() => setDialog({ open: true })}
        >
          <Plus size={14} />
        </button>
      </SidebarHeader>

      {(conns.data?.length ?? 0) > 0 && (
        <SearchInput value={search} onChange={setSearch} placeholder="Search connections…" />
      )}

      <div className="flex-1 overflow-auto min-h-0 px-1 pb-1">
        {conns.data?.length === 0 && (
          <div className="px-2 py-2 text-xs text-[#6a6a72]">No connections yet — click + to add one.</div>
        )}
        {term && visible.length === 0 && (
          <div className="px-2 py-2 text-xs text-[#6a6a72]">No connections match "{search}".</div>
        )}
        {visible.map((c) => {
          const connected = c.id === activeConnectionId;
          const selected = c.id === (statsConnectionId ?? activeConnectionId);
          const connecting = connect.isPending && connect.variables === c.id;
          const busy = connecting || (disconnect.isPending && disconnect.variables === c.id);
          return (
            <div key={c.id}>
              <div
                onClick={() => setStatsConnection(c.id)}
                className={`group flex items-stretch gap-2 px-2 py-2 rounded mt-1 cursor-pointer ${
                  selected ? "bg-[#1e3550]" : "hover:bg-[#1d1d22]"
                }`}
              >
                <span
                  className="w-1 rounded-full shrink-0"
                  style={{ backgroundColor: c.color || "transparent" }}
                />
                <div className="mt-0.5 shrink-0">
                  <ToggleSwitch
                    on={connected}
                    busy={busy}
                    onClick={() => (connected ? disconnect.mutate(c.id) : connect.mutate(c.id))}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-[13px]">{c.name}</div>
                  <div className="truncate text-[11px] text-[#6a6a72] font-mono">
                    {c.host}:{c.port}/{c.dbname}
                  </div>
                </div>
                <button
                  className="opacity-0 group-hover:opacity-100 text-[#6a6a72] hover:text-white shrink-0 mt-0.5 p-0.5 rounded"
                  title="Edit"
                  onClick={(e) => { e.stopPropagation(); setDialog({ open: true, edit: c }); }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="opacity-0 group-hover:opacity-100 text-[#6a6a72] hover:text-red-400 shrink-0 mt-0.5 p-0.5 rounded"
                  title="Delete"
                  onClick={(e) => { e.stopPropagation(); confirm(`Delete connection "${c.name}"?`, () => del.mutate(c.id)); }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {connecting && (
                <div className="mx-2 mb-1 h-[2px] rounded overflow-hidden bg-[#2c2c33]">
                  <div className="h-full w-1/3 bg-emerald-500/70 rounded animate-progress-slide" />
                </div>
              )}
              {connect.isError && connect.variables === c.id && (
                <div className="mx-2 mb-1 px-2 py-1 rounded text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 break-words">
                  {connect.error.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {dialog.open && (
        <ConnectionDialog
          edit={dialog.edit}
          onClose={() => setDialog({ open: false })}
          onSaved={() => {
            setDialog({ open: false });
            qc.invalidateQueries({ queryKey: ["connections"] });
          }}
        />
      )}
      <ConfirmDialog state={confirmState} onCancel={clearConfirm} />
    </SidebarPanel>
  );
}

// ---------------------------------------------------------------------------
// Logs sidebar — filter controls
// ---------------------------------------------------------------------------

const ALL_SOURCES: LogSource[] = ["user", "agent", "system"];
const ALL_LEVELS = ["info", "warn", "error"] as const;

// Active-chip styling per level (inactive chips share one muted outline style).
const LEVEL_CHIP_ACTIVE: Record<string, string> = {
  info:  "bg-[#1e1e24] border-[#3a3a42] text-[#c8c8d0]",
  warn:  "bg-[#2a2010] border-[#5a4020] text-amber-400",
  error: "bg-[#2a1010] border-[#5a2020] text-red-400",
};
const CHIP_INACTIVE = "border-[#2c2c33] text-[#4a4a52] hover:text-[#8a8a92] hover:border-[#3a3a42]";

export function LogsSidebar() {
  const {
    logs, logFilterSources, logFilterLevels, logFilterKinds, logSearch,
    setLogFilterSources, setLogFilterLevels, setLogFilterKinds, setLogSearch,
  } = useStore();

  const { sourceCounts, levelCounts, kindCounts, queries, slowest, avg } = useMemo(() => {
    const sc: Record<string, number> = { user: 0, agent: 0, system: 0 };
    const lc: Record<string, number> = { info: 0, warn: 0, error: 0 };
    const kc = {} as Record<ActivityKind, number>;
    let queries = 0, slowest = 0, totalDur = 0;
    for (const l of logs) {
      sc[l.source]++; lc[l.level]++; kc[l.kind] = (kc[l.kind] ?? 0) + 1;
      if (l.durationMs != null) { queries++; totalDur += l.durationMs; slowest = Math.max(slowest, l.durationMs); }
    }
    return { sourceCounts: sc, levelCounts: lc, kindCounts: kc, queries, slowest, avg: queries ? totalDur / queries : 0 };
  }, [logs]);

  function toggleSource(s: LogSource) {
    const next = logFilterSources.includes(s)
      ? logFilterSources.filter((x) => x !== s)
      : [...logFilterSources, s];
    setLogFilterSources(next);
  }

  function toggleLevel(l: (typeof ALL_LEVELS)[number]) {
    const next = logFilterLevels.includes(l)
      ? logFilterLevels.filter((x) => x !== l)
      : [...logFilterLevels, l];
    setLogFilterLevels(next);
  }

  function toggleKind(k: ActivityKind) {
    const next = logFilterKinds.includes(k)
      ? logFilterKinds.filter((x) => x !== k)
      : [...logFilterKinds, k];
    setLogFilterKinds(next);
  }

  // Only offer chips for activity kinds actually present in the current logs.
  const presentKinds = ALL_ACTIVITY_KINDS.filter((k) => (kindCounts[k] ?? 0) > 0);

  return (
    <SidebarPanel>
      <SidebarHeader label="FILTERS" />

      <SearchInput value={logSearch} onChange={setLogSearch} placeholder="Filter messages…" />

      <div className="flex-1 overflow-auto min-h-0 px-2 py-3 space-y-4">
        {/* Source — compact filter chips (multi-select; none selected = all). */}
        <div>
          <div className="text-[10px] font-semibold tracking-wider text-[#6a6a72] mb-2">SOURCE</div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_SOURCES.map((s) => {
              const active = logFilterSources.length === 0 || logFilterSources.includes(s);
              const Icon = SOURCE_ICONS[s];
              return (
                <button
                  key={s}
                  onClick={() => toggleSource(s)}
                  className={`inline-flex items-center gap-1 pl-1.5 pr-2 py-1 rounded-full border text-[11px] transition-colors ${
                    active ? "bg-[#1e3550] border-[#33557d] text-[#cfe0f5]" : CHIP_INACTIVE
                  }`}
                >
                  {Icon && <Icon size={11} className="opacity-80 shrink-0" />}
                  {SOURCE_LABELS[s]}
                  <span className={`tabular-nums text-[10px] ${active ? "text-[#8fb6e8]" : "text-[#4a4a52]"}`}>
                    {sourceCounts[s]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Activity — what kind of work each entry represents. */}
        {presentKinds.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold tracking-wider text-[#6a6a72] mb-2">ACTIVITY</div>
            <div className="flex flex-wrap gap-1.5">
              {presentKinds.map((k) => {
                const active = logFilterKinds.length === 0 || logFilterKinds.includes(k);
                return (
                  <button
                    key={k}
                    onClick={() => toggleKind(k)}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11px] transition-colors ${
                      active ? `${ACTIVITY_BADGE[k]} border-transparent` : CHIP_INACTIVE
                    }`}
                  >
                    {ACTIVITY_LABELS[k]}
                    <span className="tabular-nums text-[10px] opacity-70">{kindCounts[k]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Level */}
        <div>
          <div className="text-[10px] font-semibold tracking-wider text-[#6a6a72] mb-2">LEVEL</div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_LEVELS.map((l) => {
              const active = logFilterLevels.length === 0 || logFilterLevels.includes(l);
              return (
                <button
                  key={l}
                  onClick={() => toggleLevel(l)}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11px] transition-colors ${
                    active ? LEVEL_CHIP_ACTIVE[l] : CHIP_INACTIVE
                  }`}
                >
                  {l.toUpperCase()}
                  <span className="tabular-nums text-[10px] opacity-70">{levelCounts[l]}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Summary — at-a-glance activity, weighted toward query performance. */}
        {logs.length > 0 && (
          <div className="pt-1 border-t border-[#2c2c33]">
            <div className="text-[10px] font-semibold tracking-wider text-[#6a6a72] mb-2 mt-3">SUMMARY</div>
            <div className="space-y-1.5 text-[11px]">
              <SummaryRow label="Entries" value={logs.length.toLocaleString()} />
              <SummaryRow label="Queries" value={queries.toLocaleString()} />
              {queries > 0 && (
                <>
                  <SummaryRow label="Slowest" value={`${Math.round(slowest).toLocaleString()} ms`} />
                  <SummaryRow label="Avg query" value={`${Math.round(avg).toLocaleString()} ms`} />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </SidebarPanel>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[#6a6a72]">{label}</span>
      <span className="tabular-nums text-[#c8c8d0]">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queries panel (editor sidebar only)
// ---------------------------------------------------------------------------

function abbreviatePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

/** Invalidate both workspace query caches after any mutation. */
function invalidateWorkspace(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["folders"] });
  qc.invalidateQueries({ queryKey: ["queries"] });
}

function QueriesPanel() {
  const qc = useQueryClient();
  const { openTab } = useStore();
  const [search, setSearch] = useState("");
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  // null = creating at root, string = creating inside that folder id, undefined = not creating
  const [newFolderParentId, setNewFolderParentId] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState("");
  const [dragQueryId, setDragQueryId] = useState<string | null>(null);
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const { confirmState, confirm, clearConfirm } = useConfirm();

  const workspace = useQuery({ queryKey: ["workspace"], queryFn: api.getWorkspace });
  const folders = useQuery({ queryKey: ["folders"], queryFn: api.listFolders, refetchInterval: FILE_TREE_POLL_MS });
  const queries = useQuery({ queryKey: ["queries"], queryFn: api.listQueries, refetchInterval: FILE_TREE_POLL_MS });

  // Auto-open all folders on first load
  useEffect(() => {
    if (!folders.data) return;
    const collect = (list: QueryFolder[]) => {
      list.forEach((f) => { setOpenFolders((p) => new Set([...p, f.id])); collect(f.children); });
    };
    collect(folders.data);
    // Intentionally keyed on the count, not folders.data identity: the query
    // refetches on an interval, and depending on the array would re-open
    // folders the user has since collapsed on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders.data?.length]);

  useEffect(() => { if (newFolderParentId !== undefined) newFolderRef.current?.focus(); }, [newFolderParentId]);
  useEffect(() => { if (renamingId) renameRef.current?.focus(); }, [renamingId]);

  async function handlePickWorkspace() {
    try {
      await api.pickWorkspace();
      qc.invalidateQueries({ queryKey: ["workspace"] });
      invalidateWorkspace(qc);
    } catch { /* user cancelled */ }
  }

  const createFolder = useMutation({
    mutationFn: ({ name, parentFolderId }: { name: string; parentFolderId?: string }) =>
      api.createFolder(name, undefined, parentFolderId),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      // Auto-open the newly created folder and its parent
      setOpenFolders((p) => new Set([...p, data.id]));
    },
  });
  const renameFolder = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateFolder(id, name),
    onSuccess: () => invalidateWorkspace(qc),
  });
  const deleteFolder = useMutation({
    mutationFn: (id: string) => api.deleteFolder(id),
    onSuccess: () => invalidateWorkspace(qc),
  });
  const deleteQuery = useMutation({
    mutationFn: (id: string) => api.deleteQuery(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queries"] }),
  });
  const moveQuery = useMutation({
    mutationFn: ({ query, folderId }: { query: SavedQuery; folderId: string | null }) =>
      api.updateQuery(query.id, query.name, query.sql, query.connection_id, folderId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queries"] }),
  });
  const moveFolder = useMutation({
    mutationFn: ({ id, targetParentId }: { id: string; targetParentId: string | null }) => {
      const name = id.split("/").pop()!;
      // "" = workspace root, otherwise the folder path
      return api.updateFolder(id, name, targetParentId ?? "");
    },
    onSuccess: () => invalidateWorkspace(qc),
  });
  const renameQuery = useMutation({
    mutationFn: ({ query, name }: { query: SavedQuery; name: string }) =>
      api.updateQuery(query.id, name, query.sql, query.connection_id, query.folder_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queries"] }),
  });

  function startCreatingFolder(parentId: string | null) {
    setNewFolderParentId(parentId);
    setNewFolderName("");
    if (parentId !== null) setOpenFolders((p) => new Set([...p, parentId]));
  }

  function submitNewFolder() {
    const name = newFolderName.trim();
    if (name) createFolder.mutate({ name, parentFolderId: newFolderParentId ?? undefined });
    setNewFolderParentId(undefined);
    setNewFolderName("");
  }

  function cancelNewFolder() {
    setNewFolderParentId(undefined);
    setNewFolderName("");
  }

  function submitRename() {
    if (renamingId && renameVal.trim()) renameFolder.mutate({ id: renamingId, name: renameVal.trim() });
    setRenamingId(null);
    setRenameVal("");
  }

  function toggleFolder(id: string) {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleDrop(targetFolderId: string | null) {
    if (dragQueryId) {
      const query = queries.data?.find((q) => q.id === dragQueryId);
      if (query && query.folder_id !== targetFolderId) moveQuery.mutate({ query, folderId: targetFolderId });
    } else if (dragFolderId) {
      // Prevent dropping into itself or a descendant
      const isSelf = dragFolderId === targetFolderId;
      const isDescendant = targetFolderId !== null && targetFolderId.startsWith(dragFolderId + "/");
      const currentParent = dragFolderId.includes("/")
        ? dragFolderId.split("/").slice(0, -1).join("/")
        : null;
      const alreadyThere = currentParent === targetFolderId;
      if (!isSelf && !isDescendant && !alreadyThere) {
        moveFolder.mutate({ id: dragFolderId, targetParentId: targetFolderId });
      }
    }
    setDragQueryId(null);
    setDragFolderId(null);
    setDragOverFolderId(null);
  }

  const hasWorkspace = !!workspace.data?.path;
  const term = search.toLowerCase();
  const allQueries = queries.data ?? [];

  // Group queries by their immediate folder_id
  const byFolder: Record<string, SavedQuery[]> = {};
  const rootQueries: SavedQuery[] = [];
  for (const q of allQueries) {
    if (!term || q.name.toLowerCase().includes(term)) {
      if (q.folder_id) (byFolder[q.folder_id] ??= []).push(q);
      else rootQueries.push(q);
    }
  }

  // Recursive folder renderer (closure over all state)
  function renderFolders(folderList: QueryFolder[], depth: number) {
    const indent = depth * 12;
    return folderList.map((folder) => {
      const isOpen = openFolders.has(folder.id) || !!term;
      const isOver = dragOverFolderId === folder.id;
      const folderQueries = byFolder[folder.id] ?? [];
      const isRenaming = renamingId === folder.id;
      const visible = !term || folder.name.toLowerCase().includes(term)
        || folderQueries.length > 0
        || folder.children.some((c) => byFolder[c.id]?.length);

      if (!visible) return null;

      return (
        <div key={folder.id}>
          <div
            draggable={!isRenaming}
            onDragStart={(e) => { e.stopPropagation(); setDragFolderId(folder.id); }}
            onDragEnd={() => setDragFolderId(null)}
            style={{ paddingLeft: 8 + indent }}
            className={`group flex items-center gap-1.5 pr-2 py-1 rounded cursor-pointer select-none ${isOver ? "bg-[#1e3550]" : "hover:bg-[#1d1d22]"}`}
            onClick={() => !isRenaming && toggleFolder(folder.id)}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverFolderId(folder.id); }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(folder.id); }}
          >
            <span className="text-[#6a6a72] w-3 shrink-0 flex items-center">
              {isOpen
                ? <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M1 3l4 4 4-4H1z"/></svg>
                : <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l4 4-4 4V1z"/></svg>
              }
            </span>
            <span className="text-[#8a8a92] shrink-0 flex items-center">
              {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
            </span>
            {isRenaming ? (
              <input
                ref={renameRef} value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                className="flex-1 bg-[#1d1d22] border border-[#3a3a4a] rounded px-1 text-[13px] text-white outline-none focus:border-[#5a5aaa]"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") submitRename();
                  if (e.key === "Escape") { setRenamingId(null); setRenameVal(""); }
                }}
                onBlur={submitRename}
              />
            ) : (
              <span
                className="flex-1 truncate text-[13px] text-[#c8c8d0]"
                onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(folder.id); setRenameVal(folder.name); }}
              >
                {folder.name}
              </span>
            )}
            <button
              className="opacity-0 group-hover:opacity-100 text-[#8a8a92] hover:text-white shrink-0 p-0.5 rounded"
              title="New subfolder"
              onClick={(e) => { e.stopPropagation(); startCreatingFolder(folder.id); }}
            >
              <Plus size={12} />
            </button>
            <button
              className="opacity-0 group-hover:opacity-100 text-[#8a8a92] hover:text-red-400 shrink-0 p-0.5 rounded"
              title="Delete folder"
              onClick={(e) => { e.stopPropagation(); confirm(`Delete folder "${folder.name}" and all its contents?`, () => deleteFolder.mutate(folder.id)); }}
            >
              <Trash2 size={13} />
            </button>
          </div>

          {isOpen && (
            <>
              {renderFolders(folder.children, depth + 1)}
              {/* Inline subfolder creation input */}
              {newFolderParentId === folder.id && (
                <div style={{ paddingLeft: 8 + (depth + 1) * 12 }} className="py-1 pr-2">
                  <input
                    ref={newFolderRef} value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="Folder name"
                    className="w-full bg-[#1d1d22] border border-[#3a3a4a] rounded px-2 py-0.5 text-[13px] text-white outline-none focus:border-[#5a5aaa]"
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "Enter") submitNewFolder();
                      if (e.key === "Escape") cancelNewFolder();
                    }}
                    onBlur={submitNewFolder}
                  />
                </div>
              )}
              {folderQueries.map((q) => (
                <QueryRow key={q.id} query={q} indentPx={8 + (depth + 1) * 12}
                  onOpen={() => openTab(q.name, q.sql, false, `saved:${q.id}`)}
                  onDelete={() => confirm(`Delete "${q.name}"?`, () => deleteQuery.mutate(q.id))}
                  onRename={(name) => renameQuery.mutate({ query: q, name })}
                  onDragStart={() => setDragQueryId(q.id)}
                  onDragEnd={() => setDragQueryId(null)}
                />
              ))}
            </>
          )}
        </div>
      );
    });
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <SidebarHeader label={`QUERIES${allQueries.length ? ` (${allQueries.length})` : ""}`}>
        {hasWorkspace && (
          <button className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33]" title="Reveal in Finder"
            onClick={() => api.revealWorkspace()}>
            <ExternalLink size={14} />
          </button>
        )}
        {hasWorkspace && (
          <button className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33]" title="New folder"
            onClick={() => startCreatingFolder(null)}>
            <Plus size={14} />
          </button>
        )}
        <button
          className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33]"
          title={hasWorkspace ? "Change workspace folder" : "Open workspace folder"}
          onClick={handlePickWorkspace}
        >
          <FolderOpen size={14} />
        </button>
      </SidebarHeader>

      {workspace.data?.path && (
        <div
          className="px-2 py-0.5 text-[11px] text-[#6a6a72] truncate border-b border-[#2c2c33] cursor-pointer hover:text-[#a0a0a8]"
          title={workspace.data.path}
          onClick={() => api.revealWorkspace()}
        >
          {abbreviatePath(workspace.data.path)}
        </div>
      )}

      {hasWorkspace && (
        <SearchInput value={search} onChange={setSearch} />
      )}

      {!hasWorkspace ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4">
          <p className="text-xs text-[#6a6a72] text-center">Open a folder to save and organize queries as plain <code className="font-mono">.sql</code> files</p>
          <button
            onClick={handlePickWorkspace}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1e3550] hover:bg-[#263d5e] text-[#6aa3e8] text-xs"
          >
            <FolderOpen size={14} /> Open folder…
          </button>
        </div>
      ) : (
        <div
          className="flex-1 overflow-auto min-h-0 px-1 pb-1"
          onDragOver={(e) => { e.preventDefault(); setDragOverFolderId("__root__"); }}
          onDrop={(e) => { e.preventDefault(); handleDrop(null); }}
        >
          {/* Root-level folder creation input */}
          {newFolderParentId === null && (
            <div className="px-2 py-1">
              <input
                ref={newFolderRef} value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Folder name"
                className="w-full bg-[#1d1d22] border border-[#3a3a4a] rounded px-2 py-0.5 text-[13px] text-white outline-none focus:border-[#5a5aaa]"
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") submitNewFolder();
                  if (e.key === "Escape") cancelNewFolder();
                }}
                onBlur={submitNewFolder}
              />
            </div>
          )}

          {renderFolders(folders.data ?? [], 0)}

          {rootQueries.map((q) => (
            <QueryRow key={q.id} query={q}
              onOpen={() => openTab(q.name, q.sql, false, `saved:${q.id}`)}
              onDelete={() => confirm(`Delete "${q.name}"?`, () => deleteQuery.mutate(q.id))}
              onRename={(name) => renameQuery.mutate({ query: q, name })}
              onDragStart={() => setDragQueryId(q.id)}
              onDragEnd={() => setDragQueryId(null)}
            />
          ))}

          {allQueries.length === 0 && newFolderParentId === undefined && (
            <div className="px-2 text-xs text-[#6a6a72]">No saved queries</div>
          )}
        </div>
      )}

      <ConfirmDialog state={confirmState} onCancel={clearConfirm} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables panel (editor sidebar only)
// ---------------------------------------------------------------------------

function storageKey(connectionId: string | null) {
  return `surus:hidden-schemas:${connectionId ?? "none"}`;
}

function loadHiddenSchemas(connectionId: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(connectionId));
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveHiddenSchemas(connectionId: string | null, hidden: Set<string>) {
  try {
    localStorage.setItem(storageKey(connectionId), JSON.stringify([...hidden]));
  } catch { /* ignore */ }
}

function TablesPanel({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  const { activeConnectionId } = useStore();
  const [hiddenSchemas, setHiddenSchemas] = useState<Set<string>>(
    () => loadHiddenSchemas(activeConnectionId)
  );

  // Reload the persisted filter when the active connection changes (the initial
  // value is loaded lazily in useState above). Adjusted during render rather
  // than in an effect.
  const [prevConnId, setPrevConnId] = useState(activeConnectionId);
  if (activeConnectionId !== prevConnId) {
    setPrevConnId(activeConnectionId);
    setHiddenSchemas(loadHiddenSchemas(activeConnectionId));
  }

  function toggleSchema(name: string) {
    setHiddenSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      saveHiddenSchemas(activeConnectionId, next);
      return next;
    });
  }

  return (
    <SchemaExplorer
      connectionId={activeConnectionId}
      hiddenSchemas={hiddenSchemas}
      onToggleSchema={toggleSchema}
      onRefresh={onRefresh}
      refreshing={refreshing}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared primitives (local)
// ---------------------------------------------------------------------------

function QueryRow({ query, indentPx = 8, onOpen, onDelete, onRename, onDragStart, onDragEnd }: {
  query: SavedQuery; indentPx?: number;
  onOpen: () => void; onDelete: () => void; onRename: (name: string) => void;
  onDragStart: () => void; onDragEnd: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renaming) inputRef.current?.focus(); }, [renaming]);

  function submitRename() {
    const trimmed = val.trim();
    if (trimmed && trimmed !== query.name) onRename(trimmed);
    setRenaming(false);
  }

  return (
    <div
      draggable={!renaming}
      onDragStart={(e) => { if (!renaming) { e.stopPropagation(); onDragStart(); } }}
      onDragEnd={onDragEnd}
      style={{ paddingLeft: indentPx }}
      className="group flex items-center gap-2 pr-2 py-1 rounded hover:bg-[#1d1d22] cursor-pointer"
      onClick={() => !renaming && onOpen()}
      title={renaming ? undefined : query.sql}
    >
      <FileCode2 size={13} className="text-[#6a6a72] shrink-0" />
      {renaming ? (
        <input
          ref={inputRef} value={val}
          onChange={(e) => setVal(e.target.value)}
          className="flex-1 bg-[#1d1d22] border border-[#3a3a4a] rounded px-1 text-[13px] text-white outline-none focus:border-[#5a5aaa]"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") submitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={submitRename}
        />
      ) : (
        <span
          className="flex-1 truncate text-[13px]"
          onDoubleClick={(e) => { e.stopPropagation(); setVal(query.name); setRenaming(true); }}
        >
          {query.name}
        </span>
      )}
      <button className="opacity-0 group-hover:opacity-100 text-[#8a8a92] hover:text-red-400 shrink-0 p-0.5 rounded"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

interface ConfirmState { message: string; onConfirm: () => void; }

export function ConfirmDialog({ state, onCancel }: { state: ConfirmState | null; onCancel: () => void }) {
  if (!state) return null;
  return (
    <Modal
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
            className="px-3 py-1.5 rounded text-xs bg-red-800 hover:bg-red-700 text-white"
            onClick={() => { state.onConfirm(); onCancel(); }}
          >
            Delete
          </button>
        </>
      }
    >
      <p className="text-sm text-[#c8c8d0] mb-5">{state.message}</p>
    </Modal>
  );
}

function useConfirm() {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  function confirm(message: string, onConfirm: () => void) {
    setConfirmState({ message, onConfirm });
  }
  return { confirmState, confirm, clearConfirm: () => setConfirmState(null) };
}
