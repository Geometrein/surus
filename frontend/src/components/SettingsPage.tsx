import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Info, SquareTerminal } from "lucide-react";
import { api } from "../api/client";
import { useStore } from "../store";
import { browserTimezone } from "../utils";
import { SidebarPanel, SidebarHeader } from "./SidebarPanel";

// Every IANA timezone the runtime knows, with a small fallback for older engines.
const TIMEZONES: string[] = (() => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) return fn("timeZone");
  } catch { /* fall through */ }
  return [
    "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Kolkata", "Asia/Shanghai",
    "Asia/Tokyo", "Australia/Sydney",
  ];
})();

// ---------------------------------------------------------------------------
// Categories — each is a themed group in the left rail. New LLM providers or DB
// engines slot in as new rail entries (or provider cards) without disturbing the
// rest of the page.
// ---------------------------------------------------------------------------

interface Category {
  id: string;
  label: string;
  icon: React.ReactNode;
  render: () => React.ReactNode;
}

const CATEGORIES: Category[] = [
  { id: "agent", label: "Agent", icon: <Sparkles size={15} />, render: () => <AgentSettings /> },
  { id: "editor", label: "Editor", icon: <SquareTerminal size={15} />, render: () => <EditorSettings /> },
  { id: "about", label: "About", icon: <Info size={15} />, render: () => <AboutSettings /> },
];

// ---------------------------------------------------------------------------
// Sidebar — category list
// ---------------------------------------------------------------------------

