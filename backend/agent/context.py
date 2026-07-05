"""Build the schema/stats context the agent reasons over.

This is rendered once per connection and sent as a cached system block, so the
(potentially large) schema is only billed at full price on the first turn and
served from cache on subsequent turns within a conversation.

The whole context is assembled in 4 catalog queries via :func:`build_context`:
``list_tables`` (names/sizes/row-estimates) + one batched columns/FK/index
introspection. The "largest tables" note is derived from the sizes already
returned by ``list_tables`` — no extra query.
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
    """The full agent context (schema + size note) in one place.

    Fetches the table list once and shares it between the schema description and
    the size note, so the note costs no extra query.
    """
    tables = dialect.list_tables(pool, plugins=plugins)
    schema = build_schema_context(dialect, pool, tables=tables)
    stats = build_stats_context(tables)
    return schema + ("\n\n" + stats if stats else "")


def build_schema_context(
    dialect: "Dialect",
    pool: Any,
    max_tables_detailed: int = 60,
    plugins: "list[ExtensionPlugin] | None" = None,
    tables: "list[Table] | None" = None,
) -> str:
    """Render a compact textual description of the database for the agent.

    Pass ``tables`` to reuse an already-fetched table list (see
    :func:`build_context`); otherwise it is fetched here.
    """
    if tables is None:
        tables = dialect.list_tables(pool, plugins=plugins)
    # One batched introspection instead of a per-table query fan-out (N+1).
    try:
        details = dialect.list_all_table_details(pool)
    except Exception:  # noqa: BLE001 - degrade to names-only rather than fail the turn
        details = {}
    lines: list[str] = ["# Database schema", ""]

    detailed = tables[:max_tables_detailed]
    for t in detailed:
        detail = details.get((t.schema, t.name))
        if detail is None:
            continue
        cols = ", ".join(
            f"{c.name} {c.data_type}{'' if c.nullable else ' NOT NULL'}"
            f"{' PK' if c.is_pk else ''}"
            for c in detail.columns
        )
        # Row estimate / kind come from list_tables; structure from the batch.
        lines.append(f"## {t.qualified}  (~{t.row_estimate:,} rows, {t.kind})")
        lines.append(f"columns: {cols}")
        if detail.foreign_keys:
            fks = "; ".join(
                f"{fk.column} -> {fk.ref_schema}.{fk.ref_table}.{fk.ref_column}"
                for fk in detail.foreign_keys
            )
            lines.append(f"foreign keys: {fks}")
        if detail.indexes:
            idxs = "; ".join(i.name for i in detail.indexes)
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

    Derived from the sizes already carried on ``tables`` (from ``list_tables``),
    so it costs no additional query.
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
