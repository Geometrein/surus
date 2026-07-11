"""PostgreSQL dialect.

Owns the Postgres-specific connection setup (libpq conninfo, the read-only
session enforced via server options, ``pg_cancel_backend``) and delegates the
catalog-driven work to the introspection/stats/query helper modules, which are
themselves Postgres implementations.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from backend.db import introspect, query, querylog, snapshot
from backend.db.connections import get_password
from backend.db.dialects.base import Dialect
from backend.db.extensions import detect as detect_extension_plugins

if TYPE_CHECKING:
    from backend.db.connections import ConnectionProfile
    from backend.db.extensions import ExtensionPlugin
    from backend.db.introspect import Table
    from backend.db.query import QueryResult
    from backend.db.snapshot import Snapshot

# Fail fast on a bad host/credentials instead of hanging on the pool timeout.
CONNECT_TIMEOUT_S = 6


def _make_configure(connection_id: str, pool_kind: str):
    """Per-connection setup: install the logging cursor and tag origin metadata."""

    def _configure(conn: psycopg.Connection) -> None:
        conn.cursor_factory = querylog.LoggingCursor
        conn._surus_conn_id = connection_id  # type: ignore[attr-defined]
        conn._surus_pool = pool_kind  # type: ignore[attr-defined]

    return _configure


class PostgresDialect(Dialect):
    name = "postgres"
    default_port = 5432

    # -- connection lifecycle ------------------------------------------------

    def build_conninfo(self, profile: "ConnectionProfile", password: str | None) -> str:
        # make_conninfo escapes/quotes values, so hosts, dbnames, users or
        # passwords containing spaces, quotes or backslashes are handled safely
        # (a manual "key=value" join would corrupt the string or misparse).
        kwargs: dict[str, object] = {
            "host": profile.host,
            "port": profile.port,
            "dbname": profile.dbname,
            "user": profile.user,
            "sslmode": profile.sslmode,
            "application_name": "surus",
        }
        if password:
            kwargs["password"] = password
        return make_conninfo(**kwargs)

    def probe(self, profile: "ConnectionProfile", password: str | None) -> str:
        conninfo = make_conninfo(
            self.build_conninfo(profile, password), connect_timeout=CONNECT_TIMEOUT_S
        )
        with psycopg.connect(conninfo) as probe:
            with probe.cursor() as cur:
                cur.execute("SELECT version()")
                return cur.fetchone()[0]

    def create_pools(
        self, profile: "ConnectionProfile", statement_timeout_ms: int
    ) -> tuple[ConnectionPool, ConnectionPool, str]:
        password = get_password(profile)
        base = make_conninfo(
            self.build_conninfo(profile, password), connect_timeout=CONNECT_TIMEOUT_S
        )

        # Read-only session GUCs. This is the primary read-only defense; it is
        # engine-enforced per transaction, but as a *session* setting it is only
        # a hard wall when the connecting role lacks write privileges (or the
        # target is a standby). ensure_read_only_safe() in the query layer backs
        # it up against multi-statement / SET-based tampering.
        ro_options = (
            "-c default_transaction_read_only=on "
            f"-c statement_timeout={statement_timeout_ms} "
            f"-c idle_in_transaction_session_timeout={statement_timeout_ms}"
        )
        ro_conninfo = make_conninfo(base, options=ro_options)

        rw = ConnectionPool(
            base, min_size=0, max_size=4, open=True, name="rw",
            timeout=CONNECT_TIMEOUT_S, configure=_make_configure(profile.id, "rw"),
        )
        ro = ConnectionPool(
            ro_conninfo, min_size=0, max_size=4, open=True, name="ro",
            timeout=CONNECT_TIMEOUT_S, configure=_make_configure(profile.id, "ro"),
        )

        # Read the version from the RO pool's first real connection instead of a
        # throwaway probe connect: it warms the pool for the introspection that
        # runs right after connect, saving a full connect/TLS handshake. The pool
        # masks a failed first connection behind an opaque PoolTimeout, so on
        # failure we fall back to a direct probe() to surface the real driver
        # error (bad host/credentials) to the UI.
        try:
            with ro.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT version()")
                    version = cur.fetchone()[0]
        except Exception:
            rw.close()
            ro.close()
            self.probe(profile, password)  # re-raises the clean driver error
            raise  # probe unexpectedly succeeded — surface the original failure
        return rw, ro, version

    def list_extensions(self, pool: Any) -> list[dict]:
        # pg_available_extensions rows whose installed_version is set are exactly
        # the installed extensions (name == pg_extension.extname), so this single
        # query serves both plugin detection and the connection info panel.
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT name,
                           installed_version,
                           default_version,
                           (default_version IS DISTINCT FROM installed_version) AS update_available,
                           comment
                    FROM pg_available_extensions
                    WHERE installed_version IS NOT NULL
                    ORDER BY name
                    """
                )
                return cur.fetchall()

    def detect_plugins(self, extensions: list[dict]) -> list["ExtensionPlugin"]:
        return detect_extension_plugins(e["name"] for e in extensions)

    def cancel(self, profile: "ConnectionProfile", pid: int) -> bool:
        # A one-off connection (not from the pool) so we can never deadlock
        # waiting for a pool slot the running query already holds.
        conninfo = self.build_conninfo(profile, get_password(profile))
        with psycopg.connect(conninfo, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_cancel_backend(%s)", [pid])
                return bool(cur.fetchone()[0])

    # -- introspection -------------------------------------------------------

    def build_snapshot(
        self,
        pool: Any,
        plugins: "list[ExtensionPlugin] | None" = None,
        *,
        structure: bool = True,
        sizes: bool = False,
    ) -> "Snapshot":
        return snapshot.build_snapshot(pool, plugins=plugins, structure=structure, sizes=sizes)

    def get_table_detail(self, pool: Any, schema: str, table: str) -> "Table | None":
        return introspect.get_table_detail(pool, schema, table)

    # -- query ---------------------------------------------------------------

    def run_query(
        self,
        pool: Any,
        sql: str,
        max_rows: int | None = None,
        connection_id: str | None = None,
        statement_timeout_ms: int | None = None,
        read_only: bool = True,
    ) -> "QueryResult":
        return query.run_query(
            pool, sql, max_rows=max_rows, connection_id=connection_id,
            statement_timeout_ms=statement_timeout_ms, read_only=read_only,
        )

    def run_explain(
        self,
        pool: Any,
        sql: str,
        analyze: bool = False,
        statement_timeout_ms: int | None = None,
    ) -> dict:
        return query.run_explain(
            pool, sql, analyze=analyze, statement_timeout_ms=statement_timeout_ms
        )
