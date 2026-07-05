"""Central log of every SQL statement the app sends to a database.

Completeness is the whole point: rather than sprinkling log calls at each query
site (which a future caller could forget), we intercept at the psycopg cursor
layer via :class:`LoggingCursor`. Every ``execute``/``executemany`` that runs on
a pooled connection is recorded here, tagged with *who* triggered it:

* ``user``   — an explicit user action (the editor's Run / Explain).
* ``agent``  — the LLM agent's tool calls.
* ``system`` — everything else (schema introspection, stats sampling).

The active source is carried on a :class:`~contextvars.ContextVar` so the
cursor doesn't need to thread it through every call. Routes/handlers set it with
the :func:`source` context manager; the default is ``system``.
"""

from __future__ import annotations

import itertools
import threading
import time
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, dataclass
from typing import Iterator

import psycopg

# Who triggered the statement currently executing. Copied per request/task, so
# concurrent requests never see each other's source.
_source: ContextVar[str] = ContextVar("query_source", default="system")


@contextmanager
def source(name: str) -> Iterator[None]:
    """Tag every query executed within the block with ``name``."""
    token = _source.set(name)
    try:
        yield
    finally:
        _source.reset(token)


@dataclass
class QueryLogEntry:
    seq: int
    ts: float  # epoch seconds
    source: str  # user | agent | system
    connectionId: str | None
    pool: str | None  # 'ro' | 'rw'
    sql: str
    durationMs: float
    rowCount: int | None
    error: str | None


_BUFFER: "deque[QueryLogEntry]" = deque(maxlen=2000)
_LOCK = threading.Lock()
_seq = itertools.count(1)

_MAX_SQL = 4000


def _normalize(sql: str) -> str:
    collapsed = " ".join(sql.split())
    return collapsed if len(collapsed) <= _MAX_SQL else collapsed[:_MAX_SQL] + "…"


def record(
    *,
    connection_id: str | None,
    pool: str | None,
    sql: str,
    duration_ms: float,
    row_count: int | None,
    error: str | None,
) -> None:
    entry = QueryLogEntry(
        seq=next(_seq),
        ts=time.time(),
        source=_source.get(),
        connectionId=connection_id,
        pool=pool,
        sql=_normalize(sql),
        durationMs=round(duration_ms, 1),
        rowCount=row_count,
        error=error,
    )
    with _LOCK:
        _BUFFER.append(entry)


def get_since(after: int) -> list[dict]:
    """Return buffered entries with ``seq > after``, oldest first."""
    with _LOCK:
        return [asdict(e) for e in _BUFFER if e.seq > after]


def _as_text(query: object) -> str:
    if isinstance(query, (bytes, bytearray)):
        return query.decode("utf-8", "replace")
    return str(query)


class LoggingCursor(psycopg.Cursor):
    """A cursor that records every statement it runs into the query log."""

    def execute(self, query, params=None, *, prepare=None, binary=None):  # type: ignore[override]
        start = time.perf_counter()
        error: str | None = None
        try:
            return super().execute(query, params, prepare=prepare, binary=binary)
        except Exception as exc:  # noqa: BLE001 - record then re-raise unchanged
            error = str(exc)
            raise
        finally:
            self._record(query, start, error)

    def executemany(self, query, params_seq, *, returning=False):  # type: ignore[override]
        start = time.perf_counter()
        error: str | None = None
        try:
            return super().executemany(query, params_seq, returning=returning)
        except Exception as exc:  # noqa: BLE001
            error = str(exc)
            raise
        finally:
            self._record(query, start, error)

    def _record(self, query: object, start: float, error: str | None) -> None:
        conn = self.connection
        rowcount = self.rowcount
        record(
            connection_id=getattr(conn, "_surus_conn_id", None),
            pool=getattr(conn, "_surus_pool", None),
            sql=_as_text(query),
            duration_ms=(time.perf_counter() - start) * 1000,
            row_count=rowcount if isinstance(rowcount, int) and rowcount >= 0 else None,
            error=error,
        )
