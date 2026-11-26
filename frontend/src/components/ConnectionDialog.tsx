import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check } from "lucide-react";
import { api, type Connection, type ConnectionInput, type DatabaseKind } from "../api/client";
import { shortVersion } from "../utils";
import { CONNECTION_COLORS, connectionColor } from "../lib/theme";

const field = "w-full bg-panel border border-line-strong rounded px-2 py-1.5 mt-1 text-[13px] outline-none focus:border-accent-focus";
const label = "text-xs text-subtle block";
const section = "text-[11px] font-semibold tracking-wider uppercase text-muted mb-2";


type TestState = { ok: boolean; msg: string } | null;
type Auth = "password" | "certificate";

// With a client certificate the connection is always encrypted, so "prefer"
// and "disable" are not offered.
const CERT_SSL_MODES = ["require", "verify-ca", "verify-full"];
const PASSWORD_SSL_MODES = ["disable", "prefer", ...CERT_SSL_MODES];

// Defaults that follow the engine when it is switched, unless already edited.
const ENGINE_DEFAULTS: Record<DatabaseKind, { label: string; port: number; dbname: string; user: string }> = {
  postgres: { label: "PostgreSQL", port: 5432, dbname: "postgres", user: "postgres" },
  clickhouse: { label: "ClickHouse", port: 8443, dbname: "default", user: "default" },
};

