import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { Plus, History, KeyRound, ChevronRight, Wrench, Pencil, Trash2, SquareIcon, ArrowUp, ExternalLink, ChevronDown } from "lucide-react";
import { api, streamChat, type AgentEvent, type ChatSessionT, type ChatMessageT } from "../api/client";
import { useStore } from "../store";
import { SearchInput } from "./SearchInput";
import { normalizeMd, extractSqlBlocks } from "../lib/markdown";

// The backend surfaces "Invalid API key. Check Settings." as plain text. Turn
// the "Check Settings" hint into a markdown link with a sentinel href that the
// chat renderer intercepts (see the custom `a` component) to jump to the API-key
// settings instead of making the user hunt for them.
function linkifyError(text: string): string {
  return text.replace(/Check Settings\.?/i, "[Check Settings](#api-key).");
}

type AgentMode = "sql" | "question" | "teach";

const MODES: { value: AgentMode; label: string; description: string; placeholder: string; hint: string }[] = [
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
    hint: "Ask anything about your schema, data, or PostgreSQL. I'll answer in plain English.",
  },
  {
    value: "teach",
    label: "Teach",
    description: "Learn SQL with explanations",
    placeholder: "Ask for a query and I'll explain how it works…",
    hint: "Ask for a query and I'll build it step by step, explaining every clause so you can learn from it.",
  },
];

interface Step {
  toolName?: string;
  toolInput?: Record<string, unknown> | null;
  ok?: boolean;
}
interface Msg {
  role: "user" | "assistant";
  text: string;
  steps: Step[];
}

function msgsFromHistory(raw: ChatMessageT[]): Msg[] {
  return raw.map((m) => {
    const steps: Step[] = m.steps_json
      ? (JSON.parse(m.steps_json) as { kind: string; toolName?: string; toolInput?: Record<string, unknown>; ok?: boolean }[])
          .filter((s) => s.kind === "tool_call")
          .map((s) => ({ toolName: s.toolName, toolInput: s.toolInput, ok: s.ok }))
      : [];
    return { role: m.role as "user" | "assistant", text: m.content, steps };
  });
}

