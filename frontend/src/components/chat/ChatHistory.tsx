// Chat history: a searchable, date-grouped list of past sessions for the active
// connection, with inline rename + delete. Used by the editor panel (toggled)
// and the Ask page's left sidebar (always visible).
import { Pencil, Trash2 } from "lucide-react";
import { SearchInput } from "../SearchInput";
import { useStore } from "../../store";
import { formatDateTime } from "../../utils";
import { MODES, groupSessionsByDate, relativeTime } from "./shared";
import type { ChatController } from "./useChatController";

export function ChatHistory({ chat }: { chat: ChatController }) {
  const {
    activeConnectionId, sessions, sessionId, historySearch, setHistorySearch,
    renamingId, renameValue, setRenameValue, loadSession, deleteSession, startRename, commitRename, cancelRename,
  } = chat;
  const timezone = useStore((s) => s.timezone);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SearchInput value={historySearch} onChange={setHistorySearch} placeholder="Search chats…" autoFocus />
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0">
        {!activeConnectionId && <div className="p-4 text-xs text-muted">Connect to a database first.</div>}
        {sessions.isLoading && <div className="p-4 text-xs text-muted">Loading…</div>}
        {sessions.data?.length === 0 && (
          <div className="p-4 text-xs text-muted">No past chats for this connection.</div>
        )}
        {sessions.data &&
          (() => {
            const filtered = sessions.data.filter(
              (s) => !historySearch || s.title.toLowerCase().includes(historySearch.toLowerCase())
            );
            return (
              <>
                {groupSessionsByDate(filtered).map(({ label, items }) => (
                  <div key={label}>
                    <div className="px-3 pt-3 pb-1 text-[10px] font-semibold tracking-wider text-muted uppercase">
                      {label}
                    </div>
                    {items.map((s) => (
                      <div
                        key={s.id}
                        onClick={() => (renamingId === s.id ? undefined : loadSession(s))}
                        className={`group flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-hover border-b border-hover ${s.id === sessionId ? "bg-accent-bg" : ""}`}
                      >
                        <div className="flex-1 min-w-0">
                          {renamingId === s.id ? (
                            <input
                              autoFocus
                              value={renameValue}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onBlur={commitRename}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitRename();
                                } else if (e.key === "Escape") cancelRename();
                              }}
                              className="w-full bg-app border border-line-strong rounded px-1 py-0.5 text-xs outline-none"
                            />
                          ) : (
                            <div
                              className="text-xs text-body truncate"
                              onDoubleClick={(e) => startRename(s, e)}
                            >
                              {s.title}
                            </div>
                          )}
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span
                              className="text-[11px] text-muted"
                              title={formatDateTime(s.created_at as unknown as string, timezone)}
                            >
                              {relativeTime(s.created_at as unknown as string)}
                            </span>
                            {s.mode && s.mode !== "sql" && (
                              <span className="text-[10px] text-muted bg-line rounded px-1 py-px leading-none">
                                {MODES.find((m) => m.value === s.mode)?.label ?? s.mode}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={(e) => startRename(s, e)}
                          className="opacity-0 group-hover:opacity-100 text-muted hover:text-white shrink-0 mt-0.5 p-0.5 rounded flex items-center"
                          title="Rename"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={(e) => deleteSession(s.id, e)}
                          className="opacity-0 group-hover:opacity-100 text-muted hover:text-red-400 shrink-0 mt-0.5 p-0.5 rounded flex items-center"
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
                {historySearch && filtered.length === 0 && (
                  <div className="p-4 text-xs text-muted">No chats match "{historySearch}".</div>
                )}
              </>
            );
          })()}
      </div>
    </div>
  );
}
