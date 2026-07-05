"""The database-engine abstraction.

A :class:`Dialect` encapsulates everything that differs between database
engines: how to build a connection string, how to enforce a read-only session,
the catalog SQL behind introspection and stats, the ``EXPLAIN`` syntax, and how
to cancel a running statement. The rest of the app (API routes, the agent,
``Database``) is engine-agnostic and talks only to a dialect.

Adding a new engine means writing one ``Dialect`` subclass and registering it in
:mod:`backend.db.dialects` — no other module should need an engine ``if``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from backend.db.connections import ConnectionProfile
    from backend.db.extensions import ExtensionPlugin
    from backend.db.introspect import Table
    from backend.db.query import QueryResult


class Dialect(ABC):
    """Engine-specific behaviour. Implementations are stateless and reusable.

    All introspection/stats/query methods take an opaque connection ``pool``
    so the same dialect instance serves both :class:`~backend.db.pool.Database`
    (which passes its read-only pool) and the agent (which holds one directly).
    """

    #: Stable identifier persisted on the connection profile (e.g. "postgres").
    name: str
    #: Default TCP port offered in the UI / used when none is given.
    default_port: int

    # -- connection lifecycle ------------------------------------------------

    @abstractmethod
    def build_conninfo(self, profile: "ConnectionProfile", password: str | None) -> str:
        """Render the driver connection string for ``profile``."""

    @abstractmethod
    def probe(self, profile: "ConnectionProfile", password: str | None) -> str:
        """Validate connectivity with a short timeout; return the version string."""

    @abstractmethod
    def create_pools(
        self, profile: "ConnectionProfile", statement_timeout_ms: int
    ) -> tuple[Any, Any, str]:
        """Open ``(rw_pool, ro_pool)`` and return them with the server version.

        The read-only pool must be enforced by the engine (e.g. a read-only
        transaction default), not by inspecting SQL. Note this is only a hard
        guarantee when the connecting role lacks write privileges; the query
        layer adds statement-level validation as defense-in-depth.
        """

    @abstractmethod
    def list_extensions(self, pool: Any) -> list[dict]:
        """Installed extensions with version/update metadata (for the info panel).

        Fetched once at connect time; both plugin detection and the connection
        info panel are served from the result, so neither issues its own query.
        """

    @abstractmethod
    def detect_plugins(self, extensions: list[dict]) -> list["ExtensionPlugin"]:
        """Select plugins for the extensions returned by :meth:`list_extensions`."""

    @abstractmethod
    def cancel(self, profile: "ConnectionProfile", pid: int) -> bool:
        """Cancel the backend identified by ``pid`` via a one-off connection."""

    # -- introspection -------------------------------------------------------

    @abstractmethod
    def list_tables(self, pool: Any, plugins: "list[ExtensionPlugin] | None" = None) -> list["Table"]:
        ...

    @abstractmethod
    def get_table_detail(self, pool: Any, schema: str, table: str) -> "Table | None":
        ...

    @abstractmethod
    def list_all_table_details(self, pool: Any) -> "dict[tuple[str, str], Table]":
        """Batched columns/FKs/indexes for every table, keyed by (schema, name)."""
        ...

    # -- query ---------------------------------------------------------------

    @abstractmethod
    def run_query(
        self,
        pool: Any,
        sql: str,
        max_rows: int | None = None,
        connection_id: str | None = None,
        statement_timeout_ms: int | None = None,
        read_only: bool = True,
    ) -> "QueryResult":
        ...

    @abstractmethod
    def run_explain(
        self,
        pool: Any,
        sql: str,
        analyze: bool = False,
        statement_timeout_ms: int | None = None,
    ) -> dict:
        ...
