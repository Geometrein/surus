"""Schema introspection: the structured context the UI and agent rely on.

All queries run against the read-only pool. Results are plain dicts/dataclasses
so they serialize cleanly into the UI tree and the agent's context string.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

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


def list_tables(
    pool: ConnectionPool,
    plugins: "list[ExtensionPlugin] | None" = None,
) -> list[Table]:
    """List tables/views across user schemas with row estimates (cheap)."""
    sql = f"""
        SELECT n.nspname AS schema,
               c.relname AS name,
               CASE c.relkind
                   WHEN 'r' THEN 'table'
                   WHEN 'p' THEN 'table'
                   WHEN 'v' THEN 'view'
                   WHEN 'm' THEN 'matview'
                   ELSE 'table'
               END AS kind,
               GREATEST(c.reltuples, 0)::bigint AS row_estimate,
               pg_total_relation_size(c.oid) AS total_bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm')
          AND {SCHEMA_FILTER}
        ORDER BY n.nspname, c.relname
    """
    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql)
            tables = [Table(**row) for row in cur.fetchall()]
    for plugin in (plugins or []):
        tables = plugin.filter_tables(tables)
    return tables


def list_all_table_details(pool: ConnectionPool) -> dict[tuple[str, str], Table]:
    """Columns (+PK), foreign keys and indexes for *every* user table, keyed by
    ``(schema, name)`` — the batched equivalent of calling
    :func:`get_table_detail` per table.

    Three queries total, regardless of table count. Used to build the agent's
    schema context without an N+1 fan-out of per-table introspection. Row
    estimates / kinds come from :func:`list_tables`; this only fills structure.
    """
    details: dict[tuple[str, str], Table] = {}

    def table_for(schema: str, name: str) -> Table:
        key = (schema, name)
        t = details.get(key)
        if t is None:
            t = Table(schema=schema, name=name, kind="table")
            details[key] = t
        return t

    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            # ── Columns + primary-key flags for all tables ───────────────────
            cur.execute(f"""
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
                    WHERE i.indisprimary
                ) pk ON pk.indrelid = a.attrelid AND pk.attname = a.attname
                WHERE c.relkind IN ('r', 'p', 'v', 'm')
                  AND a.attnum > 0 AND NOT a.attisdropped
                  AND {SCHEMA_FILTER}
                ORDER BY n.nspname, c.relname, a.attnum
            """)
            for row in cur.fetchall():
                table_for(row["schema"], row["table"]).columns.append(
                    Column(name=row["name"], data_type=row["data_type"],
                           nullable=row["nullable"], default=None, is_pk=row["is_pk"])
                )

            # ── Foreign keys for all tables ──────────────────────────────────
            cur.execute(f"""
                SELECT n.nspname     AS from_schema,
                       cl.relname    AS from_table,
                       att.attname   AS from_column,
                       nsp_f.nspname AS to_schema,
                       cl_f.relname  AS to_table,
                       att_f.attname AS to_column
                FROM pg_constraint con
                JOIN pg_class cl ON cl.oid = con.conrelid
                JOIN pg_namespace n ON n.oid = cl.relnamespace
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
                  AND {SCHEMA_FILTER}
                ORDER BY n.nspname, cl.relname, con.conname, k.ord
            """)
            for row in cur.fetchall():
                key = (row["from_schema"], row["from_table"])
                if key in details:
                    details[key].foreign_keys.append(
                        ForeignKey(column=row["from_column"], ref_schema=row["to_schema"],
                                   ref_table=row["to_table"], ref_column=row["to_column"])
                    )

            # ── Indexes for all tables ───────────────────────────────────────
            cur.execute(f"""
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
                WHERE {SCHEMA_FILTER}
                ORDER BY n.nspname, t.relname, i.relname
            """)
            for row in cur.fetchall():
                key = (row["schema"], row["table"])
                if key in details:
                    details[key].indexes.append(
                        Index(name=row["name"], definition=row["definition"],
                              is_unique=row["is_unique"], is_primary=row["is_primary"])
                    )

    return details


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
            return table
