/**
 * Shared pill-style toggle switch.
 * Used by SchemaDiagramPage (ToggleRow) and Sidebar (Toggle).
 *
 * - `on`       current checked state
 * - `onClick`  called when the button is clicked
 * - `label`    optional visible label; if omitted renders the bare switch
 * - `busy`     disables the control while an async action is pending
 */
export function ToggleSwitch({
  on,
  onClick,
  label,
  busy,
}: {
  on: boolean;
  onClick: () => void;
  label?: string;
  busy?: boolean;
}) {
  const pill = (
    <span
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-emerald-500/80" : "bg-[#3a3a42]"
      }`}
    >
      <span
        className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
          on ? "translate-x-[14px]" : "translate-x-[2px]"
        }`}
      />
    </span>
  );

  if (!label) {
    return (
      <button
        role="switch"
        aria-checked={on}
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        title={on ? "Connected — click to disconnect" : "Disconnected — click to connect"}
        className="disabled:opacity-50"
      >
        {pill}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`w-full flex items-center justify-between px-2 py-1 rounded text-xs transition-colors ${
        on ? "bg-[#1e3550] text-white" : "text-[#6a6a72] hover:bg-[#1d1d22] hover:text-[#a0a0a8]"
      } disabled:opacity-50`}
    >
      <span>{label}</span>
      {pill}
    </button>
  );
}
