import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check } from "lucide-react";
import { api, type Connection, type ConnectionInput } from "../api/client";
import { shortVersion } from "../utils";

const field = "w-full bg-[#1b1b1f] border border-[#3a3a42] rounded px-2 py-1.5 mt-1 text-[13px] outline-none focus:border-[#4a6da8]";
const label = "text-xs text-[#8a8a92] mt-3 block";

// Fixed, muted palette tuned to the dark UI. "" = no color.
const COLORS = ["#c2554f", "#c47f3d", "#b9a23f", "#4f9d63", "#3a9a92", "#4a7fc5", "#8266c4", "#b85e94"];

type TestState = { ok: boolean; msg: string } | null;
type Auth = "password" | "certificate";

// With a client certificate the connection is always encrypted, so "prefer"
// and "disable" are not offered.
const CERT_SSL_MODES = ["require", "verify-ca", "verify-full"];

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
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-96 bg-[#1f1f24] border border-[#2c2c33] rounded-lg p-4 shadow-xl">
          <Dialog.Title className="text-base font-semibold">
            {edit ? "Edit connection" : "New connection"}
          </Dialog.Title>
          <label className={label}>Name</label>
          <input className={field} value={form.name} onChange={(e) => set("name", e.target.value)} />

          <label className={label}>Color</label>
          <div className="flex items-center gap-2 mt-1.5">
            <ColorSwatch value="" selected={form.color === ""} onClick={() => set("color", "")} />
            {COLORS.map((c) => (
              <ColorSwatch key={c} value={c} selected={form.color === c} onClick={() => set("color", c)} />
            ))}
          </div>

          <label className={label}>Host</label>
          <input className={field} value={form.host} onChange={(e) => set("host", e.target.value)} />
          <label className={label}>Port</label>
          <input
            className={field}
            type="number"
            value={form.port}
            onChange={(e) => set("port", Number(e.target.value))}
          />
          <label className={label}>Database</label>
          <input className={field} value={form.dbname} onChange={(e) => set("dbname", e.target.value)} />
          <label className={label}>User</label>
          <input className={field} value={form.user} onChange={(e) => set("user", e.target.value)} />
          <label className={label}>Login with</label>
          <div className="flex gap-1 mt-1">
            {(["password", "certificate"] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAuth(a)}
                className={`flex-1 px-2 py-1 rounded text-[13px] border ${
                  auth === a
                    ? "border-[#4a6da8] bg-[#24304a] text-white"
                    : "border-[#3a3a42] text-[#a0a0a8] hover:bg-[#1d1d22]"
                }`}
              >
                {a === "password" ? "Password" : "Client certificate"}
              </button>
            ))}
          </div>

          {auth === "password" ? (
            <>
              <label className={label}>Password</label>
              <input
                className={field}
                type="password"
                placeholder={edit ? "(unchanged)" : ""}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
              />
            </>
          ) : (
            <>
              <label className={label}>Certificate file</label>
              <input
                className={field}
                placeholder="~/.postgresql/postgresql.crt"
                value={form.ssl_cert}
                onChange={(e) => set("ssl_cert", e.target.value)}
              />
              <label className={label}>Key file</label>
              <input
                className={field}
                placeholder="~/.postgresql/postgresql.key"
                value={form.ssl_key}
                onChange={(e) => set("ssl_key", e.target.value)}
              />
              <label className={label}>Server certificate or CA (optional)</label>
              <input
                className={field}
                placeholder="Checks the server is the one you expect"
                value={form.ssl_root_cert}
                onChange={(e) => set("ssl_root_cert", e.target.value)}
              />
              <label className={label}>SSL mode</label>
              <select
                className={field}
                value={CERT_SSL_MODES.includes(form.sslmode) ? form.sslmode : "require"}
                onChange={(e) => set("sslmode", e.target.value)}
              >
                {CERT_SSL_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </>
          )}

          {err && <div className="text-red-400 text-xs mt-3">{err}</div>}
          {test && (
            <div className={`text-xs mt-3 ${test.ok ? "text-emerald-400" : "text-red-400"}`}>
              {test.ok ? `✓ Connected — ${test.msg}` : test.msg}
            </div>
          )}

          <div className="flex items-center gap-2 mt-4">
            <button
              className="px-3 py-1.5 rounded text-[#a0a0a8] border border-[#3a3a42] hover:bg-[#1d1d22] disabled:opacity-50"
              onClick={runTest}
              disabled={testing || busy}
            >
              {testing ? "Testing…" : "Test"}
            </button>
            <div className="flex-1" />
            <button className="px-3 py-1.5 rounded text-[#a0a0a8] hover:bg-[#1d1d22]" onClick={onClose}>
              Cancel
            </button>
            <button
              className="px-3 py-1.5 rounded bg-[#3b6fb5] hover:bg-[#4a7fc5] text-white disabled:opacity-50"
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

function ColorSwatch({ value, selected, onClick }: { value: string; selected: boolean; onClick: () => void }) {
  const none = value === "";
  return (
    <button
      type="button"
      onClick={onClick}
      title={none ? "No color" : value}
      className={`h-5 w-5 rounded-full flex items-center justify-center transition-transform hover:scale-110 ${
        none ? "border border-dashed border-[#5a5a62]" : ""
      } ${selected ? "ring-2 ring-offset-2 ring-offset-[#1f1f24] ring-white/70" : ""}`}
      style={none ? undefined : { backgroundColor: value }}
    >
      {selected && !none && <Check size={12} className="text-white drop-shadow" />}
    </button>
  );
}


