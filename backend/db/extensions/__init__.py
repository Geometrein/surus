"""Extension plugin system.

Each installed Postgres extension can have a corresponding plugin that
customises how Surus introspects and presents the database.  Plugins are
detected once at connect-time (from the installed-extension list the dialect
already fetches) and stored on the Database object.  Downstream code — introspection, stats, agent context — accepts an
optional ``plugins`` iterable and pipes data through each plugin's hooks.

Adding support for a new extension:
  1. Create ``backend/db/extensions/<name>.py`` with a class that subclasses
     ``ExtensionPlugin``.
  2. Register it at the bottom of this file with ``_register(...)``.
"""

from __future__ import annotations

from abc import ABC
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from backend.db.introspect import Table


class ExtensionPlugin(ABC):
    """Base class for per-extension hooks.

    Override only the hooks your extension needs; the defaults are no-ops.
    """

    #: Must match the ``extname`` in ``pg_extension``.
    ext_name: str

    def filter_tables(self, tables: list["Table"]) -> list["Table"]:
        """Remove or rewrite entries in the table list seen by the UI and agent."""
        return tables

    def annotate_tables(self, pool: "Any", tables: list["Table"]) -> list["Table"]:
        """Enrich table metadata using the pool, after :meth:`filter_tables`
        (default no-op). Overridden where parent-relation stats mislead, e.g. a
        TimescaleDB hypertable whose rows live in child chunks."""
        return tables

    def filter_table_sizes(self, rows: list[dict]) -> list[dict]:
        """Remove or rewrite entries in the stats table-size list."""
        return rows

    def table_size_where(self, schema_col: str = "n.nspname", name_col: str = "c.relname") -> str | None:
        """Optional SQL fragment ANDed into the snapshot's table-size WHERE clause.

        Use this to exclude rows before Postgres computes pg_total_relation_size,
        which can be expensive when there are many internal objects (e.g. TS chunks).
        Return None to add no constraint.
        """
        return None


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_REGISTRY: dict[str, ExtensionPlugin] = {}


def _register(plugin: ExtensionPlugin) -> None:
    _REGISTRY[plugin.ext_name] = plugin


def detect(installed: Iterable[str]) -> list[ExtensionPlugin]:
    """Return plugins for every registered extension in ``installed``.

    ``installed`` is the set of extension names already known for the
    connection (see :meth:`Dialect.list_extensions`), so detection adds no
    query of its own.
    """
    names = set(installed)
    return [p for name, p in _REGISTRY.items() if name in names]


# ---------------------------------------------------------------------------
# Register built-in plugins (import triggers registration as a side-effect)
# ---------------------------------------------------------------------------

from backend.db.extensions import timescaledb as _ts  # noqa: E402, F401
from backend.db.extensions import postgis as _gis  # noqa: E402, F401

_register(_ts.TimescaleDBPlugin())
_register(_gis.PostGISPlugin())
