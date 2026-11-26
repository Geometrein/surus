import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Table2, Eye, Layers, KeyRound, Link2, Copy, ExternalLink } from "lucide-react";
import { api, type TableRef } from "../api/client";
import { useStore } from "../store";
import { formatCount } from "../utils";
import { cssVar } from "../lib/theme";
import { previewTableSql } from "../lib/sql";
import { useActiveKind } from "../hooks/useActiveKind";

// Relkind -> icon / colour / short badge. Each relation kind gets its own hue so
// tables, views, and matviews are distinguishable at a glance — distinct from
// the schema's database icon above them and the key/link markers on columns below.
const KIND_ICON: Record<string, React.ElementType> = {
  table: Table2,
  view: Eye,
  matview: Layers,
};
const KIND_COLOR: Record<string, string> = {
  table: "text-accent-text",   // light blue
  view: "text-kind-view",    // teal
  matview: "text-warning-soft", // gold
};
const KIND_BADGE: Record<string, string> = { view: "view", matview: "mat" };

// Postgres type -> broad category colour. Columns are the densest level, so we
// tint the type text by category (text / number / temporal / boolean / json /
// uuid-binary / geometry) rather than giving every dtype its own icon — a
// low-noise, fast-scannable cue that leaves the key/relationship marker intact.
// ClickHouse wraps types in modifiers that don't change what kind of value the
// column holds: Nullable(T), LowCardinality(T), SimpleAggregateFunction(f, T).
function unwrapType(type: string): string {
  let t = type.trim();
  for (;;) {
    const m =
      t.match(/^(?:Nullable|LowCardinality)\((.*)\)$/i) ??
      t.match(/^SimpleAggregateFunction\(\w+,\s*(.*)\)$/i);
    if (!m) return t;
    t = m[1].trim();
  }
}

function typeColor(type: string): string {
  const t = unwrapType(type).toLowerCase().replace(/\(.*\)/, "").trim();
  if (t.endsWith("[]") || /^(json|jsonb|xml|hstore|array|map|tuple|nested|object)/.test(t)) return cssVar("type-collection"); // collections / json — orange
  if (/(geometry|geography)/.test(t)) return cssVar("type-geo");                              // postgis — pink
  if (/^bool/.test(t)) return cssVar("type-bool");                                             // boolean — violet
  if (/^(date|time|timestamp|interval)/.test(t)) return cssVar("type-time");                   // temporal — amber
  if (/^(smallint|integer|bigint|u?int\d*|serial|bigserial|smallserial|decimal|numeric|real|double|float\d*|money)/.test(t))
    return cssVar("type-number");                                                                // number — cyan
  if (/^(text|varchar|char|character|citext|name|bpchar|string|fixedstring|enum)/.test(t)) return cssVar("type-text"); // text — green
  if (/^(uuid|bytea|inet|cidr|macaddr|bit|ipv4|ipv6)/.test(t)) return cssVar("type-id");     // uuid / binary / network — slate
  return cssVar("muted");                                                                  // other — grey
}

