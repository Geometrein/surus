"""ClickHouse dialect, over the HTTP interface via ``clickhouse-connect``.

A "pool" here is one :class:`ClickHousePool`: an HTTP client (which keeps its
own connection pool and is safe to share across threads) tagged with what the
query log needs. The read-only pool sends ``readonly=2`` with every query, so
ClickHouse itself refuses writes; ``2`` rather than ``1`` because a query may
still change its own settings, such as ``max_execution_time``.

ClickHouse has no foreign keys and no B-tree indexes. Its sort key, partition
key and data-skipping indexes play that role, so they are reported as the
table's indexes.
"""

from __future__ import annotations

import math
import threading
import time
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import clickhouse_connect
from clickhouse_connect.driver.client import Client

from backend.db import querylog
from backend.db.connections import cert_files, explain_connect_error, get_password
from backend.db.dialects.base import Dialect
from backend.db.introspect import Column, Index, Table
from backend.db.query import QueryResult, _jsonsafe
from backend.db.snapshot import Snapshot
from backend.db.statements import _code_skeleton, ensure_read_only_safe

if TYPE_CHECKING:
    from backend.db.connections import ConnectionProfile
    from backend.db.extensions import ExtensionPlugin

CONNECT_TIMEOUT_S = 6
# Extra time the HTTP read waits beyond the query's own time limit, so the
# server's clear "timeout exceeded" error arrives before a network timeout.
READ_TIMEOUT_MARGIN_S = 30

