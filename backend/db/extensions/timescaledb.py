"""TimescaleDB extension plugin.

Hides internal chunk tables so the UI and agent only see the logical
hypertables.  TimescaleDB stores chunks in the ``_timescaledb_internal``
schema with names like ``_hyper_<N>_<M>_chunk``; the parent hypertables live
in the user schema (e.g. ``public``) just like regular tables.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from backend.db.extensions import ExtensionPlugin

if TYPE_CHECKING:
    from backend.db.introspect import Table

_CHUNK_RE = re.compile(r"^_hyper_\d+_\d+_chunk$")
_INTERNAL_SCHEMAS = re.compile(r"^_timescaledb")


def _is_chunk(schema: str, name: str) -> bool:
    return _INTERNAL_SCHEMAS.match(schema) is not None or _CHUNK_RE.match(name) is not None


class TimescaleDBPlugin(ExtensionPlugin):
    ext_name = "timescaledb"

    def filter_tables(self, tables: list["Table"]) -> list["Table"]:
        return [t for t in tables if not _is_chunk(t.schema, t.name)]

    def filter_table_sizes(self, rows: list[dict]) -> list[dict]:
        return [r for r in rows if not _is_chunk(r["schema"], r["name"])]

    def table_size_where(self, schema_col: str = "n.nspname", name_col: str = "c.relname") -> str | None:
        # Single '%' — this fragment is inlined into a non-parameterized query
        # (the snapshot builder), so psycopg does no %-unescaping here.
        return f"{schema_col} NOT LIKE '_timescaledb%' AND {name_col} !~ '^_hyper_[0-9]+_[0-9]+_chunk$'"
