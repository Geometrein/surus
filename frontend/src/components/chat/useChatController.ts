// The chat "controller": all state + behaviour behind the agent chat (sessions,
// streaming, send/stop, history), shared by the editor ChatPanel and the Ask
// page. Views are thin and stateless; they render whatever this returns.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, streamChat, type AgentEvent, type ChatSessionT } from "../../api/client";
import { useStore } from "../../store";
import { toolActivityKind } from "../../utils";
import { type AgentMode, type Msg, appendEvent, msgsFromHistory, oneLine, toolLabel } from "./shared";

export interface ChatControllerOptions {
  /** Mode a fresh chat starts in (editor: "sql", Ask page: "question"). */
  defaultMode?: AgentMode;
  /** Page layout keeps history permanently visible, so always load sessions. */
  historyAlwaysOpen?: boolean;
  /** Only the editor chat consumes store.pendingChatMessage (explain-with-AI). */
  watchPendingMessage?: boolean;
}

export function useChatController(opts: ChatControllerOptions = {}) {
  const { defaultMode = "sql", historyAlwaysOpen = false, watchPendingMessage = false } = opts;
  const { activeConnectionId, openTab, log, setPage, setSettingsCategory, pendingChatMessage, setPendingChatMessage } =
    useStore();
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<AgentMode>(defaultMode);
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

  function openKeySettings() {
    setSettingsCategory("agent");
    setPage("settings");
  }

  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });

  // Adopt the configured default model until the user picks one for this chat.
  useEffect(() => {
    if (!model && settings.data?.defaultModel) setModel(settings.data.defaultModel);
  }, [model, settings.data?.defaultModel]);

  const sessions = useQuery({
    queryKey: ["chat-sessions", activeConnectionId],
    queryFn: () => api.listSessions(activeConnectionId!),
    enabled: !!activeConnectionId && (historyAlwaysOpen || showHistory),
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
    if (!watchPendingMessage || !pendingChatMessage) return;
    const msg = pendingChatMessage;
    setPendingChatMessage(null);
    setSessionId(null);
    setMessages([]);
    setShowHistory(false);
    setInput(msg);
    setPendingSend(true);
  }, [watchPendingMessage, pendingChatMessage, setPendingChatMessage]);

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

  async function deleteSession(id: string, e: MouseEvent) {
    e.stopPropagation();
    await api.deleteSession(id);
    qc.invalidateQueries({ queryKey: ["chat-sessions", activeConnectionId] });
    if (sessionId === id) startNewChat();
  }

  function startRename(session: ChatSessionT, e: MouseEvent) {
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

  function cancelRename() {
    setRenamingId(null);
  }

  // Switching mode or model can't continue the current server-side conversation
  // (a session is pinned to both), so start a fresh chat.
  function changeMode(m: AgentMode) {
    setMode(m);
    setSessionId(null);
    setMessages([]);
  }
  function changeModel(m: string) {
    setModel(m);
    setSessionId(null);
    setMessages([]);
  }

  // Stop a running generation: tell the backend to halt (so it releases the
  // session lock and the chat stays usable) before aborting the SSE stream.
  function stop() {
    if (sessionId) api.stopChat(sessionId).catch(() => {});
    abortRef.current?.abort();
  }

  // `explicit` is used by "retry": resend a prior prompt without touching the
  // composer draft. Normal sends read (and clear) the composer input.
  async function send(explicit?: string) {
    const content = (explicit ?? input).trim();
    if (!content || busy || !activeConnectionId) return;
    if (explicit === undefined) setInput("");
    // Only push the user turn; assistant bubbles are created as events arrive so
    // each text block the agent emits (e.g. its opening plan vs. its final answer
    // across a tool call) becomes a separate bubble instead of one merged blob.
    setMessages((m) => [...m, { role: "user", text: content, steps: [] }]);
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    log("info", `asked agent: ${oneLine(content)}`, "user", "chat");
    try {
      const sid = await ensureSession();
      // Invalidate sessions list so history picks up new title after first message.
      qc.invalidateQueries({ queryKey: ["chat-sessions", activeConnectionId] });
      await streamChat(sid, content, (e: AgentEvent) => {
        if (e.kind === "error") log("error", `agent: ${e.text}`, "agent", "chat");
        // Surface each tool call in the Logs page as a concise agent action, so
        // the log shows *what the agent did* (the SQL-running tools also produce
        // their own timed query-log rows from the backend).
        else if (e.kind === "tool_call") {
          const inp = e.toolInput ?? {};
          const detail = inp.sql
            ? `: ${oneLine(String(inp.sql), 120)}`
            : inp.table
              ? `: ${inp.schema ?? ""}.${inp.table}`
              : "";
          log("info", `${toolLabel(e.toolName) ?? e.toolName}${detail}`, "agent", toolActivityKind(e.toolName));
        }
        setMessages((m) => appendEvent(m, e));
      }, abort.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // User interrupted — keep whatever was streamed; add a marker only if the
        // in-flight bubble never produced any text.
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant" && !last.text)
            copy[copy.length - 1] = { ...last, text: "*(interrupted)*" };
          return copy;
        });
      } else {
        log("error", `agent: ${(e as Error).message}`, "agent", "chat");
        setMessages((m) => appendEvent(m, { kind: "error", text: (e as Error).message }));
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

  return {
    // state
    activeConnectionId, sessionId, model, mode, messages, input, busy,
    showHistory, historySearch, renamingId, renameValue,
    settings, sessions, activeProvider, hasKey,
    // refs
    scrollRef, inputRef,
    // store passthroughs used by views
    openTab, setPage, openKeySettings,
    // setters / actions
    setInput, setShowHistory, setHistorySearch, setRenameValue,
    changeMode, changeModel,
    startNewChat, loadSession, deleteSession, startRename, commitRename, cancelRename, stop, send,
  };
}

export type ChatController = ReturnType<typeof useChatController>;
