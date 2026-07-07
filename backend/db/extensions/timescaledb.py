"""TimescaleDB extension plugin.

Hides TimescaleDB's internal objects so the UI and agent only see the logical
hypertables. Chunks live in the ``_timescaledb_internal`` schema with names like
``_hyper_<N>_<M>_chunk``; the parent hypertables live in the user schema (e.g.
``public``) just like regular tables. TimescaleDB also ships its own catalog
schemas — ``_timescaledb_catalog/config/internal`` plus the *informational*
``timescaledb_information`` and ``timescaledb_experimental`` — whose views are
plumbing, not user data. We hide all of them: they clutter the schema tree and
agent context, and several ``timescaledb_information`` views wrap chunk-stat
functions that are expensive to plan/estimate.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from backend.db.extensions import ExtensionPlugin

if TYPE_CHECKING:
    from backend.db.introspect import Table

_CHUNK_RE = re.compile(r"^_hyper_\d+_\d+_chunk$")
# All TimescaleDB-owned schemas: the leading-underscore catalog/internal/config
# schemas *and* the underscore-less timescaledb_information / _experimental.
_INTERNAL_SCHEMAS = re.compile(r"^_?timescaledb")


def _is_internal(schema: str, name: str) -> bool:
    """True for a TimescaleDB internal object (chunk or catalog/info view)."""
    return _INTERNAL_SCHEMAS.match(schema) is not None or _CHUNK_RE.match(name) is not None


class TimescaleDBPlugin(ExtensionPlugin):
    ext_name = "timescaledb"

    def filter_tables(self, tables: list["Table"]) -> list["Table"]:
        return [t for t in tables if not _is_internal(t.schema, t.name)]

    def annotate_tables(self, pool: Any, tables: list["Table"]) -> list["Table"]:
        """Replace the parent hypertable's ~0 row/size estimate with the sum of
        its child chunks' catalog stats, so the agent doesn't read it as empty.
        Still an estimate (compressed chunks count compressed rows); best-effort."""
        try:
            totals = self._hypertable_totals(pool)
        except Exception:  # noqa: BLE001 - TS version/catalog differences shouldn't break introspection
            return tables
        for t in tables:
            summed = totals.get((t.schema, t.name))
            if summed is None:
                continue
            rows, total_bytes = summed
            # Only lift the estimate; never shrink whatever the parent reported.
            t.row_estimate = max(t.row_estimate, rows)
            t.total_bytes = max(t.total_bytes, total_bytes)
        return tables

    @staticmethod
    def _hypertable_totals(pool: Any) -> dict[tuple[str, str], tuple[int, int]]:
        """Per-hypertable ``(row_estimate, total_bytes)`` summed across chunks."""
        from psycopg.rows import dict_row

        sql = """
            SELECT c.hypertable_schema AS schema,
                   c.hypertable_name   AS name,
                   COALESCE(SUM(GREATEST(ch.reltuples, 0)), 0)::bigint   AS rows,
                   COALESCE(SUM(pg_total_relation_size(ch.oid)), 0)::bigint AS bytes
            FROM timescaledb_information.chunks c
            JOIN pg_class ch ON ch.relname = c.chunk_name
            JOIN pg_namespace n ON n.oid = ch.relnamespace
                               AND n.nspname = c.chunk_schema
            GROUP BY c.hypertable_schema, c.hypertable_name
        """
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql)
                return {
                    (r["schema"], r["name"]): (r["rows"], r["bytes"])
                    for r in cur.fetchall()
                }

    def filter_table_sizes(self, rows: list[dict]) -> list[dict]:
        return [r for r in rows if not _is_internal(r["schema"], r["name"])]

    def table_size_where(self, schema_col: str = "n.nspname", name_col: str = "c.relname") -> str | None:
        # Regex (no '%'), safe to inline into the snapshot builder's query.
        # Excludes every TimescaleDB schema and any chunk relation.
        return (
            f"{schema_col} !~ '^_?timescaledb' "
            f"AND {name_col} !~ '^_hyper_[0-9]+_[0-9]+_chunk$'"
        )
