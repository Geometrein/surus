"""Query execution helpers used by the editor, table preview, and agent."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool

from backend.db.statements import ensure_read_only_safe

# connection_id → postgres backend PID for the currently running user query.
# Protected by _lock so cancel requests from a separate thread are safe.
_lock = threading.Lock()
_running: dict[str, int] = {}


def get_running_pid(connection_id: str) -> int | None:
    with _lock:
        return _running.get(connection_id)


@dataclass
class QueryResult:
    columns: list[str]
    rows: list[list[Any]]
    rowcount: int
    duration_ms: float
    truncated: bool = False
    notice: str | None = None

    def to_aggrid(self) -> dict:
        """Shape results for a NiceGUI ui.aggrid component."""
        col_defs = [{"headerName": c, "field": c} for c in self.columns]
        row_data = [dict(zip(self.columns, r)) for r in self.rows]
        return {
            "columnDefs": col_defs,
            "rowData": row_data,
            "defaultColDef": {"resizable": True, "sortable": True, "filter": True},
        }


def _jsonsafe(value: Any) -> Any:
    """Make values grid/JSON friendly (dates, Decimals, bytes, etc.)."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str)
    return str(value)


def _apply_statement_timeout(conn: psycopg.Connection, statement_timeout_ms: int) -> None:
    """Cap the next statement's runtime for this transaction only.

    Used to give a caller (e.g. the agent) a tighter timeout than the pool's
    connection-level default without a separate pool. ``SET LOCAL`` reverts when
    the connection returns to the pool; a plain (non-logging) cursor keeps the
    GUC change out of the query log; ``int()`` guards injection (SET can't bind).
    """
    with psycopg.Cursor(conn) as cur:
        cur.execute(f"SET LOCAL statement_timeout = {int(statement_timeout_ms)}")


def run_query(
    pool: ConnectionPool,
    sql: str,
    params: list | None = None,
    max_rows: int | None = None,
    connection_id: str | None = None,
    statement_timeout_ms: int | None = None,
    read_only: bool = True,
) -> QueryResult:
    """Run a statement and return rows. Use the read-only pool for safety.

    If ``max_rows`` is set, at most that many rows are fetched and
    ``truncated`` reflects whether more were available.
    If ``connection_id`` is given the backend PID is registered so the query
    can be cancelled via :func:`get_running_pid` + ``pg_cancel_backend``.
    If ``statement_timeout_ms`` is given it overrides the pool default for this
    statement only.
    ``read_only`` (the default) applies the read-only pool's statement guard;
    pass ``False`` only for the write pool, when the user has explicitly opted
    into write mode from the editor.
    """
    # Defense-in-depth for the read-only pool: reject multi-statement input and
    # transaction-mode tampering before it reaches the server. Not a substitute
    # for a read-only role, but it closes the "SET TRANSACTION READ WRITE; …"
    # chaining bypass and yields a clean error. Skipped for the write pool, where
    # the user has deliberately taken off the guardrails.
    if read_only:
        ensure_read_only_safe(sql)
    start = time.perf_counter()
    with pool.connection() as conn:
        if connection_id:
            with _lock:
                _running[connection_id] = conn.info.backend_pid
        try:
            if statement_timeout_ms is not None:
                _apply_statement_timeout(conn, statement_timeout_ms)
            with conn.cursor() as cur:
                cur.execute(sql, params)
                if cur.description is None:
                    duration = (time.perf_counter() - start) * 1000
                    return QueryResult([], [], cur.rowcount, duration,
                                       notice=cur.statusmessage)
                columns = [d.name for d in cur.description]
                truncated = False
                if max_rows is not None:
                    rows = cur.fetchmany(max_rows)
                    truncated = cur.fetchone() is not None
                else:
                    rows = cur.fetchall()
                duration = (time.perf_counter() - start) * 1000
                safe = [[_jsonsafe(v) for v in row] for row in rows]
                return QueryResult(columns, safe, len(safe), duration, truncated)
        finally:
            if connection_id:
                with _lock:
                    _running.pop(connection_id, None)


def run_explain(
    pool: ConnectionPool,
    sql: str,
    analyze: bool = False,
    statement_timeout_ms: int | None = None,
) -> dict:
    """Return the EXPLAIN plan as a dict (FORMAT JSON).

    ``analyze`` actually executes the statement; only safe on the read-only
    pool and only for read statements. ``statement_timeout_ms`` overrides the
    pool default for this statement only (relevant when ``analyze`` runs it).
    """
    ensure_read_only_safe(sql)
    opts = "ANALYZE, BUFFERS, " if analyze else ""
    explain_sql = f"EXPLAIN ({opts}FORMAT JSON) {sql}"
    with pool.connection() as conn:
        if statement_timeout_ms is not None:
            _apply_statement_timeout(conn, statement_timeout_ms)
        with conn.cursor() as cur:
            cur.execute(explain_sql)
            plan = cur.fetchone()[0]
    # psycopg returns the json already parsed; it is a list with one plan.
    return plan[0] if isinstance(plan, list) else plan
