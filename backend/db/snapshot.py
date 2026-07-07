"""Catalog snapshot for the ERD and schema tree.

Reads table/column/FK metadata in a single pool connection and caches the
result on the Database handle. On-disk sizes are deliberately *excluded*:
``pg_total_relation_size`` stats every file backing every relation and is by far
the most expensive part of introspection, so it is fetched on demand via
:func:`table_sizes` (the ERD's "sizes" toggle) rather than baked into the cached
snapshot. The agent is likewise excluded — it needs live data and has its own
context-building pipeline.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from psycopg.rows import dict_row

from backend.db.introspect import SCHEMA_FILTER, estimate_view_rows

if TYPE_CHECKING:
    from backend.db.extensions import ExtensionPlugin


@dataclass
class SnapshotTable:
    schema: str
    name: str
    kind: str
    row_estimate: int
    columns: list[dict] = field(default_factory=list)
    fk_columns: set[str] = field(default_factory=set)


@dataclass
class Snapshot:
    sampled_at: float
    tables: list[SnapshotTable]
    edges: list[dict]


def _filter_clause(plugins: list[ExtensionPlugin], name_col: str = "c.relname") -> str:
    """SCHEMA_FILTER plus any extension table-exclusion fragments, ANDed together."""
    extra = [w for p in plugins if (w := p.table_size_where(name_col=name_col)) is not None]
    return SCHEMA_FILTER + "".join(f"\n          AND {w}" for w in extra)


def table_sizes(pool: Any, plugins: list[ExtensionPlugin] | None = None) -> list[dict]:
    """Per-table on-disk sizes — the expensive introspection, fetched on demand.

    ``pg_total_relation_size`` stats every file behind each relation, so this is
    kept out of the cached snapshot and only run when the ERD explicitly asks for
    sizes. Returns ``[{"schema", "name", "total_bytes"}]``.
    """
    plugins = plugins or []
    table_where = _filter_clause(plugins)
    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(f"""
                SELECT n.nspname AS schema,
                       c.relname AS name,
                       pg_total_relation_size(c.oid) AS total_bytes
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p', 'v', 'm')
                  AND {table_where}
                ORDER BY n.nspname, c.relname
            """)
            return [
                {"schema": r["schema"], "name": r["name"], "total_bytes": int(r["total_bytes"])}
                for r in cur.fetchall()
            ]


def build_snapshot(
    pool: Any,
    plugins: list[ExtensionPlugin] | None = None,
) -> Snapshot:
    plugins = plugins or []
    table_where = _filter_clause(plugins)
    # FK query aliases pg_class as "cl" — rebuild plugin filters with the correct alias
    fk_where = _filter_clause(plugins, name_col="cl.relname")

    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:

            # ── 1. All tables (names / kinds / row estimates; no sizes) ──────
            cur.execute(f"""
                SELECT n.nspname AS schema,
                       c.relname AS name,
                       CASE c.relkind
                           WHEN 'r' THEN 'table'
                           WHEN 'p' THEN 'table'
                           WHEN 'v' THEN 'view'
                           WHEN 'm' THEN 'matview'
                           ELSE 'table'
                       END AS kind,
                       GREATEST(c.reltuples, 0)::bigint    AS row_estimate
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p', 'v', 'm')
                  AND {table_where}
                ORDER BY n.nspname, c.relname
            """)
            table_rows = cur.fetchall()

            # ── 2. Column names in declaration order (for ERD node lists) ───
            cur.execute(f"""
                SELECT n.nspname AS schema,
                       c.relname AS table,
                       a.attname AS name,
                       format_type(a.atttypid, a.atttypmod) AS data_type
                FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p', 'v', 'm')
                  AND a.attnum > 0 AND NOT a.attisdropped
                  AND {table_where}
                ORDER BY n.nspname, c.relname, a.attnum
            """)
            col_rows = cur.fetchall()

            # ── 3. Foreign keys (ERD edges + isFk column flags) ─────────────
            cur.execute(f"""
                SELECT n.nspname     AS from_schema,
                       cl.relname    AS from_table,
                       att.attname   AS from_column,
                       nsp_f.nspname AS to_schema,
                       cl_f.relname  AS to_table,
                       att_f.attname AS to_column
                FROM pg_constraint con
                JOIN pg_class cl         ON cl.oid    = con.conrelid
                JOIN pg_namespace n      ON n.oid     = cl.relnamespace
                JOIN pg_class cl_f       ON cl_f.oid  = con.confrelid
                JOIN pg_namespace nsp_f  ON nsp_f.oid = cl_f.relnamespace
                JOIN unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord)  ON true
                JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
                JOIN pg_attribute att
                     ON att.attrelid  = con.conrelid  AND att.attnum  = k.attnum
                JOIN pg_attribute att_f
                     ON att_f.attrelid = con.confrelid AND att_f.attnum = fk.attnum
                WHERE con.contype = 'f'
                  AND {fk_where}
                ORDER BY n.nspname, cl.relname, con.conname, k.ord
            """)
            fk_rows = cur.fetchall()

    # ── Assemble ─────────────────────────────────────────────────────────────

    # Plain views store no rows (reltuples 0); use the planner's estimate so the
    # schema tree / ERD don't render every view as "~0 rows".
    view_est = estimate_view_rows(
        pool,
        [(r["schema"], r["name"]) for r in table_rows
         if r["kind"] == "view" and int(r["row_estimate"]) <= 0],
    )

    allowed = {(r["schema"], r["name"]) for r in table_rows}

    cols_by_table: dict[tuple[str, str], list[dict]] = {}
    for r in col_rows:
        cols_by_table.setdefault((r["schema"], r["table"]), []).append(
            {"name": r["name"], "data_type": r["data_type"]}
        )

    fk_cols_by_table: dict[tuple[str, str], set[str]] = {}
    edges: list[dict] = []
    for r in fk_rows:
        src = (r["from_schema"], r["from_table"])
        fk_cols_by_table.setdefault(src, set()).add(r["from_column"])
        if src in allowed and (r["to_schema"], r["to_table"]) in allowed:
            edges.append({
                "fromSchema": r["from_schema"],
                "fromTable":  r["from_table"],
                "fromColumn": r["from_column"],
                "toSchema":   r["to_schema"],
                "toTable":    r["to_table"],
                "toColumn":   r["to_column"],
            })

    tables = [
        SnapshotTable(
            schema=r["schema"],
            name=r["name"],
            kind=r["kind"],
            row_estimate=view_est.get((r["schema"], r["name"]), int(r["row_estimate"])),
            columns=cols_by_table.get((r["schema"], r["name"]), []),
            fk_columns=fk_cols_by_table.get((r["schema"], r["name"]), set()),
        )
        for r in table_rows
    ]

    return Snapshot(
        sampled_at=time.time(),
        tables=tables,
        edges=edges,
    )
