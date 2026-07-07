// The editor's right-hand agent panel: a compact chat with history behind a
// toggle. All behaviour lives in the shared chat controller; this file is just
// the panel chrome + layout. The full-page variant is AskPage.
import { Plus, History, KeyRound, ChevronRight } from "lucide-react";
import { useChatController } from "./chat/useChatController";
import { ChatMessages } from "./chat/ChatMessages";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatHistory } from "./chat/ChatHistory";

export function ChatPanel({ onCollapse }: { onCollapse: () => void }) {
  const chat = useChatController({ defaultMode: "sql", watchPendingMessage: true });

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
          onClick={chat.startNewChat}
        >
          <Plus size={14} /> New
        </button>
        <button
          className={`p-1 rounded hover:bg-[#2c2c33] flex items-center ${chat.showHistory ? "text-white bg-[#2c2c33]" : "text-[#8a8a92] hover:text-white"}`}
          title="Chat history"
          onClick={() => chat.setShowHistory((v) => !v)}
        >
          <History size={14} />
        </button>
        <button
          className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33] flex items-center"
          title="API key settings"
          onClick={chat.openKeySettings}
        >
          <KeyRound size={14} />
        </button>
        <button
          className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33] flex items-center"
          title="Collapse agent panel"
          onClick={onCollapse}
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {chat.showHistory ? (
        <ChatHistory chat={chat} />
      ) : (
        <>
          <ChatMessages chat={chat} />
          <ChatComposer chat={chat} showModePicker />
        </>
      )}
    </aside>
  );
}