# Statements that answer with rows. Anything else (DDL, INSERT, KILL, ...) runs
# as a command, which reports no result set.
_ROW_STATEMENTS = {"SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "EXISTS", "CHECK"}

_SYSTEM_DATABASES = "('system', 'INFORMATION_SCHEMA', 'information_schema')"

# connection_id -> query_id of the user query currently running on it.
_lock = threading.Lock()
_running: dict[str, str] = {}


@dataclass
class ClickHousePool:
    client: Client
    kind: str  # 'ro' | 'rw'
    connection_id: str | None

    def close(self) -> None:
        self.client.close()


def client_kwargs(
    profile: "ConnectionProfile", password: str | None, statement_timeout_ms: int | None = None
) -> dict[str, Any]:
    """Map a connection profile onto ``clickhouse_connect.get_client`` arguments.

    ``disable`` is plain HTTP and ``require`` encrypts without checking the
    server's certificate. Every other mode, ``prefer`` included, checks it:
    HTTPS has no plain fallback for ``prefer`` to mean, and an unchecked server
    would receive the password.
    """
    certs = cert_files(profile)
    secure = profile.sslmode != "disable"
    kwargs: dict[str, Any] = {
        "host": profile.host,
        "port": profile.port,
        "username": profile.user,
        "database": profile.dbname or "default",
        "secure": secure,
        "connect_timeout": CONNECT_TIMEOUT_S,
        # A session serialises queries; the app runs several at once.
        "autogenerate_session_id": False,
    }
    if statement_timeout_ms is not None:
        kwargs["send_receive_timeout"] = (
            math.ceil(statement_timeout_ms / 1000) + READ_TIMEOUT_MARGIN_S
        )
    # The driver refuses a password together with a certificate.
    if certs.cert:
        kwargs["client_cert"] = certs.cert
        if certs.key:
            kwargs["client_cert_key"] = certs.key
    elif password:
        kwargs["password"] = password
    if certs.root_cert:
        kwargs["ca_cert"] = certs.root_cert
    elif secure and profile.sslmode == "require":
        kwargs["verify"] = False
    return kwargs


def _timeout_settings(statement_timeout_ms: int | None) -> dict[str, Any]:
    if statement_timeout_ms is None:
        return {}
    return {"max_execution_time": max(1, math.ceil(statement_timeout_ms / 1000))}


_PER_QUERY_SETTINGS = {"query_id", "max_result_rows", "result_overflow_mode"}


def followup_settings(settings: dict) -> dict:
    """The settings for a follow-up query: its own query id, no row cap."""
    return {k: v for k, v in settings.items() if k not in _PER_QUERY_SETTINGS}


def _first_keyword(sql: str) -> str:
    # Comments and strings are blanked first, so a leading comment is skipped.
    stripped = _code_skeleton(sql).lstrip().lstrip("(").lstrip()
    return stripped.split(None, 1)[0].upper() if stripped else ""


def _subquery(sql: str) -> str:
    """``sql`` ready to wrap as a subquery: no trailing semicolon, and on its own
    lines, so a trailing ``--`` comment cannot swallow the closing bracket."""
    return "(\n" + sql.strip().rstrip(";").rstrip() + "\n)"


def _logged(pool: ClickHousePool, sql: str, run):
    """Run ``run()`` and record it in the query log, whatever the outcome."""
    start = time.perf_counter()
    error: str | None = None
    rows: int | None = None
    try:
        result = run()
        rows = getattr(result, "rowcount", getattr(result, "row_count", None))
        return result
    except Exception as exc:  # noqa: BLE001 - record, then name an expired certificate
        error = str(exc)
        explained = explain_connect_error(exc)
        if explained is exc:
            raise
        raise explained from exc
    finally:
        querylog.record(
            connection_id=pool.connection_id, pool=pool.kind, sql=sql,
            duration_ms=(time.perf_counter() - start) * 1000, row_count=rows, error=error,
        )


def _rows(pool: ClickHousePool, sql: str, parameters: dict | None = None) -> list[tuple]:
    return _logged(pool, sql, lambda: pool.client.query(sql, parameters=parameters)).result_rows


class ClickHouseDialect(Dialect):
    name = "clickhouse"
    label = "ClickHouse"
    default_port = 8443
    agent_notes = (
        "ClickHouse specifics:\n"
        "- There are no foreign keys and no B-tree indexes. A table's sort key "
        "(ORDER BY), partition key and data-skipping indexes decide how much it "
        "reads. Filter on a prefix of the sort key and on the partition key.\n"
        "- run_explain returns EXPLAIN indexes = 1 as text: check that the "
        "PrimaryKey and Partition steps drop most parts and granules. With "
        "analyze=true it runs the query and reports rows and bytes read.\n"
        "- AggregatingMergeTree, ReplacingMergeTree and SummingMergeTree tables "
        "can hold several rows per key until background merges run: aggregate "
        "with GROUP BY on the key instead of assuming one row per key.\n"
        "- Use ClickHouse SQL: count(), uniqExact(), toStartOfDay(), arrayJoin(), "
        "LIMIT n BY, and the FINAL modifier only when unavoidable."
    )

    # -- connection lifecycle ------------------------------------------------

    def build_conninfo(self, profile: "ConnectionProfile", password: str | None) -> str:
        kw = client_kwargs(profile, password)
        scheme = "https" if kw["secure"] else "http"
        return f"{scheme}://{kw['username']}@{kw['host']}:{kw['port']}/{kw['database']}"

    def _client(
        self,
        profile: "ConnectionProfile",
        settings: dict | None = None,
        statement_timeout_ms: int | None = None,
    ) -> Client:
        try:
            return clickhouse_connect.get_client(
                **client_kwargs(profile, get_password(profile), statement_timeout_ms),
                settings=settings or {},
            )
        except Exception as exc:  # noqa: BLE001 - name an expired certificate first
            raise explain_connect_error(exc) from exc

    def probe(self, profile: "ConnectionProfile", password: str | None) -> str:
        try:
            client = clickhouse_connect.get_client(**client_kwargs(profile, password))
        except Exception as exc:  # noqa: BLE001
            raise explain_connect_error(exc) from exc
        try:
            return f"ClickHouse {client.server_version}"
        finally:
            client.close()

    def create_pools(
        self, profile: "ConnectionProfile", statement_timeout_ms: int
    ) -> tuple[ClickHousePool, ClickHousePool, str]:
        timeout = _timeout_settings(statement_timeout_ms)
        rw = ClickHousePool(self._client(profile, timeout, statement_timeout_ms), "rw", profile.id)
        try:
            ro = ClickHousePool(
                self._client(profile, {"readonly": 2, **timeout}, statement_timeout_ms), "ro", profile.id
            )
        except Exception:
            rw.close()
            raise
        return rw, ro, f"ClickHouse {ro.client.server_version}"

    def list_extensions(self, pool: Any) -> list[dict]:
        return []

    def detect_plugins(self, extensions: list[dict]) -> list["ExtensionPlugin"]:
        return []

    def cancel(self, profile: "ConnectionProfile", connection_id: str) -> bool | None:
        with _lock:
            query_id = _running.get(connection_id)
        if query_id is None:
            return None
        client = self._client(profile)
        try:
            client.command("KILL QUERY WHERE query_id = {qid:String}", parameters={"qid": query_id})
        finally:
            client.close()
        return True

    # -- introspection -------------------------------------------------------

    def build_snapshot(
        self,
        pool: Any,
        plugins: "list[ExtensionPlugin] | None" = None,
        *,
        structure: bool = True,
        sizes: bool = False,
    ) -> Snapshot:
        # Sizes come with the table list at no extra cost, so ``sizes`` is
        # always honoured; there are no foreign keys, so no edges.
        return Snapshot(sampled_at=time.time(), tables=self._tables(pool, structure), edges=[])

    def get_table_detail(self, pool: Any, schema: str, table: str) -> Table | None:
        tables = self._tables(pool, True, only=(schema, table))
        return tables[0] if tables else None

    def _tables(
        self, pool: ClickHousePool, structure: bool, only: tuple[str, str] | None = None
    ) -> list[Table]:
        where = f"database NOT IN {_SYSTEM_DATABASES}"
        table_filter = column_filter = ""
        params: dict[str, str] = {}
        if only:
            table_filter = " AND database = {db:String} AND name = {tbl:String}"
            column_filter = " AND database = {db:String} AND table = {tbl:String}"
            params = {"db": only[0], "tbl": only[1]}
        table_rows = _rows(pool, f"""
            SELECT database, name, engine, total_rows, total_bytes,
                   sorting_key, partition_key
            FROM system.tables
            WHERE {where}{table_filter} AND NOT is_temporary AND NOT startsWith(name, '.inner')
            ORDER BY database, name""", params)
        tables = {
            (db, name): Table(
                schema=db, name=name, kind=_kind(engine), row_estimate=int(total_rows or 0),
                total_bytes=int(total_bytes or 0), indexes=_key_indexes(sorting_key, partition_key),
            )
            for db, name, engine, total_rows, total_bytes, sorting_key, partition_key in table_rows
        }
        if not structure or not tables:
            return list(tables.values())

        for db, tbl, name, typ, default, in_pk in _rows(pool, f"""
                SELECT database, table, name, type, default_expression, is_in_primary_key
                FROM system.columns WHERE {where}{column_filter} ORDER BY database, table, position""", params):
            t = tables.get((db, tbl))
            if t is not None:
                t.columns.append(Column(
                    name=name, data_type=typ, nullable=typ.startswith(("Nullable(", "LowCardinality(Nullable(")),
                    default=default or None, is_pk=bool(in_pk),
                ))
        for db, tbl, name, typ, expr in _rows(pool, f"""
                SELECT database, table, name, type_full, expr
                FROM system.data_skipping_indices WHERE {where}{column_filter}""", params):
            t = tables.get((db, tbl))
            if t is not None:
                t.indexes.append(Index(
                    name=name, definition=f"INDEX {name} {expr} TYPE {typ}",
                    is_unique=False, is_primary=False,
                ))
        return list(tables.values())

    # -- query ---------------------------------------------------------------

    def run_query(
        self,
        pool: Any,
        sql: str,
        max_rows: int | None = None,
        connection_id: str | None = None,
        statement_timeout_ms: int | None = None,
        read_only: bool = True,
    ) -> QueryResult:
        if read_only:
            ensure_read_only_safe(sql)
        query_id = uuid.uuid4().hex
        settings = {"query_id": query_id, **_timeout_settings(statement_timeout_ms)}
        if connection_id:
            with _lock:
                _running[connection_id] = query_id
        try:
            return _logged(pool, sql, lambda: self._execute(pool, sql, max_rows, settings))
        finally:
            if connection_id:
                with _lock:
                    _running.pop(connection_id, None)

    def _execute(
        self, pool: ClickHousePool, sql: str, max_rows: int | None, settings: dict
    ) -> QueryResult:
        start = time.perf_counter()
        if _first_keyword(sql) not in _ROW_STATEMENTS:
            pool.client.command(sql, settings=settings)
            return QueryResult([], [], 0, (time.perf_counter() - start) * 1000, notice="OK")
        if max_rows is not None:
            # Closing the stream early does not stop the query: the driver reads
            # the rest of the response first. Have the server stop instead, one
            # row past the limit so truncation still shows.
            settings = {**settings, "max_result_rows": max_rows + 1, "result_overflow_mode": "break"}
        rows: list[list[Any]] = []
        truncated = False
        with pool.client.query_rows_stream(sql, settings=settings) as stream:
            columns = list(stream.source.column_names)
            for row in stream:
                if max_rows is not None and len(rows) >= max_rows:
                    truncated = True
                    break
                rows.append([_jsonsafe(v) for v in row])
        if not columns and _first_keyword(sql) in ("SELECT", "WITH"):
            # An empty result carries no header, which would read as a statement
            # without a result set. DESCRIBE names the columns without running it.
            described = pool.client.query(
                f"DESCRIBE {_subquery(sql)}", settings=followup_settings(settings)
            )
            columns = [str(r[0]) for r in described.result_rows]
        return QueryResult(columns, rows, len(rows), (time.perf_counter() - start) * 1000, truncated)

    def run_explain(
        self,
        pool: Any,
        sql: str,
        analyze: bool = False,
        statement_timeout_ms: int | None = None,
    ) -> dict:
        ensure_read_only_safe(sql)
        settings = _timeout_settings(statement_timeout_ms)
        explain_sql = f"EXPLAIN indexes = 1\n{sql.strip().rstrip(';')}"
        result = _logged(pool, explain_sql, lambda: pool.client.query(explain_sql, settings=settings))
        plan: dict[str, Any] = {"plan": "\n".join(str(r[0]) for r in result.result_rows)}
        if analyze:
            # No EXPLAIN ANALYZE: run the query under count() so no rows travel
            # back, and wait for the end so the read statistics are complete.
            # Columns the count does not need may be skipped, so bytes read can
            # be lower than for the query itself; rows read are not affected.
            count_sql = f"SELECT count() FROM {_subquery(sql)}"
            run = _logged(pool, count_sql, lambda: pool.client.query(
                count_sql, settings={"wait_end_of_query": 1, **settings}))
            summary = run.summary or {}
            plan["execution"] = {
                "result_rows": run.result_rows[0][0] if run.result_rows else None,
                "read_rows": int(summary.get("read_rows", 0)),
                "read_bytes": int(summary.get("read_bytes", 0)),
                "elapsed_ms": round(int(summary.get("elapsed_ns", 0)) / 1e6, 1),
                "memory_usage_bytes": int(summary.get("memory_usage", 0)),
            }
        return plan


def _kind(engine: str) -> str:
    if engine == "View":
        return "view"
    if engine == "MaterializedView":
        return "matview"
    return "table"


def _key_indexes(sorting_key: str, partition_key: str) -> list[Index]:
    keys = []
    if sorting_key:
        wrapped = sorting_key.startswith("(") and sorting_key.endswith(")")
        definition = f"ORDER BY {sorting_key}" if wrapped else f"ORDER BY ({sorting_key})"
        keys.append(Index(name=definition, definition=definition, is_unique=False, is_primary=True))
    if partition_key:
        definition = f"PARTITION BY {partition_key}"
        keys.append(Index(name=definition, definition=definition, is_unique=False, is_primary=False))
    return keys
