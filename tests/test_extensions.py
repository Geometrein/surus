"""Extension plugin registry, detection, and the TimescaleDB filters."""

from __future__ import annotations

from contextlib import contextmanager

from backend.db import extensions
from backend.db.extensions import ExtensionPlugin, detect
from backend.db.extensions.postgis import PostGISPlugin
from backend.db.extensions.timescaledb import TimescaleDBPlugin, _is_internal
from backend.db.introspect import Table


class _FakePool:
    """Minimal pool whose cursor returns canned dict rows (or raises)."""

    def __init__(self, rows=None, error=None):
        self._rows = rows or []
        self._error = error

    @contextmanager
    def connection(self):
        pool = self

        class _Cur:
            def __enter__(self_):
                return self_

            def __exit__(self_, *a):
                return False

            def execute(self_, sql, params=None):
                if pool._error:
                    raise pool._error

            def fetchall(self_):
                return pool._rows

        class _Conn:
            def cursor(self_, row_factory=None):
                return _Cur()

        yield _Conn()


def test_timescaledb_is_registered():
    assert "timescaledb" in extensions._REGISTRY
    assert isinstance(extensions._REGISTRY["timescaledb"], TimescaleDBPlugin)


def test_postgis_is_registered():
    assert "postgis" in extensions._REGISTRY
    assert isinstance(extensions._REGISTRY["postgis"], PostGISPlugin)


def test_detect_returns_installed_plugins_only():
    plugins = detect(["timescaledb", "uuid-ossp"])
    assert [p.ext_name for p in plugins] == ["timescaledb"]


def test_detect_returns_empty_when_no_known_extension():
    assert detect(["hstore", "uuid-ossp"]) == []


def test_postgis_filters_system_objects():
    p = PostGISPlugin()
    tables = [
        Table(schema="public", name="spatial_ref_sys", kind="table"),
        Table(schema="public", name="geometry_columns", kind="view"),
        Table(schema="commerce", name="stores", kind="table"),
    ]
    kept = p.filter_tables(tables)
    assert [t.name for t in kept] == ["stores"]
    assert "spatial_ref_sys" in p.table_size_where()


def test_base_plugin_hooks_are_noops():
    class Bare(ExtensionPlugin):
        ext_name = "bare"

    p = Bare()
    tables = [Table(schema="public", name="t", kind="table")]
    assert p.filter_tables(tables) == tables
    assert p.annotate_tables(None, tables) == tables
    assert p.table_size_where() is None


def test_is_internal_matches_chunks_and_all_timescaledb_schemas():
    assert _is_internal("_timescaledb_internal", "_hyper_1_2_chunk")
    assert _is_internal("public", "_hyper_10_20_chunk")
    assert _is_internal("_timescaledb_catalog", "anything")
    # Underscore-less informational/experimental schemas are internal too.
    assert _is_internal("timescaledb_information", "hypertables")
    assert _is_internal("timescaledb_experimental", "policies")
    assert not _is_internal("public", "orders")
    assert not _is_internal("public", "hyper_data")  # missing leading underscore


def test_timescaledb_filters_out_chunks_and_catalog_views():
    p = TimescaleDBPlugin()
    tables = [
        Table(schema="public", name="metrics", kind="table"),
        Table(schema="_timescaledb_internal", name="_hyper_1_1_chunk", kind="table"),
        Table(schema="public", name="_hyper_2_3_chunk", kind="table"),
        Table(schema="timescaledb_information", name="chunks", kind="view"),
        Table(schema="timescaledb_experimental", name="policies", kind="view"),
    ]
    kept = p.filter_tables(tables)
    assert [t.name for t in kept] == ["metrics"]


def test_timescaledb_table_size_where_clause():
    where = TimescaleDBPlugin().table_size_where()
    # Regex-based (no LIKE '%'), covers every timescaledb schema and chunk names.
    assert "'^_?timescaledb'" in where and "%" not in where
    assert "_hyper_" in where


def test_timescaledb_annotate_lifts_hypertable_row_and_size_estimates():
    p = TimescaleDBPlugin()
    pool = _FakePool(rows=[
        {"schema": "public", "name": "metrics", "rows": 5_000_000, "bytes": 8_000_000},
    ])
    tables = [
        # Parent hypertable reads ~empty from pg_class; chunks hold the real data.
        Table(schema="public", name="metrics", kind="table", row_estimate=0, total_bytes=16384),
        Table(schema="public", name="orders", kind="table", row_estimate=1234, total_bytes=99),
    ]
    annotated = {(t.schema, t.name): t for t in p.annotate_tables(pool, tables)}
    metrics = annotated[("public", "metrics")]
    assert metrics.row_estimate == 5_000_000
    assert metrics.total_bytes == 8_000_000
    # A plain table with no chunk totals is left untouched.
    orders = annotated[("public", "orders")]
    assert orders.row_estimate == 1234 and orders.total_bytes == 99


def test_timescaledb_annotate_degrades_gracefully_on_error():
    p = TimescaleDBPlugin()
    pool = _FakePool(error=RuntimeError("no timescaledb_information on this version"))
    tables = [Table(schema="public", name="metrics", kind="table", row_estimate=7)]
    # Any catalog error leaves the estimates as-is rather than failing the turn.
    assert p.annotate_tables(pool, tables)[0].row_estimate == 7
