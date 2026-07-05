"""PostGIS extension plugin.

Hides PostGIS's internal bookkeeping objects so the UI and agent only see the
user's spatial tables.  Installing PostGIS creates a large ``spatial_ref_sys``
reference table (~8500 rows of coordinate systems) plus the
``geometry_columns`` / ``geography_columns`` catalog views — none of which are
part of the user's data model.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from backend.db.extensions import ExtensionPlugin

if TYPE_CHECKING:
    from backend.db.introspect import Table

# Objects PostGIS creates in the install schema (usually ``public``).
_SYSTEM_OBJECTS = {"spatial_ref_sys", "geometry_columns", "geography_columns"}


class PostGISPlugin(ExtensionPlugin):
    ext_name = "postgis"

    def filter_tables(self, tables: list["Table"]) -> list["Table"]:
        return [t for t in tables if t.name not in _SYSTEM_OBJECTS]

    def filter_table_sizes(self, rows: list[dict]) -> list[dict]:
        return [r for r in rows if r["name"] not in _SYSTEM_OBJECTS]

    def table_size_where(self, schema_col: str = "n.nspname", name_col: str = "c.relname") -> str | None:
        names = ", ".join(f"'{n}'" for n in sorted(_SYSTEM_OBJECTS))
        return f"{name_col} NOT IN ({names})"
