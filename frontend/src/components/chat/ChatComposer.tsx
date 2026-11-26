// The input box: textarea + inline toolbar (optional mode picker, model select,
// and the send/stop button). Owns only its own dropdown UI state; everything
// else comes from the shared chat controller.
import { useEffect, useRef, useState } from "react";
import { SquareIcon, ArrowUp, ChevronDown } from "lucide-react";
import { MODES, modelLabel } from "./shared";
import type { ChatController } from "./useChatController";

export function ChatComposer({ chat, showModePicker = true, centered = false }: { chat: ChatController; showModePicker?: boolean; centered?: boolean }) {
  const {
    input, setInput, mode, changeMode, model, changeModel, busy, send, stop,
    hasKey, activeConnectionId, activeProvider, settings, inputRef, setPage, openKeySettings,
  } = chat;
  const [showModeMenu, setShowModeMenu] = useState(false);
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

  return (
    <div className="p-3 border-t border-line">
      <div className={centered ? "max-w-3xl mx-auto" : ""}>
      {/* Why the composer is inactive — shown right at the input box */}
      {!activeConnectionId ? (
        <div className="mb-2 text-xs text-soft">
          Not connected to any data source.{" "}
          <button className="text-accent-text hover:underline" onClick={() => setPage("connections")}>
            Connect here
          </button>
        </div>
      ) : !hasKey ? (
        <div className="mb-2 text-xs text-soft">
          Set your {activeProvider?.label ?? "provider"} API key to start.{" "}
          <button className="text-accent-text hover:underline" onClick={openKeySettings}>
            Open settings
          </button>
        </div>
      ) : null}
      {/* Unified composer — textarea + inline toolbar in one box */}
      <div className="rounded-lg border border-line-strong bg-panel focus-within:border-accent transition-colors">
        <textarea
          ref={inputRef}
          rows={2}
          disabled={!activeConnectionId || !hasKey}
          placeholder={MODES.find((m) => m.value === mode)?.placeholder}
          className="w-full bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none resize-none disabled:opacity-50 placeholder:text-dim min-h-[3rem] max-h-[160px] overflow-y-auto"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          {/* Mode picker (hidden on the dedicated Ask page, which is Q&A-only) */}
          {showModePicker && (
            <div className="relative" ref={modeMenuRef}>
              <button
                disabled={busy}
                onClick={() => setShowModeMenu((v) => !v)}
                className="flex items-center gap-1 text-[11px] text-subtle hover:text-body disabled:opacity-50 rounded py-0.5 px-1 hover:bg-line"
              >
                {MODES.find((m) => m.value === mode)?.label}
                <ChevronDown size={10} />
              </button>
              {showModeMenu && (
                <div className="absolute bottom-full left-0 mb-1 w-56 bg-raised border border-line-strong rounded-lg shadow-lg z-50 overflow-hidden">
                  {/* "Question" is its own top-level Ask page, not an editor mode. */}
                  {MODES.filter((m) => m.value !== "question").map((m) => (
                    <button
                      key={m.value}
                      onClick={() => {
                        changeMode(m.value);
                        setShowModeMenu(false);
                      }}
                      className={`w-full text-left px-3 py-2 hover:bg-line ${mode === m.value ? "text-body" : "text-subtle"}`}
                    >
                      <div className="text-xs font-medium">{m.label}</div>
                      <div className="text-[11px] text-muted mt-0.5">{m.description}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <select
            className="bg-transparent text-[11px] text-subtle hover:text-body outline-none cursor-pointer rounded py-0.5 pr-1 max-w-[150px] disabled:opacity-50"
            value={model || settings.data?.defaultModel || ""}
            disabled={busy}
            title="Model"
            onChange={(e) => changeModel(e.target.value)}
          >
            {(settings.data?.models ?? [model]).map((m) => (
              <option key={m} value={m} className="bg-raised text-body">
                {modelLabel(m)}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          {busy ? (
            <button
              className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md bg-danger-solid hover:bg-danger-solid-hover text-white transition-colors"
              title="Stop"
              onClick={stop}
            >
              <SquareIcon size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md bg-accent hover:bg-accent-hover text-white disabled:opacity-30 disabled:hover:bg-accent transition-colors"
              title="Send (Enter · Shift+Enter for newline)"
              disabled={!activeConnectionId || !hasKey || !input.trim()}
              onClick={() => send()}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
