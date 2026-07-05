"""Editor write mode: pool routing + the read-only statement guard.

The invariant under test is the whole safety story of the feature: the agent is
handed the read-only pool directly and never calls ``Database.run_query``, so the
only way onto the write pool is ``write=True`` — which the editor sets solely
from the user's explicit toggle. These are pure unit tests (no live database):
a fake dialect/pool captures what the routing layer would have done.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.db.pool import Database
from backend.db.query import QueryResult, run_query
from backend.db.statements import UnsafeStatementError


# --- Database.run_query pool routing ---------------------------------------

def _database_with_capture() -> tuple[Database, dict]:
    """A Database bypassing __init__ (which would connect), with a fake dialect
    that records the pool and read_only flag it was called with."""
    captured: dict = {}

    def fake_run_query(pool, sql, max_rows=None, connection_id=None, read_only=True):
        captured.update(pool=pool, read_only=read_only)
        return QueryResult([], [], 0, 0.0)

    db = object.__new__(Database)
    db.rw = "RW_POOL"
    db.ro = "RO_POOL"
    db.dialect = SimpleNamespace(run_query=fake_run_query)
    return db, captured


def test_default_run_query_uses_read_only_pool_and_guard():
    db, captured = _database_with_capture()
    db.run_query("select 1")
    assert captured["pool"] == "RO_POOL"
    assert captured["read_only"] is True


def test_write_run_query_uses_write_pool_without_guard():
    db, captured = _database_with_capture()
    db.run_query("delete from orders", write=True)
    assert captured["pool"] == "RW_POOL"
    assert captured["read_only"] is False


# --- the read-only guard is applied for reads, skipped for writes ----------

class _ReachedPool(Exception):
    """Raised by the fake pool to prove execution got past the guard."""


class _FakePool:
    def connection(self):
        raise _ReachedPool()


def test_read_only_guard_blocks_multi_statement():
    # Default (read_only=True): the guard rejects chaining before the pool.
    with pytest.raises(UnsafeStatementError):
        run_query(_FakePool(), "SELECT 1; DELETE FROM orders")


def test_write_mode_skips_the_guard():
    # read_only=False: the same input sails past the guard and reaches the pool
    # (our sentinel), proving write mode takes the guardrail off deliberately.
    with pytest.raises(_ReachedPool):
        run_query(_FakePool(), "SELECT 1; DELETE FROM orders", read_only=False)


# --- result shaping for column-less statements (writes / DDL) --------------
# A write returns no result set: cur.description is None. run_query must then
# surface the driver's command tag ("UPDATE 5") as ``notice`` with empty
# columns — which is exactly what the editor renders as a write's outcome.

class _FakeCursor:
    def __init__(self, description, rowcount, statusmessage):
        self.description = description
        self.rowcount = rowcount
        self.statusmessage = statusmessage

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        pass


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return self._cursor


class _ResultPool:
    def __init__(self, cursor):
        self._cursor = cursor

    def connection(self):
        return _FakeConn(self._cursor)


def test_write_result_has_no_columns_and_carries_command_tag():
    cur = _FakeCursor(description=None, rowcount=5, statusmessage="UPDATE 5")
    result = run_query(_ResultPool(cur), "UPDATE orders SET x = 1", read_only=False)
    assert result.columns == []
    assert result.rows == []
    assert result.rowcount == 5
    assert result.notice == "UPDATE 5"
