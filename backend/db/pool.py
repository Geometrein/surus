"""Connection pools for an active database.

Each active :class:`Database` keeps two pools against the same target:

* ``rw``  — a normal pool (used only for explicit, user-confirmed actions).
* ``ro``  — a read-only pool. Reads are enforced per transaction by the engine
  (``default_transaction_read_only``; see the dialect). That is a hard wall only
  when the connecting role lacks write privileges or the target is a standby;
  otherwise it is a strong default backed by statement-level validation
  (:func:`backend.db.statements.ensure_read_only_safe`) against multi-statement
  and ``SET``-based tampering. Connecting as a read-only role remains the only
  fully sound guarantee.

``Database`` is engine-agnostic: a :class:`~backend.db.dialects.base.Dialect`
supplies the connection setup, introspection, stats, and query behaviour. The
convenience methods below simply pair the dialect with this connection's
read-only pool so routes don't repeat that plumbing.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

from backend.db.connections import ConnectionProfile
from backend.db.dialects import get_dialect

if TYPE_CHECKING:
    from backend.db.dialects.base import Dialect
    from backend.db.extensions import ExtensionPlugin
    from backend.db.introspect import Table
    from backend.db.query import QueryResult
    from backend.db.snapshot import Snapshot


class Database:
    plugins: list["ExtensionPlugin"]

    def __init__(
        self,
        profile: ConnectionProfile,
        statement_timeout_ms: int = 30_000,
        dialect: "Dialect | None" = None,
    ):
        self.profile = profile
        self.dialect = dialect or get_dialect(profile.kind)
        self.rw, self.ro, self._version = self.dialect.create_pools(
            profile, statement_timeout_ms
        )
        # One catalog read at connect time backs both plugin detection and the
        # connection info panel (version comes from create_pools, cached above).
        self._extensions = self.dialect.list_extensions(self.ro)
        self.plugins = self.dialect.detect_plugins(self._extensions)
        self._snapshot: Snapshot | None = None
        self._snapshot_lock = threading.Lock()

    def close(self) -> None:
        self.rw.close()
        self.ro.close()

    def ping(self) -> str:
        """Return the server version string captured at connect time."""
        return self._version

    # -- engine operations, bound to this connection's read-only pool --------

    def get_table_detail(self, schema: str, table: str) -> "Table | None":
        return self.dialect.get_table_detail(self.ro, schema, table)

    def server_info(self) -> dict:
        """Version + installed extensions, both captured at connect time."""
        return {"version": self._version, "extensions": self._extensions}

    @property
    def snapshot(self) -> "Snapshot":
        if self._snapshot is None:
            with self._snapshot_lock:
                if self._snapshot is None:  # re-check after acquiring lock
                    self._snapshot = self._build_snapshot()
        return self._snapshot

    def refresh_snapshot(self) -> None:
        with self._snapshot_lock:
            self._snapshot = self._build_snapshot()

    def _build_snapshot(self) -> "Snapshot":
        return self.dialect.build_snapshot(self.ro, plugins=self.plugins)

    def table_sizes(self) -> list["Table"]:
        """Per-table on-disk sizes, computed on demand (not part of the cached snapshot)."""
        return self.dialect.build_snapshot(
            self.ro, plugins=self.plugins, structure=False, sizes=True
        ).tables

    def run_query(
        self,
        sql: str,
        max_rows: int | None = None,
        connection_id: str | None = None,
        write: bool = False,
    ) -> "QueryResult":
        # ``write`` routes to the unrestricted ``rw`` pool and drops the
        # read-only statement guard. It is reachable only from the editor's
        # query route, which sets it from the user's explicit write-mode toggle.
        # The agent never calls this method — it is handed ``self.ro`` directly
        # (see agent.tools) — so there is no code path from the agent to ``rw``.
        pool = self.rw if write else self.ro
        return self.dialect.run_query(
            pool, sql, max_rows=max_rows, connection_id=connection_id,
            read_only=not write,
        )

    def run_explain(self, sql: str, analyze: bool = False) -> dict:
        return self.dialect.run_explain(self.ro, sql, analyze=analyze)

    def cancel(self, pid: int) -> bool:
        return self.dialect.cancel(self.profile, pid)
