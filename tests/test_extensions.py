"""Extension plugin registry, detection, and the TimescaleDB filters."""

from __future__ import annotations

from backend.db import extensions
from backend.db.extensions import ExtensionPlugin, detect
from backend.db.extensions.postgis import PostGISPlugin
from backend.db.extensions.timescaledb import TimescaleDBPlugin, _is_chunk
from backend.db.introspect import Table


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

    rows = [{"schema": "public", "name": "spatial_ref_sys"},
            {"schema": "commerce", "name": "stores"}]
    assert p.filter_table_sizes(rows) == [{"schema": "commerce", "name": "stores"}]
    assert "spatial_ref_sys" in p.table_size_where()


def test_base_plugin_hooks_are_noops():
    class Bare(ExtensionPlugin):
        ext_name = "bare"

    p = Bare()
    tables = [Table(schema="public", name="t", kind="table")]
    rows = [{"schema": "public", "name": "t"}]
    assert p.filter_tables(tables) == tables
    assert p.filter_table_sizes(rows) == rows
    assert p.table_size_where() is None


def test_is_chunk_matches_internal_schema_and_chunk_names():
    assert _is_chunk("_timescaledb_internal", "_hyper_1_2_chunk")
    assert _is_chunk("public", "_hyper_10_20_chunk")
    assert _is_chunk("_timescaledb_catalog", "anything")
    assert not _is_chunk("public", "orders")
    assert not _is_chunk("public", "hyper_data")  # missing leading underscore


def test_timescaledb_filters_out_chunks():
    p = TimescaleDBPlugin()
    tables = [
        Table(schema="public", name="metrics", kind="table"),
        Table(schema="_timescaledb_internal", name="_hyper_1_1_chunk", kind="table"),
        Table(schema="public", name="_hyper_2_3_chunk", kind="table"),
    ]
    kept = p.filter_tables(tables)
    assert [t.name for t in kept] == ["metrics"]


def test_timescaledb_filters_table_sizes():
    p = TimescaleDBPlugin()
    rows = [
        {"schema": "public", "name": "metrics"},
        {"schema": "_timescaledb_internal", "name": "_hyper_1_1_chunk"},
    ]
    kept = p.filter_table_sizes(rows)
    assert kept == [{"schema": "public", "name": "metrics"}]


def test_timescaledb_table_size_where_clause():
    where = TimescaleDBPlugin().table_size_where()
    assert "_timescaledb%" in where and "%%" not in where
    assert "_hyper_" in where
