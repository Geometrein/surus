// "Ask your data" — a full-page chat with the database. Same two-column shape as
// the other pages (history sidebar + central content), but both columns share a
// single chat controller so selecting a past chat on the left drives the chat on
// the right. Defaults to Question mode: look into the data and answer in English.
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Plus, KeyRound } from "lucide-react";
import { SidebarPanel, SidebarHeader } from "./SidebarPanel";
import { useChatController, type ChatController } from "./chat/useChatController";
import { ChatMessages } from "./chat/ChatMessages";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatHistory } from "./chat/ChatHistory";

export function AskPage() {
  const chat = useChatController({ defaultMode: "question", historyAlwaysOpen: true });
  return (
    <PanelGroup direction="horizontal" className="flex-1 min-w-0 min-h-0">
      <Panel defaultSize={22} minSize={14} maxSize={40}>
        <AskSidebar chat={chat} />
      </Panel>
      <PanelResizeHandle className="w-[3px] bg-[#2c2c33] hover:bg-[#3b6fb5] data-[resize-handle-state=drag]:bg-[#3b6fb5] transition-colors" />
      <Panel defaultSize={78} minSize={40} className="flex flex-col min-w-0">
        <AskChat chat={chat} />
      </Panel>
    </PanelGroup>
  );
}

function AskSidebar({ chat }: { chat: ChatController }) {
  return (
    <SidebarPanel>
      <SidebarHeader label="CHATS">
        <button
          className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33]"
          title="New chat"
          onClick={chat.startNewChat}
        >
          <Plus size={14} />
        </button>
      </SidebarHeader>
      <ChatHistory chat={chat} />
    </SidebarPanel>
  );
}

function AskChat({ chat }: { chat: ChatController }) {
  return (
    <div className="w-full h-full flex flex-col bg-[#131316] min-h-0 min-w-0">
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 bg-[#1f1f24] border-b border-[#2c2c33]">
        <img src="/surus_logo.png" alt="" className="h-4 w-4 rounded" />
        <span className="font-semibold text-sm">Ask your data</span>
        <div className="flex-1" />
        <button
          className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33] flex items-center gap-1 text-xs"
          title="New chat"
          onClick={chat.startNewChat}
        >
          <Plus size={14} /> New
        </button>
        <button
          className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33] flex items-center"
          title="API key settings"
          onClick={chat.openKeySettings}
        >
          <KeyRound size={14} />
        </button>
      </div>
      {/* Full-width so the scrollbar sits at the page edge; ChatMessages/Composer
          center their own content on wide screens so it reads like a document. */}
      <ChatMessages chat={chat} centered />
      <ChatComposer chat={chat} showModePicker={false} centered />
    </div>
  );
}