function groupSessionsByDate(sessions: import("../api/client").ChatSessionT[]): { label: string; items: typeof sessions }[] {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const weekAgo = today - 6 * 86400000;

  const buckets: { label: string; items: typeof sessions }[] = [
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

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ChatPanel({ onCollapse }: { onCollapse: () => void }) {
  const { activeConnectionId, openTab, log, setPage, setSettingsCategory, pendingChatMessage, setPendingChatMessage } = useStore();
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<AgentMode>("sql");
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [pendingSend, setPendingSend] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showModeMenu) return;
    function handler(e: MouseEvent) {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setShowModeMenu(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModeMenu]);

  function openKeySettings() {
    setSettingsCategory("agent");
    setPage("settings");
  }

  // Markdown link renderer for chat messages: the "#api-key" sentinel (emitted by
  // linkifyError) becomes an in-app button to the key settings; everything else
  // is a normal external link.
  const mdComponents = {
    a({ href, children, node: _node, ...props }: { href?: string; children?: ReactNode; node?: unknown }) {
      if (href === "#api-key")
        return (
          <button type="button" className="text-[#6aa3e8] hover:underline" onClick={openKeySettings}>
            {children}
          </button>
        );
      return (
        <a href={href} target="_blank" rel="noreferrer" {...props}>
          {children}
        </a>
      );
    },
  };

  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });

  // Adopt the configured default model until the user picks one for this panel.
  useEffect(() => {
    if (!model && settings.data?.defaultModel) setModel(settings.data.defaultModel);
  }, [model, settings.data?.defaultModel]);
  const sessions = useQuery({
    queryKey: ["chat-sessions", activeConnectionId],
    queryFn: () => api.listSessions(activeConnectionId!),
    enabled: !!activeConnectionId && showHistory,
  });

  // Reset chat when the connection changes.
  useEffect(() => {
    setSessionId(null);
    setMessages([]);
    setShowHistory(false);
    setHistorySearch("");
  }, [activeConnectionId]);

  // When EditorResults sends an explain prompt, start a fresh chat and queue a send.
  useEffect(() => {
    if (!pendingChatMessage) return;
    const msg = pendingChatMessage;
    setPendingChatMessage(null);
    setSessionId(null);
    setMessages([]);
    setShowHistory(false);
    setInput(msg);
    setPendingSend(true);
  }, [pendingChatMessage, setPendingChatMessage]);

  // Fire the queued send once input and session state have settled.
  useEffect(() => {
    if (!pendingSend || busy || !input.trim() || !activeConnectionId) return;
    setPendingSend(false);
    send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSend, busy, input, activeConnectionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  // Auto-grow the composer textarea to fit its content (capped).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const s = await api.createChatSession(activeConnectionId!, model, mode);
    setSessionId(s.id);
    return s.id;
  }

  function startNewChat() {
    setSessionId(null);
    setMessages([]);
    setShowHistory(false);
  }

  async function loadSession(session: ChatSessionT) {
    const raw = await api.getSessionMessages(session.id);
    setMessages(msgsFromHistory(raw));
    setSessionId(session.id);
    setShowHistory(false);
  }

  async function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await api.deleteSession(id);
    qc.invalidateQueries({ queryKey: ["chat-sessions", activeConnectionId] });
    if (sessionId === id) startNewChat();
  }

  function startRename(session: ChatSessionT, e: React.MouseEvent) {
    e.stopPropagation();
    setRenamingId(session.id);
    setRenameValue(session.title);
  }

  async function commitRename() {
    const id = renamingId;
    const title = renameValue.trim();
    setRenamingId(null);
    if (!id || !title) return;
    await api.renameSession(id, title);
    qc.invalidateQueries({ queryKey: ["chat-sessions", activeConnectionId] });
  }

  async function send() {
    const content = input.trim();
    if (!content || busy || !activeConnectionId) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: content, steps: [] }]);
    const assistant: Msg = { role: "assistant", text: "", steps: [] };
    setMessages((m) => [...m, assistant]);
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    log("info", `asked agent: ${oneLine(content)}`, "user");
    try {
      const sid = await ensureSession();
      // Invalidate sessions list so history picks up new title after first message.
      qc.invalidateQueries({ queryKey: ["chat-sessions", activeConnectionId] });
      await streamChat(sid, content, (e: AgentEvent) => {
        if (e.kind === "error") log("error", `agent: ${e.text}`, "agent");
        setMessages((m) => {
          const copy = [...m];
          const last = { ...copy[copy.length - 1] };
          if (e.kind === "text") last.text += e.text ?? "";
          else if (e.kind === "tool_call")
            last.steps = [...last.steps, { toolName: e.toolName, toolInput: e.toolInput }];
          else if (e.kind === "error") last.text += `\n\n**Error:** ${linkifyError(e.text ?? "")}`;
          copy[copy.length - 1] = last;
          return copy;
        });
      }, abort.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // User interrupted — keep whatever was streamed, add a marker if nothing came through.
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last.role === "assistant" && !last.text)
            copy[copy.length - 1] = { ...last, text: "*(interrupted)*" };
          return copy;
        });
      } else {
        log("error", `agent: ${(e as Error).message}`, "agent");
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            ...copy[copy.length - 1],
            text: copy[copy.length - 1].text + `\n\n**Error:** ${linkifyError((e as Error).message)}`,
          };
          return copy;
        });
      }
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ["chat-sessions", activeConnectionId] });
    }
  }

  // The active model determines which provider's key the composer needs.
  const selectedModel = model || settings.data?.defaultModel || "";
  const activeProviderId = settings.data?.modelProviders?.[selectedModel];
  const activeProvider = settings.data?.providers?.find((p) => p.id === activeProviderId);
  const hasKey = activeProvider?.hasKey ?? false;

  return (
    <aside className="w-full h-full flex flex-col bg-[#131316] border-l border-[#2c2c33] min-h-0 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 bg-[#1f1f24] border-b border-[#2c2c33]">
        <img src="/surus_logo.png" alt="" className="h-4 w-4 rounded" />
        <span className="font-semibold text-sm">SQL agent</span>
        <div className="flex-1" />
        <button
          className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33] flex items-center gap-1 text-xs"
          title="New chat"
          onClick={startNewChat}
        >
          <Plus size={14} /> New
        </button>
        <button
          className={`p-1 rounded hover:bg-[#2c2c33] flex items-center ${showHistory ? "text-white bg-[#2c2c33]" : "text-[#8a8a92] hover:text-white"}`}
          title="Chat history"
          onClick={() => setShowHistory((v) => !v)}
        >
          <History size={14} />
        </button>
        <button className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33] flex items-center" title="API key settings" onClick={openKeySettings}>
          <KeyRound size={14} />
        </button>
        <button className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33] flex items-center" title="Collapse agent panel" onClick={onCollapse}>
          <ChevronRight size={14} />
        </button>
      </div>

      {/* History panel */}
      {showHistory ? (
        <div className="flex-1 flex flex-col min-h-0">
          <SearchInput
            value={historySearch}
            onChange={setHistorySearch}
            placeholder="Search chats…"
            autoFocus
          />
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0">
            {!activeConnectionId && (
              <div className="p-4 text-xs text-[#6a6a72]">Connect to a database first.</div>
            )}
            {sessions.isLoading && (
              <div className="p-4 text-xs text-[#6a6a72]">Loading…</div>
            )}
            {sessions.data?.length === 0 && (
              <div className="p-4 text-xs text-[#6a6a72]">No past chats for this connection.</div>
            )}
            {sessions.data && (() => {
              const filteredSessions = sessions.data.filter((s) =>
                !historySearch || s.title.toLowerCase().includes(historySearch.toLowerCase())
              );
              return (
                <>
                  {groupSessionsByDate(filteredSessions).map(({ label, items }) => (
              <div key={label}>
                <div className="px-3 pt-3 pb-1 text-[10px] font-semibold tracking-wider text-[#6a6a72] uppercase">
                  {label}
                </div>
                {items.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => (renamingId === s.id ? undefined : loadSession(s))}
                    className={`group flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-[#1d1d22] border-b border-[#1e1e24] ${s.id === sessionId ? "bg-[#1e3550]" : ""}`}
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
                            if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                            else if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="w-full bg-[#161619] border border-[#3a3a42] rounded px-1 py-0.5 text-xs outline-none"
                        />
                      ) : (
                        <div
                          className="text-xs text-[#c8c8d0] truncate"
                          onDoubleClick={(e) => startRename(s, e)}
                        >
                          {s.title}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[11px] text-[#6a6a72]">
                          {relativeTime(s.created_at as unknown as string)}
                        </span>
                        {s.mode && s.mode !== "sql" && (
                          <span className="text-[10px] text-[#6a6a72] bg-[#2c2c33] rounded px-1 py-px leading-none">
                            {MODES.find((m) => m.value === s.mode)?.label ?? s.mode}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(e) => startRename(s, e)}
                      className="opacity-0 group-hover:opacity-100 text-[#6a6a72] hover:text-white shrink-0 mt-0.5 p-0.5 rounded flex items-center"
                      title="Rename"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={(e) => deleteSession(s.id, e)}
                      className="opacity-0 group-hover:opacity-100 text-[#6a6a72] hover:text-red-400 shrink-0 mt-0.5 p-0.5 rounded flex items-center"
                      title="Delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
                  {historySearch && filteredSessions.length === 0 && (
                    <div className="p-4 text-xs text-[#6a6a72]">No chats match "{historySearch}".</div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      ) : (
        /* Chat panel */
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3 min-h-0 min-w-0">
            {activeConnectionId && hasKey && messages.length === 0 && (
              <Hint>{MODES.find((m) => m.value === mode)?.hint}</Hint>
            )}
            {messages.map((m, i) => {
              if (m.role === "user") {
                return (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] bg-[#1e3550] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words">
                      {m.text}
                    </div>
                  </div>
                );
              }
              // The final query is returned via the submit_query tool; the rest
              // are the routine EXPLAIN/inspect steps shown as a trail.
              const submit = m.steps.find((st) => st.toolName === "submit_query");
              const trail = m.steps.filter((st) => st.toolName !== "submit_query");
              // Fallback: only surface fenced ```sql blocks when no submit_query
              // was made (older chats / conversational replies that fenced SQL).
              const sqlBlocks = submit ? [] : extractSqlBlocks(normalizeMd(m.text));
              const multi = sqlBlocks.length > 1;
              const submitSql = submit?.toolInput?.sql ? String(submit.toolInput.sql) : "";
              const submitRationale = submit?.toolInput?.rationale
                ? String(submit.toolInput.rationale)
                : "";
              return (
                <div key={i} className="mr-2">
                  {trail.map((st, j) => (
                    <div key={j} className="flex items-center gap-1 text-[11px] text-[#6a6a72] font-mono mb-1">
                      <Wrench size={11} className="shrink-0" />
                      {toolLabel(st.toolName)}
                      {st.toolInput?.sql ? `: ${String(st.toolInput.sql).slice(0, 70)}` : ""}
                    </div>
                  ))}
                  {m.text && (
                    <div className="bg-[#1b1b1f] border border-[#2c2c33] rounded-lg px-3 py-2 text-sm prose-chat">
                      <ReactMarkdown components={mdComponents}>{normalizeMd(m.text)}</ReactMarkdown>
                      {sqlBlocks.map((sql, k) => (
                        <button
                          key={k}
                          className="mt-1 flex items-center gap-1 text-xs text-[#6aa3e8] hover:underline"
                          onClick={() => openTab(multi ? `Agent query ${k + 1}` : "Agent query", sql, true)}
                        >
                          <ExternalLink size={11} /> {multi ? `Open query ${k + 1}` : "Open in editor"}
                        </button>
                      ))}
                    </div>
                  )}
                  {submitSql && (
                    <div className="mt-1 bg-[#1b1b1f] border border-[#2c2c33] rounded-lg overflow-hidden">
                      <pre className="px-3 py-2 text-xs font-mono text-[#c8c8d0] whitespace-pre-wrap break-words border-b border-[#2c2c33]">
                        {submitSql}
                      </pre>
                      {submitRationale && (
                        <div className="px-3 py-2 text-sm prose-chat">
                          <ReactMarkdown>{normalizeMd(submitRationale)}</ReactMarkdown>
                        </div>
                      )}
                      <button
                        className="m-2 flex items-center gap-1 text-xs text-[#6aa3e8] hover:underline"
                        onClick={() => openTab("Agent query", submitSql, true)}
                      >
                        <ExternalLink size={11} /> Open in editor
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {busy && <ThinkingIndicator label={activityLabel(messages)} />}
          </div>

          <div className="p-3 border-t border-[#2c2c33]">
            {/* Why the composer is inactive — shown right at the input box */}
            {!activeConnectionId ? (
              <div className="mb-2 text-xs text-[#a0a0a8]">
                Not connected to any data source.{" "}
                <button className="text-[#6aa3e8] hover:underline" onClick={() => setPage("connections")}>
                  Connect here
                </button>
              </div>
            ) : !hasKey ? (
              <div className="mb-2 text-xs text-[#a0a0a8]">
                Set your {activeProvider?.label ?? "provider"} API key to start.{" "}
                <button className="text-[#6aa3e8] hover:underline" onClick={openKeySettings}>
                  Open settings
                </button>
              </div>
            ) : null}
            {/* Unified composer — textarea + inline toolbar in one box */}
            <div className="rounded-lg border border-[#3a3a42] bg-[#1b1b1f] focus-within:border-[#3b6fb5] transition-colors">
              <textarea
                ref={inputRef}
                rows={2}
                disabled={!activeConnectionId || !hasKey}
                placeholder={MODES.find((m) => m.value === mode)?.placeholder}
                className="w-full bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none resize-none disabled:opacity-50 placeholder:text-[#5a5a62] min-h-[3rem] max-h-[160px] overflow-y-auto"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                }}
              />
              <div className="flex items-center gap-2 px-2 pb-2">
                {/* Mode picker */}
                <div className="relative" ref={modeMenuRef}>
                  <button
                    disabled={busy}
                    onClick={() => setShowModeMenu((v) => !v)}
                    className="flex items-center gap-1 text-[11px] text-[#8a8a92] hover:text-[#c8c8d0] disabled:opacity-50 rounded py-0.5 px-1 hover:bg-[#2c2c33]"
                  >
                    {MODES.find((m) => m.value === mode)?.label}
                    <ChevronDown size={10} />
                  </button>
                  {showModeMenu && (
                    <div className="absolute bottom-full left-0 mb-1 w-56 bg-[#1f1f24] border border-[#3a3a42] rounded-lg shadow-lg z-50 overflow-hidden">
                      {MODES.map((m) => (
                        <button
                          key={m.value}
                          onClick={() => {
                            setMode(m.value);
                            setShowModeMenu(false);
                            setSessionId(null);
                            setMessages([]);
                          }}
                          className={`w-full text-left px-3 py-2 hover:bg-[#2c2c33] ${mode === m.value ? "text-[#c8c8d0]" : "text-[#8a8a92]"}`}
                        >
                          <div className="text-xs font-medium">{m.label}</div>
                          <div className="text-[11px] text-[#6a6a72] mt-0.5">{m.description}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <select
                  className="bg-transparent text-[11px] text-[#8a8a92] hover:text-[#c8c8d0] outline-none cursor-pointer rounded py-0.5 pr-1 max-w-[150px] disabled:opacity-50"
                  value={model || settings.data?.defaultModel || ""}
                  disabled={busy}
                  title="Model"
                  onChange={(e) => { setModel(e.target.value); setSessionId(null); setMessages([]); }}
                >
                  {(settings.data?.models ?? [model]).map((m) => (
                    <option key={m} value={m} className="bg-[#1f1f24] text-[#c8c8d0]">{modelLabel(m)}</option>
                  ))}
                </select>
                <div className="flex-1" />
                {busy ? (
                  <button
                    className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md bg-[#7a2020] hover:bg-[#9a2828] text-white transition-colors"
                    title="Stop"
                    onClick={() => abortRef.current?.abort()}
                  >
                    <SquareIcon size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md bg-[#3b6fb5] hover:bg-[#4a7fc5] text-white disabled:opacity-30 disabled:hover:bg-[#3b6fb5] transition-colors"
                    title="Send (Enter · Shift+Enter for newline)"
                    disabled={!activeConnectionId || !hasKey || !input.trim()}
                    onClick={send}
                  >
                    <ArrowUp size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div className="text-sm text-[#6a6a72]">{children}</div>;
}

function ThinkingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-[#8a8a92]">
      <span className="flex gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" />
      </span>
      {label}…
    </div>
  );
}

// Describes what the agent is currently doing, for the live indicator.
function activityLabel(messages: Msg[]): string {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.steps.length && !last.text) {
    return toolLabel(last.steps[last.steps.length - 1].toolName) ?? "Working";
  }
  return "Thinking";
}

function oneLine(text: string, max = 200): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// "claude-opus-4-8" -> "Opus 4.8", "claude-haiku-4-5-20251001" -> "Haiku 4.5".
// GPT ids keep their conventional casing: "gpt-5" -> "GPT-5", "gpt-4.1" -> "GPT-4.1".
function modelLabel(id: string): string {
  if (/^(gpt|o\d)/i.test(id)) return id.replace(/^gpt/i, "GPT");
  const parts = id.replace(/^claude-/, "").split("-");
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const nums = parts.slice(1).filter((p) => /^\d+$/.test(p) && p.length <= 2);
  return nums.length ? `${name} ${nums.join(".")}` : name;
}

function toolLabel(name?: string) {
  return (
    { run_explain: "Running EXPLAIN", run_query: "Sampling rows", inspect_schema: "Inspecting schema", submit_query: "Finalizing query" }[name ?? ""] ?? name
  );
}

// Ensure fenced code blocks always start on their own line so ReactMarkdown
// parses them as blocks instead of inline code spans.
