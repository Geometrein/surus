"""Catalog snapshot: the single introspection pipeline behind the UI and agent.

``build_snapshot`` (reached via ``Dialect.build_snapshot``) is the one entry
point for whole-database introspection; the schema tree, ERD, sizes toggle and
agent context all consume it with different parameters. ``structure`` and
``sizes`` are opt-in so a caller only pays for what it needs —
``pg_total_relation_size`` stats every file backing a relation and is by far
the most expensive part, so it stays off unless asked for.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from psycopg.rows import dict_row

from backend.db.introspect import (
    NOT_EXTENSION_OWNED,
    Column,
    ForeignKey,
    Index,
    Table,
    fill_view_estimates,
    filter_clause,
)

if TYPE_CHECKING:
    from backend.db.extensions import ExtensionPlugin


@dataclass
class Snapshot:
    sampled_at: float
    tables: list[Table]
    edges: list[dict]


def build_snapshot(
    pool: Any,
    plugins: "list[ExtensionPlugin] | None" = None,
    *,
    structure: bool = True,
    sizes: bool = False,
) -> Snapshot:
    """Introspect the whole database in a fixed number of catalog queries.

    ``structure`` adds columns (+PK/nullable), foreign keys, indexes and FK
    edges; ``sizes`` adds on-disk totals. Structure queries are scoped to the
    oids of the surviving relations, so cost tracks the user's tables rather
    than total catalog size (which TimescaleDB chunk churn can inflate by
    orders of magnitude). Plugin hooks (filtering, hypertable row/size lifts)
    and planner-based view row estimates apply on every path.
    """
    plugins = plugins or []
    size_expr = "pg_total_relation_size(c.oid)" if sizes else "0"

    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            # ── 1. All user relations (names / kinds / row estimates) ────────
            cur.execute(f"""
                SELECT c.oid AS oid,
                       n.nspname AS schema,
                       c.relname AS name,
                       CASE c.relkind
                           WHEN 'r' THEN 'table'
                           WHEN 'p' THEN 'table'
                           WHEN 'v' THEN 'view'
                           WHEN 'm' THEN 'matview'
                           ELSE 'table'
                       END AS kind,
                       GREATEST(c.reltuples, 0)::bigint AS row_estimate,
                       {size_expr}::bigint AS total_bytes
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p', 'v', 'm')
                  AND {NOT_EXTENSION_OWNED}
                  AND {filter_clause(plugins)}
                ORDER BY n.nspname, c.relname
            """)
            oid_of: dict[tuple[str, str], int] = {}
            tables: list[Table] = []
            for r in cur.fetchall():
                oid_of[(r["schema"], r["name"])] = r["oid"]
                tables.append(Table(
                    schema=r["schema"], name=r["name"], kind=r["kind"],
                    row_estimate=r["row_estimate"], total_bytes=r["total_bytes"],
                ))
            for plugin in plugins:
                tables = plugin.filter_tables(tables)

            edges: list[dict] = []
            if structure and tables:
                _fill_structure(cur, tables, oid_of)
                allowed = {(t.schema, t.name) for t in tables}
                for t in tables:
                    edges.extend(
                        {
                            "fromSchema": t.schema,
                            "fromTable":  t.name,
                            "fromColumn": fk.column,
                            "toSchema":   fk.ref_schema,
                            "toTable":    fk.ref_table,
                            "toColumn":   fk.ref_column,
                        }
                        for fk in t.foreign_keys
                        if (fk.ref_schema, fk.ref_table) in allowed
                    )

    for plugin in plugins:
        tables = plugin.annotate_tables(pool, tables)
    fill_view_estimates(pool, tables)
    return Snapshot(sampled_at=time.time(), tables=tables, edges=edges)


def _fill_structure(cur: Any, tables: list[Table], oid_of: dict[tuple[str, str], int]) -> None:
    """Populate columns (+PK/nullable), foreign keys and indexes in-place,
    with every query scoped to the given tables' oids (indexed lookups)."""
    by_key = {(t.schema, t.name): t for t in tables}
    params = {"oids": [oid_of[k] for k in by_key]}

    # ── Columns + primary-key flags ──────────────────────────────────────────
    cur.execute("""
        SELECT n.nspname AS schema,
               c.relname AS table,
               a.attname AS name,
               format_type(a.atttypid, a.atttypmod) AS data_type,
               NOT a.attnotnull AS nullable,
               COALESCE(pk.is_pk, false) AS is_pk
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN (
            SELECT i.indrelid, a2.attname, true AS is_pk
            FROM pg_index i
            JOIN pg_attribute a2
              ON a2.attrelid = i.indrelid AND a2.attnum = ANY(i.indkey)
            WHERE i.indisprimary AND i.indrelid = ANY(%(oids)s::oid[])
        ) pk ON pk.indrelid = a.attrelid AND pk.attname = a.attname
        WHERE a.attrelid = ANY(%(oids)s::oid[])
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY n.nspname, c.relname, a.attnum
    """, params)
    for row in cur.fetchall():
        t = by_key.get((row["schema"], row["table"]))
        if t is not None:
            t.columns.append(Column(name=row["name"], data_type=row["data_type"],
                                    nullable=row["nullable"], default=None,
                                    is_pk=row["is_pk"]))

    # ── Foreign keys ─────────────────────────────────────────────────────────
    cur.execute("""
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
          AND con.conrelid = ANY(%(oids)s::oid[])
        ORDER BY n.nspname, cl.relname, con.conname, k.ord
    """, params)
    for row in cur.fetchall():
        t = by_key.get((row["from_schema"], row["from_table"]))
        if t is not None:
            t.foreign_keys.append(ForeignKey(column=row["from_column"],
                                             ref_schema=row["to_schema"],
                                             ref_table=row["to_table"],
                                             ref_column=row["to_column"]))

    # ── Indexes ──────────────────────────────────────────────────────────────
    cur.execute("""
        SELECT n.nspname AS schema,
               t.relname AS table,
               i.relname AS name,
               pg_get_indexdef(idx.indexrelid) AS definition,
               idx.indisunique AS is_unique,
               idx.indisprimary AS is_primary
        FROM pg_index idx
        JOIN pg_class i ON i.oid = idx.indexrelid
        JOIN pg_class t ON t.oid = idx.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE idx.indrelid = ANY(%(oids)s::oid[])
        ORDER BY n.nspname, t.relname, i.relname
    """, params)
    for row in cur.fetchall():
        t = by_key.get((row["schema"], row["table"]))
        if t is not None:
            t.indexes.append(Index(name=row["name"], definition=row["definition"],
                                   is_unique=row["is_unique"], is_primary=row["is_primary"]))
