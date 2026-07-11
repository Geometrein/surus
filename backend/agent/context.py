"""Build the schema/stats context the agent reasons over.

This is rendered once per connection and sent as a cached system block, so the
(potentially large) schema is only billed at full price on the first turn and
served from cache on subsequent turns within a conversation.

The data comes from the same ``Dialect.build_snapshot`` pipeline the UI uses
(with ``sizes=True`` so the "largest tables" note costs no extra query); this
module only renders it to text.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from backend.db.dialects.base import Dialect
    from backend.db.extensions import ExtensionPlugin
    from backend.db.introspect import Table


def build_context(
    dialect: "Dialect",
    pool: Any,
    plugins: "list[ExtensionPlugin] | None" = None,
) -> str:
    """The full agent context (schema + size note) from one snapshot build."""
    snap = dialect.build_snapshot(pool, plugins=plugins, sizes=True)
    schema = build_schema_context(snap.tables)
    stats = build_stats_context(snap.tables)
    return schema + ("\n\n" + stats if stats else "")


def build_schema_context(tables: "list[Table]", max_tables_detailed: int = 60) -> str:
    """Render a compact textual description of the database for the agent."""
    lines: list[str] = ["# Database schema", ""]

    detailed = tables[:max_tables_detailed]
    for t in detailed:
        cols = ", ".join(
            f"{c.name} {c.data_type}{'' if c.nullable else ' NOT NULL'}"
            f"{' PK' if c.is_pk else ''}"
            for c in t.columns
        )
        lines.append(f"## {t.qualified}  (~{t.row_estimate:,} rows, {t.kind})")
        lines.append(f"columns: {cols}")
        if t.foreign_keys:
            fks = "; ".join(
                f"{fk.column} -> {fk.ref_schema}.{fk.ref_table}.{fk.ref_column}"
                for fk in t.foreign_keys
            )
            lines.append(f"foreign keys: {fks}")
        if t.indexes:
            idxs = "; ".join(i.name for i in t.indexes)
            lines.append(f"indexes: {idxs}")
        lines.append("")

    if len(tables) > len(detailed):
        rest = ", ".join(t.qualified for t in tables[len(detailed):])
        lines.append(f"## Other tables (use inspect_schema for detail): {rest}")
        lines.append("")

    return "\n".join(lines)


def _human_bytes(n: int) -> str:
    """Compact human-readable size, roughly matching Postgres' pg_size_pretty."""
    step = 1024.0
    value = float(n)
    for unit in ("bytes", "kB", "MB", "GB", "TB"):
        if value < step or unit == "TB":
            return f"{int(value)} bytes" if unit == "bytes" else f"{value:.1f} {unit}"
        value /= step
    return f"{value:.1f} PB"  # unreachable; keeps type-checkers happy


def build_stats_context(tables: "list[Table]") -> str:
    """A short note on the largest tables, to help reason about performance.

    Derived from the sizes already carried on ``tables`` (the snapshot was
    built with ``sizes=True``), so it costs no additional query.
    """
    sized = sorted(
        (t for t in tables if t.total_bytes > 0),
        key=lambda t: t.total_bytes,
        reverse=True,
    )[:10]
    if not sized:
        return ""
    lines = ["# Largest tables (for performance reasoning)"]
    for t in sized:
        lines.append(f"- {t.schema}.{t.name}: {_human_bytes(t.total_bytes)}, ~{t.row_estimate:,} rows")
    return "\n".join(lines)