export function ConnectionDialog({
  edit,
  onClose,
  onSaved,
}: {
  edit?: Connection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ConnectionInput>({
    name: edit?.name ?? "New connection",
    kind: edit?.kind ?? "postgres",
    host: edit?.host ?? "localhost",
    port: edit?.port ?? 5432,
    dbname: edit?.dbname ?? "postgres",
    user: edit?.user ?? "postgres",
    password: "",
    sslmode: edit?.sslmode ?? "prefer",
    ssl_cert: edit?.ssl_cert ?? "",
    ssl_key: edit?.ssl_key ?? "",
    ssl_root_cert: edit?.ssl_root_cert ?? "",
    color: edit?.color ?? "",
  });
  const [auth, setAuth] = useState<Auth>(edit?.ssl_cert ? "certificate" : "password");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestState>(null);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: keyof ConnectionInput, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  function setKind(kind: DatabaseKind) {
    setForm((f) => {
      const from = ENGINE_DEFAULTS[f.kind];
      const to = ENGINE_DEFAULTS[kind];
      return {
        ...f,
        kind,
        port: f.port === from.port ? to.port : f.port,
        dbname: f.dbname === from.dbname ? to.dbname : f.dbname,
        user: f.user === from.user ? to.user : f.user,
      };
    });
  }

  // Only the fields of the chosen login method are sent, so switching back to
  // a password clears the certificate paths instead of keeping them silently.
  function payload(): ConnectionInput {
    if (auth === "password") return { ...form, ssl_cert: "", ssl_key: "", ssl_root_cert: "" };
    const sslmode = CERT_SSL_MODES.includes(form.sslmode) ? form.sslmode : "require";
    return { ...form, password: "", sslmode };
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    setErr(null);
    try {
      const res = await api.testConnection(payload(), edit?.id);
      setTest({ ok: true, msg: shortVersion(res.version) });
    } catch (e) {
      setTest({ ok: false, msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      if (edit) await api.updateConnection(edit.id, payload());
      else await api.createConnection(payload());
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[768px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-auto bg-raised border border-line rounded-lg shadow-xl">
          <div className="px-5 pt-4">
            <Dialog.Title className="text-base font-semibold">
              {edit ? "Edit connection" : "New connection"}
            </Dialog.Title>
          </div>

          <Tabs
            className="px-5 mt-3"
            value={form.kind}
            onChange={setKind}
            options={(Object.keys(ENGINE_DEFAULTS) as DatabaseKind[]).map((k) => ({
              value: k,
              label: ENGINE_DEFAULTS[k].label,
            }))}
          />

          <div className="px-5 py-4 space-y-5">
            <div className="grid grid-cols-[1fr_auto] gap-x-6 items-end">
              <Field label="Name">
                <input className={field} value={form.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              {/* Not a <label>: a label passes stray clicks on to its first button. */}
              <div>
                <span className={label}>Color</span>
                <div className="flex items-center gap-2 h-[34px]">
                  <ColorSwatch value="" selected={form.color === ""} onClick={() => set("color", "")} />
                  {CONNECTION_COLORS.map((c) => (
                    <ColorSwatch key={c} value={c} selected={form.color === c} onClick={() => set("color", c)} />
                  ))}
                </div>
              </div>
            </div>

            <section>
              <h3 className={section}>Server</h3>
              <div className="grid grid-cols-[1fr_140px] gap-x-4 gap-y-3">
                <Field label="Host">
                  <input className={field} value={form.host} onChange={(e) => set("host", e.target.value)} />
                </Field>
                <Field label="Port">
                  <input
                    className={field}
                    type="number"
                    value={form.port}
                    onChange={(e) => set("port", Number(e.target.value))}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-x-4 mt-3">
                <Field label="Database">
                  <input className={field} value={form.dbname} onChange={(e) => set("dbname", e.target.value)} />
                </Field>
                <Field label="User">
                  <input className={field} value={form.user} onChange={(e) => set("user", e.target.value)} />
                </Field>
              </div>
            </section>

            <section>
              <h3 className={section}>Authentication</h3>
              <Tabs
                value={auth}
                onChange={setAuth}
                options={[
                  { value: "password", label: "Password" },
                  { value: "certificate", label: "Client certificate" },
                ]}
              />
              {auth === "password" ? (
                <div className="grid grid-cols-2 gap-x-4 mt-3">
                  <Field label="Password">
                    <input
                      className={field}
                      type="password"
                      placeholder={edit ? "(unchanged)" : ""}
                      value={form.password}
                      onChange={(e) => set("password", e.target.value)}
                    />
                  </Field>
                  <Field label="SSL mode">
                    <SslModeSelect value={form.sslmode} modes={PASSWORD_SSL_MODES} onChange={(m) => set("sslmode", m)} />
                  </Field>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-3">
                  <Field label="Certificate file">
                    <input
                      className={field}
                      placeholder="e.g. ~/certs/client.crt"
                      value={form.ssl_cert}
                      onChange={(e) => set("ssl_cert", e.target.value)}
                    />
                  </Field>
                  <Field label="Key file">
                    <input
                      className={field}
                      placeholder="e.g. ~/certs/client.key"
                      value={form.ssl_key}
                      onChange={(e) => set("ssl_key", e.target.value)}
                    />
                  </Field>
                  <Field label="Server certificate or CA (optional)">
                    <input
                      className={field}
                      placeholder="Checks the server is the one you expect"
                      value={form.ssl_root_cert}
                      onChange={(e) => set("ssl_root_cert", e.target.value)}
                    />
                  </Field>
                  <Field label="SSL mode">
                    <SslModeSelect
                      value={CERT_SSL_MODES.includes(form.sslmode) ? form.sslmode : "require"}
                      modes={CERT_SSL_MODES}
                      onChange={(m) => set("sslmode", m)}
                    />
                  </Field>
                </div>
              )}
            </section>

            {err && <div className="text-red-400 text-xs">{err}</div>}
            {test && (
              <div className={`text-xs ${test.ok ? "text-emerald-400" : "text-red-400"}`}>
                {test.ok ? `✓ Connected — ${test.msg}` : test.msg}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 px-5 py-3 border-t border-line">
            <button
              className="px-3 py-1.5 rounded text-soft border border-line-strong hover:bg-hover disabled:opacity-50"
              onClick={runTest}
              disabled={testing || busy}
            >
              {testing ? "Testing…" : "Test"}
            </button>
            <div className="flex-1" />
            <button className="px-3 py-1.5 rounded text-soft hover:bg-hover" onClick={onClose}>
              Cancel
            </button>
            <button
              className="px-3 py-1.5 rounded bg-accent hover:bg-accent-hover text-white disabled:opacity-50"
              onClick={save}
              disabled={busy}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label: text, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className={label}>{text}</span>
      {children}
    </label>
  );
}

function Tabs<T extends string>({
  value,
  options,
  onChange,
  className = "",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={`flex gap-1 border-b border-line ${className}`}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`px-3 py-2 -mb-px text-[13px] border-b-2 transition-colors ${
              active ? "border-accent-text text-strong" : "border-transparent text-subtle hover:text-body"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SslModeSelect({ value, modes, onChange }: { value: string; modes: string[]; onChange: (mode: string) => void }) {
  return (
    <select className={field} value={value} onChange={(e) => onChange(e.target.value)}>
      {modes.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

function ColorSwatch({ value, selected, onClick }: { value: string; selected: boolean; onClick: () => void }) {
  const none = value === "";
  return (
    <button
      type="button"
      onClick={onClick}
      title={none ? "No color" : value}
      className={`h-5 w-5 rounded-full flex items-center justify-center transition-transform hover:scale-110 ${
        none ? "border border-dashed border-dim" : ""
      } ${selected ? "ring-2 ring-offset-2 ring-offset-raised ring-white/70" : ""}`}
      style={none ? undefined : { backgroundColor: connectionColor(value) }}
    >
      {selected && !none && <Check size={12} className="text-white drop-shadow" />}
    </button>
  );
}