export function SettingsSidebar() {
  const settingsCategory = useStore((s) => s.settingsCategory);
  const setSettingsCategory = useStore((s) => s.setSettingsCategory);

  return (
    <SidebarPanel>
      <SidebarHeader label="SETTINGS" />
      <div className="flex-1 overflow-auto min-h-0 px-1 pb-1">
        {CATEGORIES.map((c) => {
          const selected = c.id === settingsCategory;
          return (
            <button
              key={c.id}
              onClick={() => setSettingsCategory(c.id)}
              className={`w-full flex items-center gap-2 px-2 py-2 rounded mt-1 text-left text-[13px] transition-colors ${
                selected ? "bg-[#1e3550] text-white" : "text-[#a0a0a8] hover:bg-[#1d1d22] hover:text-white"
              }`}
            >
              <span className={selected ? "text-[#6aa3e8]" : "text-[#6a6a72]"}>{c.icon}</span>
              {c.label}
            </button>
          );
        })}
      </div>
    </SidebarPanel>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-[11px] font-bold tracking-wider text-[#6a6a72] uppercase mb-4 pb-2 border-b border-[#2c2c33]">
        {title}
      </h2>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

/** A Section whose body can be collapsed — for long/optional content. */
function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-10">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 mb-4 pb-2 border-b border-[#2c2c33] text-[11px] font-bold tracking-wider text-[#6a6a72] uppercase hover:text-[#a0a0a8] transition-colors"
      >
        <span className="text-[10px] w-3 text-left">{open ? "▾" : "▸"}</span>
        <span className="flex-1 text-left">{title}</span>
      </button>
      {open && <div className="space-y-5">{children}</div>}
    </section>
  );
}

function Field({ label, hint, children }: { label?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <label className="block text-sm text-[#c8c8d0] mb-1">{label}</label>}
      {hint && <p className="text-xs text-[#6a6a72] mb-2">{hint}</p>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const settingsCategory = useStore((s) => s.settingsCategory);
  const category = CATEGORIES.find((c) => c.id === settingsCategory) ?? CATEGORIES[0];

  return (
    <div className="h-full overflow-auto bg-[#131316]">
      <div className="max-w-2xl px-10 py-8">
        <h1 className="text-xl font-semibold mb-8">{category.label}</h1>
        {category.render()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent category
// ---------------------------------------------------------------------------

function AgentSettings() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });

  return (
    <>
      <Section title="Providers">
        {/* One card per provider — key stored per provider in the keychain. */}
        {(settings.data?.providers ?? []).map((p) => (
          <ProviderCard key={p.id} providerId={p.id} name={p.label} hasKey={p.hasKey} keyPlaceholder={p.keyPlaceholder} />
        ))}
      </Section>

      <Section title="Model">
        <DefaultModelField models={settings.data?.models ?? []} defaultModel={settings.data?.defaultModel ?? ""} />
      </Section>

      <CollapsibleSection title="System prompt">
        <SystemPromptField
          systemPrompt={settings.data?.systemPrompt ?? ""}
          savedInstructions={settings.data?.customInstructions ?? ""}
        />
      </CollapsibleSection>

      <Section title="Behavior">
        <AgentTimeoutField timeoutSec={settings.data?.agentTimeoutSec ?? 30} />
        <NumberSettingField
          label="Max agent steps"
          hint="How many tool-use round-trips the agent may take before it stops — each step is one model call plus a query. Higher lets it work through complex, multi-table questions; lower caps latency and token spend. A run that hits the ceiling stops with a note and keeps what it found. Default 12."
          value={settings.data?.agentMaxSteps ?? 12}
          min={2}
          max={50}
          onSave={api.setAgentMaxSteps}
        />
        <NumberSettingField
          label="Max response tokens"
          hint="Upper bound on tokens the model may generate per call — its reasoning plus the answer. Raise it if replies get cut off on large results; lower it to rein in cost and latency. This caps length, it doesn't reserve it. Default 16,000."
          value={settings.data?.agentMaxTokens ?? 16000}
          min={1000}
          max={64000}
          onSave={api.setAgentMaxTokens}
        />
      </Section>
    </>
  );
}

function ProviderCard({
  providerId,
  name,
  hasKey,
  keyPlaceholder,
}: {
  providerId: string;
  name: string;
  hasKey: boolean;
  keyPlaceholder: string;
}) {
  const qc = useQueryClient();
  const [keyInput, setKeyInput] = useState("");
  const [savedLabel, setSavedLabel] = useState(false);

  async function saveKey() {
    const key = keyInput.trim();
    if (!key) return;
    await api.setLlmKey(key, providerId);
    setKeyInput("");
    setSavedLabel(true);
    setTimeout(() => setSavedLabel(false), 2000);
    qc.invalidateQueries({ queryKey: ["settings"] });
  }

  return (
    <div className="border border-[#2c2c33] rounded-lg p-4 bg-[#161619]">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-[#e0e0e6]">{name}</span>
        {hasKey ? (
          <span className="text-xs text-emerald-500">✓ API key set</span>
        ) : (
          <span className="text-xs text-[#6a6a72]">No key</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") saveKey(); }}
          placeholder={keyPlaceholder}
          className="flex-1 bg-[#1b1b1f] border border-[#3a3a42] rounded px-3 py-1.5 text-sm outline-none focus:border-[#3b6fb5] font-mono"
        />
        <button
          onClick={saveKey}
          disabled={!keyInput.trim()}
          className="px-4 py-1.5 rounded bg-[#3b6fb5] hover:bg-[#4a7fc5] text-white text-sm disabled:opacity-40 transition-colors min-w-[80px]"
        >
          {savedLabel ? "Saved ✓" : "Save"}
        </button>
      </div>
      <p className="text-xs text-[#6a6a72] mt-2">
        {hasKey
          ? "A key is stored in the system keychain. Enter a new one to replace it."
          : "Stored in the system keychain — the agent won't work without one."}
      </p>
    </div>
  );
}

function DefaultModelField({ models, defaultModel }: { models: string[]; defaultModel: string }) {
  const qc = useQueryClient();
  if (models.length === 0) return null;
  return (
    <Field
      label="Default model"
      hint="Model used for new chats. Each chat can still be switched with the picker in the agent panel."
    >
      <select
        value={defaultModel}
        onChange={async (e) => {
          await api.setDefaultModel(e.target.value);
          qc.invalidateQueries({ queryKey: ["settings"] });
        }}
        className="bg-[#1b1b1f] border border-[#3a3a42] rounded px-3 py-1.5 text-sm outline-none focus:border-[#3b6fb5] text-[#c8c8d0] font-mono"
      >
        {models.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
    </Field>
  );
}

const AGENT_TIMEOUT_OPTIONS = [
  { label: "10 seconds", value: 10 },
  { label: "30 seconds", value: 30 },
  { label: "1 minute", value: 60 },
  { label: "2 minutes", value: 120 },
  { label: "5 minutes", value: 300 },
];

function AgentTimeoutField({ timeoutSec }: { timeoutSec: number }) {
  const qc = useQueryClient();

  async function save(sec: number) {
    await api.setAgentTimeout(sec);
    qc.invalidateQueries({ queryKey: ["settings"] });
  }

  return (
    <Field
      label="Agent query timeout"
      hint="Max time the agent's own EXPLAIN/sample queries may run before Postgres cancels them. Independent of the editor's query timeout; a cancelled query is reported back to the agent, which can retry a lighter one."
    >
      <select
        value={timeoutSec}
        onChange={(e) => save(Number(e.target.value))}
        className="bg-[#1b1b1f] border border-[#3a3a42] rounded px-3 py-1.5 text-sm outline-none focus:border-[#3b6fb5] text-[#c8c8d0]"
      >
        {AGENT_TIMEOUT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Field>
  );
}

/**
 * A bounded integer setting: number input + explicit Save. Re-syncs to the
 * persisted value when the settings query resolves, clamps to [min, max] on
 * save (the server clamps too), and shows a brief confirmation.
 */
function NumberSettingField({
  label, hint, value, min, max, onSave,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onSave: (n: number) => Promise<unknown>;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState(String(value));
  const [saved, setSaved] = useState(false);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setText(String(value));
  }

  const parsed = Math.round(Number(text));
  const dirty = Number.isFinite(parsed) && parsed !== value;

  async function save() {
    if (!dirty) return;
    await onSave(Math.max(min, Math.min(parsed, max)));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    qc.invalidateQueries({ queryKey: ["settings"] });
  }

  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <input
          type="number"
          min={min}
          max={max}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          className="w-32 bg-[#1b1b1f] border border-[#3a3a42] rounded px-3 py-1.5 text-sm outline-none focus:border-[#3b6fb5] text-[#c8c8d0] font-mono"
        />
        <button
          onClick={save}
          disabled={!dirty}
          className="px-4 py-1.5 rounded bg-[#3b6fb5] hover:bg-[#4a7fc5] text-white text-sm disabled:opacity-40 transition-colors min-w-[80px]"
        >
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>
    </Field>
  );
}

function SystemPromptField({
  systemPrompt,
  savedInstructions,
}: {
  systemPrompt: string;
  savedInstructions: string;
}) {
  const qc = useQueryClient();
  const [showBase, setShowBase] = useState(false);
  const [value, setValue] = useState(savedInstructions);
  const [saved, setSaved] = useState(false);

  // Sync the textarea once the query resolves (or the saved value changes).
  const [synced, setSynced] = useState(savedInstructions);
  if (savedInstructions !== synced) {
    setSynced(savedInstructions);
    setValue(savedInstructions);
  }

  const dirty = value.trim() !== savedInstructions.trim();

  async function save() {
    await api.setCustomInstructions(value);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    qc.invalidateQueries({ queryKey: ["settings"] });
  }

  return (
    <Field hint="The base prompt (tool method, read-only guardrail, output format) is fixed. Add your own instructions below — SQL style, domain context, or tone — and they're appended to it.">
      <button
        type="button"
        onClick={() => setShowBase((v) => !v)}
        className="text-xs text-[#6aa3e8] hover:underline mb-2"
      >
        {showBase ? "Hide" : "View"} fixed base prompt
      </button>
      {showBase && (
        <pre className="bg-[#1b1b1f] border border-[#2c2c33] rounded px-3 py-2 mb-3 text-[11px] leading-relaxed text-[#a0a0a8] whitespace-pre-wrap font-mono max-h-56 overflow-auto">
          {systemPrompt}
        </pre>
      )}
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={6}
        placeholder="e.g. Prefer CTEs over subqueries. Our fiscal year starts in April. Keep rationales to two sentences."
        className="w-full bg-[#1b1b1f] border border-[#3a3a42] rounded px-3 py-2 text-sm outline-none focus:border-[#3b6fb5] font-mono resize-y"
      />
      <div className="flex items-center gap-3 mt-2">
        <button
          onClick={save}
          disabled={!dirty}
          className="px-4 py-1.5 rounded bg-[#3b6fb5] hover:bg-[#4a7fc5] text-white text-sm disabled:opacity-40 transition-colors min-w-[80px]"
        >
          {saved ? "Saved ✓" : "Save"}
        </button>
        {value.trim() && (
          <button
            onClick={() => setValue("")}
            className="text-xs text-[#6a6a72] hover:text-[#c8c8d0]"
          >
            Clear
          </button>
        )}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Editor category — query behavior (engine-agnostic; applies to every connection)
// ---------------------------------------------------------------------------

const QUERY_TIMEOUT_OPTIONS = [
  { label: "30 seconds", value: 30 },
  { label: "1 minute", value: 60 },
  { label: "2 minutes", value: 120 },
  { label: "5 minutes", value: 300 },
  { label: "10 minutes", value: 600 },
];

function EditorSettings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const savedLimit = settings.data?.previewRowLimit ?? 200;

  const [limit, setLimit] = useState(String(savedLimit));
  const [saved, setSaved] = useState(false);
  // Re-sync the input when the query resolves or the saved value changes.
  const [synced, setSynced] = useState(savedLimit);
  if (savedLimit !== synced) {
    setSynced(savedLimit);
    setLimit(String(savedLimit));
  }

  async function saveTimeout(sec: number) {
    await api.setQueryTimeout(sec);
    qc.invalidateQueries({ queryKey: ["settings"] });
  }
  async function saveLimit() {
    const n = Math.round(Number(limit));
    if (!Number.isFinite(n) || n < 1) return;
    await api.setPreviewRowLimit(n);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    qc.invalidateQueries({ queryKey: ["settings"] });
  }

  const dirty = Math.round(Number(limit)) !== savedLimit;

  return (
    <>
    <Section title="Queries">
      <Field
        label="Query timeout"
        hint="Max time an editor query may run before it's cancelled. Applies to the connection pool, so it takes effect the next time you connect."
      >
        <select
          value={settings.data?.queryTimeoutSec ?? 120}
          onChange={(e) => saveTimeout(Number(e.target.value))}
          className="bg-[#1b1b1f] border border-[#3a3a42] rounded px-3 py-1.5 text-sm outline-none focus:border-[#3b6fb5] text-[#c8c8d0]"
        >
          {QUERY_TIMEOUT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Field>

      <Field
        label="Preview row limit"
        hint="Max rows an editor query returns. Results beyond this are marked truncated; the full query still runs on the server."
      >
        <div className="flex gap-2">
          <input
            type="number"
            min={1}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveLimit(); }}
            className="w-32 bg-[#1b1b1f] border border-[#3a3a42] rounded px-3 py-1.5 text-sm outline-none focus:border-[#3b6fb5] text-[#c8c8d0] font-mono"
          />
          <button
            onClick={saveLimit}
            disabled={!dirty}
            className="px-4 py-1.5 rounded bg-[#3b6fb5] hover:bg-[#4a7fc5] text-white text-sm disabled:opacity-40 transition-colors min-w-[80px]"
          >
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </Field>
    </Section>

    <DisplaySettings />
    </>
  );
}

function DisplaySettings() {
  const timezone = useStore((s) => s.timezone);
  const setTimezone = useStore((s) => s.setTimezone);
  return (
    <Section title="Display">
      <Field
        label="Timezone"
        hint="How timestamps (chat history, logs) are shown. Automatic follows your computer's timezone."
      >
        <select
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="bg-[#1b1b1f] border border-[#3a3a42] rounded px-3 py-1.5 text-sm outline-none focus:border-[#3b6fb5] text-[#c8c8d0] max-w-xs"
        >
          <option value="">Automatic ({browserTimezone()})</option>
          {TIMEZONES.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
      </Field>
    </Section>
  );
}


// ---------------------------------------------------------------------------
// About category
// ---------------------------------------------------------------------------

function AboutSettings() {
  return (
    <Section title="About">
      <Field label="Application">
        <div className="text-sm text-[#c8c8d0]">Surus</div>
      </Field>
      <Field label="Description">
        <p className="text-sm text-[#c8c8d0] leading-relaxed">
          Agentic PostgreSQL client that prioritizes query performance and data
          safety.
        </p>
      </Field>
      <Field label="Author">
        <a
          href="https://github.com/Geometrein"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-[#6aa3e8] hover:underline"
        >
          Geometrein
        </a>
      </Field>
    </Section>
  );
}
