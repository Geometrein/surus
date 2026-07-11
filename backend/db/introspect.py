"""Schema introspection: the structured context the UI and agent rely on.

All queries run against the read-only pool. Results are plain dicts/dataclasses
so they serialize cleanly into the UI tree and the agent's context string.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

if TYPE_CHECKING:
    from backend.db.extensions import ExtensionPlugin


@dataclass
class Column:
    name: str
    data_type: str
    nullable: bool
    default: str | None
    is_pk: bool = False


@dataclass
class ForeignKey:
    column: str
    ref_schema: str
    ref_table: str
    ref_column: str


@dataclass
class Index:
    name: str
    definition: str
    is_unique: bool
    is_primary: bool


@dataclass
class Table:
    schema: str
    name: str
    kind: str  # 'table' | 'view' | 'matview'
    row_estimate: int = 0
    total_bytes: int = 0
    columns: list[Column] = field(default_factory=list)
    foreign_keys: list[ForeignKey] = field(default_factory=list)
    indexes: list[Index] = field(default_factory=list)

    @property
    def qualified(self) -> str:
        return f"{self.schema}.{self.name}"


_RELKIND: dict[str, str] = {"r": "table", "p": "table", "v": "view", "m": "matview"}


def serialize_foreign_key(fk: "ForeignKey") -> dict:
    """Canonical dict serialization for a ForeignKey — used in API routes and agent tools."""
    return {
        "column": fk.column,
        "references": f"{fk.ref_schema}.{fk.ref_table}.{fk.ref_column}",
    }


# User-facing schemas only (hide pg internals).
SCHEMA_FILTER = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'"

# Hide relations owned by extensions (pg_stat_statements, repack, ...). Needs pg_class aliased as "c".
NOT_EXTENSION_OWNED = """NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    WHERE dep.classid = 'pg_class'::regclass
      AND dep.objid = c.oid
      AND dep.deptype = 'e'
)"""


def filter_clause(
    plugins: "list[ExtensionPlugin] | None", name_col: str = "c.relname"
) -> str:
    """SCHEMA_FILTER plus any extension table-exclusion fragments, ANDed together."""
    extra = [w for p in (plugins or []) if (w := p.table_size_where(name_col=name_col)) is not None]
    return SCHEMA_FILTER + "".join(f"\n          AND {w}" for w in extra)


def estimate_view_rows(
    pool: ConnectionPool, views: "list[tuple[str, str]]"
) -> dict[tuple[str, str], int]:
    """Planner row estimates for plain views via ``EXPLAIN`` (no execution), since
    their ``reltuples`` is 0 and reads as "~0 rows". Best-effort per view, each in
    its own transaction so one that won't plan is skipped without poisoning the rest."""
    if not views:
        return {}
    out: dict[tuple[str, str], int] = {}
    with pool.connection() as conn:
        for schema, name in views:
            try:
                with conn.transaction():
                    with conn.cursor() as cur:
                        # Hard cap so a pathological view can't stall the schema
                        # build; on timeout it's skipped and keeps its estimate.
                        cur.execute("SET LOCAL statement_timeout = 2000")
                        cur.execute(
                            sql.SQL("EXPLAIN (FORMAT JSON) SELECT * FROM {}").format(
                                sql.Identifier(schema, name)
                            )
                        )
                        plan = cur.fetchone()[0]
                out[(schema, name)] = max(int(plan[0]["Plan"]["Plan Rows"]), 0)
            except Exception:  # noqa: BLE001 - un-plannable/slow view: skip, keep the rest
                continue
    return out


def fill_view_estimates(pool: ConnectionPool, tables: list["Table"]) -> None:
    """Replace the (meaningless) catalog row estimate of plain views in-place."""
    views = [(t.schema, t.name) for t in tables if t.kind == "view" and t.row_estimate <= 0]
    est = estimate_view_rows(pool, views)
    for t in tables:
        planned = est.get((t.schema, t.name))
        if planned is not None:
            t.row_estimate = planned


def get_table_detail(pool: ConnectionPool, schema: str, name: str) -> Table | None:
    """Full detail for one table: columns, PKs, FKs, indexes."""
    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"""
                SELECT c.relkind, GREATEST(c.reltuples, 0)::bigint AS row_estimate
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s
                """,
                [schema, name],
            )
            head = cur.fetchone()
            if head is None:
                return None
            kind = _RELKIND.get(head["relkind"], "table")
            table = Table(schema=schema, name=name, kind=kind,
                          row_estimate=head["row_estimate"])

            # Columns + primary key flags.
            cur.execute(
                """
                SELECT a.attname AS name,
                       format_type(a.atttypid, a.atttypmod) AS data_type,
                       NOT a.attnotnull AS nullable,
                       pg_get_expr(d.adbin, d.adrelid) AS default,
                       COALESCE(pk.is_pk, false) AS is_pk
                FROM pg_attribute a
                LEFT JOIN pg_attrdef d
                       ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                LEFT JOIN (
                    SELECT a2.attname, true AS is_pk
                    FROM pg_index i
                    JOIN pg_attribute a2
                      ON a2.attrelid = i.indrelid AND a2.attnum = ANY(i.indkey)
                    WHERE i.indrelid = %(rel)s::regclass AND i.indisprimary
                ) pk ON pk.attname = a.attname
                WHERE a.attrelid = %(rel)s::regclass
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY a.attnum
                """,
                {"rel": f"{schema}.{name}"},
            )
            table.columns = [Column(**row) for row in cur.fetchall()]

            # Foreign keys.
            cur.execute(
                """
                SELECT att.attname AS column,
                       nsp_f.nspname AS ref_schema,
                       cl_f.relname AS ref_table,
                       att_f.attname AS ref_column
                FROM pg_constraint con
                JOIN pg_class cl ON cl.oid = con.conrelid
                JOIN pg_namespace nsp ON nsp.oid = cl.relnamespace
                JOIN pg_class cl_f ON cl_f.oid = con.confrelid
                JOIN pg_namespace nsp_f ON nsp_f.oid = cl_f.relnamespace
                JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
                JOIN unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord)
                     ON fk.ord = k.ord
                JOIN pg_attribute att
                     ON att.attrelid = con.conrelid AND att.attnum = k.attnum
                JOIN pg_attribute att_f
                     ON att_f.attrelid = con.confrelid AND att_f.attnum = fk.attnum
                WHERE con.contype = 'f'
                  AND nsp.nspname = %s AND cl.relname = %s
                ORDER BY k.ord
                """,
                [schema, name],
            )
            table.foreign_keys = [ForeignKey(**row) for row in cur.fetchall()]

            # Indexes.
            cur.execute(
                """
                SELECT i.relname AS name,
                       pg_get_indexdef(idx.indexrelid) AS definition,
                       idx.indisunique AS is_unique,
                       idx.indisprimary AS is_primary
                FROM pg_index idx
                JOIN pg_class i ON i.oid = idx.indexrelid
                JOIN pg_class t ON t.oid = idx.indrelid
                JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE n.nspname = %s AND t.relname = %s
                ORDER BY i.relname
                """,
                [schema, name],
            )
            table.indexes = [Index(**row) for row in cur.fetchall()]

    # Substitute the planner's estimate for a plain view's 0 reltuples, after the
    # introspection transaction closes so a failed EXPLAIN can't abort it.
    if table.kind == "view" and table.row_estimate <= 0:
        est = estimate_view_rows(pool, [(schema, name)])
        if (schema, name) in est:
            table.row_estimate = est[(schema, name)]
    return table
