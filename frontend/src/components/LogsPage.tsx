import { useEffect, useMemo, useRef, useState } from "react";
import { User, Bot, Cog, Copy, Check, ArrowDownToLine, Trash2 } from "lucide-react";
import { useStore } from "../store";
import type { LogEntry } from "../store";
import { levelColor, sourceBadge, formatClock, ACTIVITY_LABELS, ACTIVITY_BADGE } from "../utils";
import { Modal } from "./Modal";

const SOURCE_ICONS = { user: User, agent: Bot, system: Cog };
const LEVELS = ["error", "warn", "info"] as const;

function levelBorder(lvl: string): string {
  if (lvl === "error") return "border-red-500/60";
  if (lvl === "warn") return "border-amber-500/50";
  return "border-transparent";
}

function durationBadge(ms: number): string {
  if (ms < 100) return "bg-[#1a2a1a] text-emerald-500";
  if (ms < 500) return "bg-[#2a2010] text-amber-400";
  return "bg-[#2a1010] text-red-400";
}

function formatLine(l: LogEntry, tz: string): string {
  return `${formatClock(l.ts, tz)} [${l.source.toUpperCase()}] ${l.level.toUpperCase()}${l.durationMs != null ? ` [${l.durationMs.toFixed(1)}ms]` : ""} ${l.msg}`;
}

export function LogsPage() {
  const { logs, logFilterSources, logFilterLevels, logFilterKinds, logSearch, setLogFilterLevels, clearLogs, timezone } = useStore();
  const [confirmClear, setConfirmClear] = useState(false);

  const filtered = logs.filter((l) => {
    if (logFilterSources.length > 0 && !logFilterSources.includes(l.source)) return false;
    if (logFilterLevels.length > 0 && !logFilterLevels.includes(l.level)) return false;
    if (logFilterKinds.length > 0 && !logFilterKinds.includes(l.kind)) return false;
    if (logSearch && !l.msg.toLowerCase().includes(logSearch.toLowerCase())) return false;
    return true;
  });

  const counts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0 };
    for (const l of logs) c[l.level]++;
    return c;
  }, [logs]);

  // Follow the tail, but pause when the user scrolls up to inspect history.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }
  function jumpToLatest() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollowing(true);
  }
  useEffect(() => {
    if (following && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [filtered.length, following]);

  function toggleLevel(l: LogEntry["level"]) {
    const next = logFilterLevels.includes(l)
      ? logFilterLevels.filter((x) => x !== l)
      : [...logFilterLevels, l];
    setLogFilterLevels(next);
  }

  const copyAll = () => navigator.clipboard.writeText(filtered.map((l) => formatLine(l, timezone)).join("\n"));

  const filtersActive =
    logFilterSources.length > 0 || logFilterLevels.length > 0 || logFilterKinds.length > 0 || !!logSearch;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#1f1f24] border-b border-[#2c2c33] shrink-0">
        <span className="text-xs text-[#8a8a92]">≡ Logs</span>

        {/* Level summary — counts double as quick level filters. */}
        <div className="flex items-center gap-1">
          {LEVELS.map((lvl) => {
            if (counts[lvl] === 0) return null;
            const active = logFilterLevels.length === 0 || logFilterLevels.includes(lvl);
            return (
              <button
                key={lvl}
                onClick={() => toggleLevel(lvl)}
                title={`${counts[lvl]} ${lvl} — click to filter`}
                className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded tabular-nums transition-colors ${
                  active ? `bg-[#1e1e24] ${levelColor(lvl)}` : "text-[#4a4a52] hover:bg-[#1d1d22]"
                }`}
              >
                {counts[lvl]} {lvl}
              </button>
            );
          })}
        </div>

        {filtersActive && (
          <span className="text-[11px] text-[#6aa3e8]">{filtered.length} / {logs.length} shown</span>
        )}
        <div className="flex-1" />
        <button
          className="text-xs px-2 py-1 rounded hover:bg-[#1d1d22] text-[#8a8a92] hover:text-white disabled:opacity-40"
          onClick={copyAll}
          disabled={filtered.length === 0}
        >
          Copy
        </button>
        <button
          className="text-xs px-2 py-1 rounded hover:bg-[#1d1d22] text-[#8a8a92] hover:text-red-400 disabled:opacity-40 flex items-center gap-1"
          onClick={() => setConfirmClear(true)}
          disabled={logs.length === 0}
          title="Clear all logs"
        >
          <Trash2 size={12} /> Clear
        </button>
      </div>

      <div className="flex-1 relative min-h-0">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="absolute inset-0 overflow-auto font-mono text-xs p-2 bg-[#0e0e11]"
        >
          {filtered.length === 0 && (
            <div className="text-[#6a6a72]">
              {logs.length === 0 ? "No logs yet." : "No logs match the current filters."}
            </div>
          )}
          {filtered.map((l, i) => (
            <LogRow key={String(l.ts) + i} entry={l} tz={timezone} />
          ))}
        </div>

        {!following && (
          <button
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-[#1e3550] text-[#8fb6e8] border border-[#2c4a6e] shadow-lg hover:bg-[#263d5e]"
          >
            <ArrowDownToLine size={12} /> Jump to latest
          </button>
        )}
      </div>

      {confirmClear && (
        <Modal
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <button
                className="px-3 py-1.5 rounded text-xs text-[#8a8a92] hover:bg-[#2c2c33] hover:text-white"
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1.5 rounded text-xs bg-red-800 hover:bg-red-700 text-white"
                onClick={() => { clearLogs(); setConfirmClear(false); }}
              >
                Clear all
              </button>
            </>
          }
        >
          <p className="text-sm text-[#c8c8d0]">
            Clear all {logs.length} log {logs.length === 1 ? "entry" : "entries"}? This can't be undone.
          </p>
        </Modal>
      )}
    </div>
  );
}

function LogRow({ entry: l, tz }: { entry: LogEntry; tz: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const Icon = SOURCE_ICONS[l.source as keyof typeof SOURCE_ICONS] ?? Cog;

  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(formatLine(l, tz));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div
      className={`group flex items-start gap-2 px-1.5 py-0.5 rounded border-l-2 hover:bg-[#17171b] cursor-default ${levelBorder(l.level)}`}
      onClick={() => setExpanded((e) => !e)}
    >
      <span className="text-[#6a6a72] shrink-0 tabular-nums whitespace-nowrap w-[88px]">{formatClock(l.ts, tz)}</span>
      <span className={`shrink-0 rounded px-1 text-[10px] uppercase tracking-wide flex items-center gap-0.5 ${sourceBadge(l.source)}`}>
        <Icon size={9} />
        {l.source}
      </span>
      <span className={`shrink-0 rounded px-1 text-[10px] uppercase tracking-wide ${ACTIVITY_BADGE[l.kind]}`}>
        {ACTIVITY_LABELS[l.kind]}
      </span>
      <span className={`shrink-0 w-9 text-[10px] uppercase ${levelColor(l.level)}`}>{l.level}</span>
      {l.durationMs != null && (
        <span className={`shrink-0 rounded px-1 text-[10px] tabular-nums ${durationBadge(l.durationMs)}`}>
          {l.durationMs.toFixed(1)}ms
        </span>
      )}
      <span className={`flex-1 min-w-0 ${levelColor(l.level)} ${expanded ? "whitespace-pre-wrap break-all" : "truncate"}`}>
        {l.msg}
      </span>
      <button
        onClick={copy}
        title="Copy line"
        className="opacity-0 group-hover:opacity-100 shrink-0 text-[#6a6a72] hover:text-white"
      >
        {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
      </button>
    </div>
  );
}