/** Down/right carets — same glyphs the editor sidebar uses for folders. */
function Caret({ open }: { open: boolean }) {
  return (
    <span className="text-muted w-3 shrink-0 flex items-center">
      {open
        ? <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M1 3l4 4 4-4H1z" /></svg>
        : <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l4 4-4 4V1z" /></svg>}
    </span>
  );
}

export function SchemaTree({ search = "", hiddenSchemas = new Set<string>() }: { search?: string; hiddenSchemas?: Set<string> }) {
  const { activeConnectionId, openTab, log } = useStore();
  const kind = useActiveKind();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [openTables, setOpenTables] = useState<Set<string>>(new Set());

  const schema = useQuery({
    queryKey: ["schema", activeConnectionId],
    queryFn: () => api.schema(activeConnectionId!),
    enabled: !!activeConnectionId,
  });

  if (!activeConnectionId)
    return <div className="px-3 text-xs text-muted">Not connected</div>;
  if (schema.isLoading)
    return <div className="px-3 text-xs text-muted">Loading…</div>;
  if (schema.error)
    return <div className="px-3 text-xs text-red-400">{(schema.error as Error).message}</div>;

  function preview(s: string, t: string) {
    log("info", `preview ${s}.${t}`);
    openTab(t, previewTableSql(kind, s, t), true, `table:${s}.${t}`);
  }

  function toggleTable(key: string) {
    setOpenTables((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const term = search.toLowerCase();

  return (
    <div className="text-[13px]">
      {schema.data?.schemas.filter((sc) => !hiddenSchemas.has(sc.name)).map((sc) => {
        const tables = term
          ? sc.tables.filter((t) => t.name.toLowerCase().includes(term))
          : sc.tables;
        if (term && tables.length === 0) return null;
        const isCollapsed = collapsed[sc.name] && !term;
        return (
          <div key={sc.name}>
            <div
              className="px-2 py-1 cursor-pointer text-strong hover:bg-hover rounded flex items-center gap-1.5"
              onClick={() => setCollapsed((c) => ({ ...c, [sc.name]: !c[sc.name] }))}
            >
              <Caret open={!isCollapsed} />
              <Database size={13} className="text-agent shrink-0" />
              <span className="flex-1 truncate font-medium">{sc.name}</span>
              <span className="text-[11px] text-muted shrink-0 tabular-nums">{tables.length}</span>
            </div>
            {!isCollapsed &&
              tables.map((t) => {
                const key = `${t.schema}.${t.name}`;
                const isOpen = openTables.has(key);
                return (
                  <TableRow
                    key={key}
                    table={t}
                    open={isOpen}
                    connectionId={activeConnectionId}
                    onToggle={() => toggleTable(key)}
                    onPreview={() => preview(t.schema, t.name)}
                  />
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

function TableRow({
  table,
  open,
  connectionId,
  onToggle,
  onPreview,
}: {
  table: TableRef;
  open: boolean;
  connectionId: string;
  onToggle: () => void;
  onPreview: () => void;
}) {
  const Icon = KIND_ICON[table.kind] ?? Table2;
  const iconColor = KIND_COLOR[table.kind] ?? "text-accent-text";
  const badge = KIND_BADGE[table.kind];

  return (
    <div>
      <div
        className="group flex items-center gap-1 pl-4 pr-2 py-1 rounded hover:bg-hover cursor-pointer"
        onClick={onToggle}
        onDoubleClick={onPreview}
        title={`${table.schema}.${table.name}`}
      >
        <Caret open={open} />
        <Icon size={13} className={`${iconColor} shrink-0`} />
        <span className="flex-1 truncate">{table.name}</span>
        {badge && (
          <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted bg-raised-hover rounded px-1 py-px leading-none">
            {badge}
          </span>
        )}
        {/* Approximate row estimate (pg reltuples), compact like the ERD cards;
            swaps to actions on hover. Full value in the title for the curious. */}
        <span
          className="text-[11px] text-muted shrink-0 group-hover:hidden tabular-nums"
          title={`~${table.rowEstimate.toLocaleString()} rows (estimate)`}
        >
          ~{formatCount(table.rowEstimate)}
        </span>
        <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button
            className="text-muted hover:text-white p-0.5 rounded"
            title="Preview rows in editor"
            onClick={(e) => { e.stopPropagation(); onPreview(); }}
          >
            <ExternalLink size={12} />
          </button>
          <button
            className="text-muted hover:text-white p-0.5 rounded"
            title="Copy qualified name"
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(`"${table.schema}"."${table.name}"`);
            }}
          >
            <Copy size={12} />
          </button>
        </div>
      </div>
      {open && <ColumnList connectionId={connectionId} schema={table.schema} table={table.name} />}
    </div>
  );
}

function ColumnList({ connectionId, schema, table }: { connectionId: string; schema: string; table: string }) {
  const detail = useQuery({
    queryKey: ["tableDetail", connectionId, schema, table],
    queryFn: () => api.tableDetail(connectionId, schema, table),
    staleTime: 5 * 60 * 1000,
  });

  if (detail.isLoading)
    return <div className="pl-9 py-1 text-[11px] text-muted">Loading columns…</div>;
  if (detail.error)
    return <div className="pl-9 py-1 text-[11px] text-red-400">{(detail.error as Error).message}</div>;

  const fkColumns = new Set((detail.data?.foreignKeys ?? []).map((fk) => fk.column));
  const fkTarget = new Map((detail.data?.foreignKeys ?? []).map((fk) => [fk.column, fk.references]));

  return (
    <div className="pb-0.5">
      {detail.data?.columns.map((c) => (
        <div
          key={c.name}
          className="group flex items-center gap-1.5 pl-9 pr-2 py-0.5 hover:bg-hover rounded"
          title={c.default ? `default: ${c.default}` : undefined}
        >
          {c.isPk ? (
            <KeyRound size={11} className="text-amber-400/80 shrink-0" />
          ) : fkColumns.has(c.name) ? (
            <span className="shrink-0 flex items-center" title={`→ ${fkTarget.get(c.name)}`}>
              <Link2 size={11} className="text-accent-text/80" />
            </span>
          ) : (
            <span className="w-[11px] shrink-0 flex items-center justify-center">
              <span className="w-[3px] h-[3px] rounded-full bg-dim" />
            </span>
          )}
          <span className={`truncate ${c.isPk ? "text-strong" : "text-body"}`}>{c.name}</span>
          {!c.nullable && <span className="text-[9px] text-muted shrink-0">NN</span>}
          <span className="flex-1" />
          <span className="text-[11px] font-mono shrink-0 truncate max-w-[45%]" style={{ color: typeColor(c.type) }}>{c.type}</span>
        </div>
      ))}
      {detail.data?.columns.length === 0 && (
        <div className="pl-9 py-1 text-[11px] text-muted">No columns.</div>
      )}
    </div>
  );
}
