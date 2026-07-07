// The scrollable conversation area: user bubbles, assistant markdown, the tool
// trail, inline charts, and the submit_query result card. Purely presentational
// — driven by the shared chat controller.
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Wrench, ExternalLink, Copy, Check, RotateCcw } from "lucide-react";
import { normalizeMd, extractSqlBlocks } from "../../lib/markdown";
import { MODES, activityLabel, toolLabel, parseChartSpec } from "./shared";
import type { ChatController } from "./useChatController";
import { AgentChart } from "./AgentChart";

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

// Copy + retry actions shown under a message on hover. Copy is omitted when there
// is nothing textual to copy (e.g. a chart-only bubble).
function MsgActions({ align, text, onRetry, disabled }: {
  align: "left" | "right";
  text?: string;
  onRetry?: () => void;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked */ }
  }
  const btn = "text-[#6a6a72] hover:text-[#c8c8d0] p-1 rounded hover:bg-[#2c2c33] transition-colors disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className={`flex items-center gap-0.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity ${align === "right" ? "justify-end" : "justify-start"}`}>
      {text && (
        <button className={btn} title={copied ? "Copied" : "Copy"} onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
      {onRetry && (
        <button className={btn} title="Retry" onClick={onRetry} disabled={disabled}>
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}

export function ChatMessages({ chat, centered = false }: { chat: ChatController; centered?: boolean }) {
  const { messages, busy, mode, activeConnectionId, hasKey, openTab, scrollRef, openKeySettings, send } = chat;

  // The nearest preceding user prompt for message `index` — what "Retry" resends.
  function promptFor(index: number): string | null {
    for (let i = index; i >= 0; i--) if (messages[i].role === "user") return messages[i].text;
    return null;
  }
  function retry(index: number) {
    const prompt = promptFor(index);
    if (prompt) send(prompt);
  }

  // Markdown link renderer: the "#api-key" sentinel (emitted by linkifyError)
  // becomes an in-app button to the key settings; everything else is external.
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

  return (
    // Full-width scroll container (scrollbar sits at the page edge); the content
    // column is width-capped and centered when `centered` (the Ask page).
    <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0">
      <div className={`p-3 space-y-3 ${centered ? "max-w-3xl mx-auto w-full" : ""}`}>
        {activeConnectionId && hasKey && messages.length === 0 && (
          <Hint>{MODES.find((m) => m.value === mode)?.hint}</Hint>
        )}
        {messages.map((m, i) => {
          if (m.role === "user") {
            return (
              <div key={i} className="group">
                <div className="flex justify-end">
                  <div className="max-w-[85%] bg-[#1e3550] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words">
                    {m.text}
                  </div>
                </div>
                <MsgActions align="right" text={m.text} onRetry={() => retry(i)} disabled={busy} />
              </div>
            );
          }
          // The final query is returned via the submit_query tool; render_chart
          // steps become inline charts; the rest are the routine EXPLAIN/inspect
          // steps shown as a compact trail.
          const submit = m.steps.find((st) => st.toolName === "submit_query");
          const charts = m.steps.filter((st) => st.toolName === "render_chart");
          const trail = m.steps.filter((st) => st.toolName !== "submit_query" && st.toolName !== "render_chart");
          // Fallback: only surface fenced ```sql blocks when no submit_query was
          // made (older chats / conversational replies that fenced SQL).
          const sqlBlocks = submit ? [] : extractSqlBlocks(normalizeMd(m.text));
          const multi = sqlBlocks.length > 1;
          const submitSql = submit?.toolInput?.sql ? String(submit.toolInput.sql) : "";
          const submitRationale = submit?.toolInput?.rationale ? String(submit.toolInput.rationale) : "";
          return (
            <div key={i} className="group mr-2">
              {trail.map((st, j) => (
                <div key={j} className="flex items-center gap-1 text-[11px] text-[#6a6a72] font-mono mb-1">
                  <Wrench size={11} className="shrink-0" />
                  {toolLabel(st.toolName)}
                  {st.toolInput?.sql ? `: ${String(st.toolInput.sql).slice(0, 70)}` : ""}
                </div>
              ))}
              {m.text && (
                <div className="bg-[#1b1b1f] border border-[#2c2c33] rounded-lg px-3 py-2 text-sm prose-chat">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{normalizeMd(m.text)}</ReactMarkdown>
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
              {charts.map((st, k) => {
                const parsed = parseChartSpec(st.toolInput);
                return parsed ? (
                  <AgentChart key={k} connectionId={activeConnectionId} sql={parsed.sql} spec={parsed.spec} />
                ) : null;
              })}
              {submitSql && (
                <div className="mt-1 bg-[#1b1b1f] border border-[#2c2c33] rounded-lg overflow-hidden">
                  <pre className="px-3 py-2 text-xs font-mono text-[#c8c8d0] whitespace-pre-wrap break-words border-b border-[#2c2c33]">
                    {submitSql}
                  </pre>
                  {submitRationale && (
                    <div className="px-3 py-2 text-sm prose-chat">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMd(submitRationale)}</ReactMarkdown>
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
              {/* Copy the answer text (if any) / retry from the preceding prompt. */}
              {(m.text || submitSql) && (
                <MsgActions align="left" text={m.text || submitSql} onRetry={() => retry(i)} disabled={busy} />
              )}
            </div>
          );
        })}
        {busy && <ThinkingIndicator label={activityLabel(messages)} />}
      </div>
    </div>
  );
}
