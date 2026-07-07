"""Agent tool schemas + the execute_tool dispatcher (dialect calls faked out)."""

from __future__ import annotations

import json
from types import SimpleNamespace

from backend.agent.tools import TOOL_DEFS, execute_tool
from backend.db.introspect import Column, ForeignKey, Index, Table
from backend.db.query import QueryResult

POOL = object()  # opaque; passed straight through to the (fake) dialect


def _dialect(**methods) -> SimpleNamespace:
    """A stand-in dialect exposing only the methods execute_tool calls."""
    defaults = dict(
        run_explain=lambda pool, sql, analyze=False, statement_timeout_ms=None: {},
        run_query=lambda pool, sql, max_rows=None, statement_timeout_ms=None: QueryResult(
            [], [], 0, 0.0
        ),
        get_table_detail=lambda pool, schema, table: None,
    )
    defaults.update(methods)
    return SimpleNamespace(**defaults)


def test_tool_defs_cover_the_expected_tools():
    names = {t["name"] for t in TOOL_DEFS}
    assert names == {
        "run_explain", "run_query", "inspect_schema", "submit_query",
        "list_saved_queries", "render_chart",
    }
    for t in TOOL_DEFS:
        assert t["input_schema"]["type"] == "object"
    # Every tool that takes arguments declares which are required. list_saved_queries
    # is argument-free, so it legitimately has no required list.
    for t in TOOL_DEFS:
        if t["input_schema"].get("properties"):
            assert t["input_schema"]["required"]


def test_submit_query_is_strict_and_closed():
    sq = next(t for t in TOOL_DEFS if t["name"] == "submit_query")
    assert sq["strict"] is True
    assert sq["input_schema"]["additionalProperties"] is False
    assert set(sq["input_schema"]["required"]) == {"sql", "rationale"}


def test_submit_query_acknowledges_without_touching_db():
    dialect = _dialect()
    text, is_error = execute_tool(
        dialect, POOL, "submit_query",
        {"sql": "select 1", "rationale": "trivial"},
    )
    assert is_error is False and "submitted" in text.lower()


def test_run_explain_returns_plan_json():
    dialect = _dialect(
        run_explain=lambda pool, sql, analyze=False, statement_timeout_ms=None: {
            "Plan": {"Node Type": "Seq Scan"}
        }
    )
    text, is_error = execute_tool(dialect, POOL, "run_explain", {"sql": "select 1"})
    assert is_error is False
    assert json.loads(text)["Plan"]["Node Type"] == "Seq Scan"


def test_run_query_caps_limit_at_100_and_shapes_payload():
    captured = {}

    def fake_run_query(pool, sql, max_rows=None, statement_timeout_ms=None):
        captured["max_rows"] = max_rows
        return QueryResult(columns=["n"], rows=[[1]], rowcount=1,
                           duration_ms=3.14159, truncated=True)

    dialect = _dialect(run_query=fake_run_query)
    text, is_error = execute_tool(dialect, POOL, "run_query", {"sql": "select 1", "limit": 500})
    assert is_error is False
    assert captured["max_rows"] == 100  # clamped
    payload = json.loads(text)
    assert payload["columns"] == ["n"]
    assert payload["row_count"] == 1
    assert payload["truncated"] is True
    assert payload["duration_ms"] == 3.1  # rounded to 1dp


def test_inspect_schema_serializes_detail():
    detail = Table(
        schema="public", name="orders", kind="table", row_estimate=5000,
        columns=[Column(name="id", data_type="int", nullable=False, default=None, is_pk=True)],
        foreign_keys=[ForeignKey(column="customer_id", ref_schema="public",
                                 ref_table="customers", ref_column="id")],
        indexes=[Index(name="orders_pkey", definition="...", is_unique=True, is_primary=True)],
    )
    dialect = _dialect(get_table_detail=lambda pool, schema, table: detail)
    text, is_error = execute_tool(dialect, POOL, "inspect_schema",
                                  {"schema": "public", "table": "orders"})
    assert is_error is False
    payload = json.loads(text)
    assert payload["table"] == "public.orders"
    assert payload["row_estimate"] == 5000
    assert payload["columns"][0]["is_pk"] is True
    assert payload["foreign_keys"][0]["references"] == "public.customers.id"


def test_inspect_schema_missing_table_is_error():
    dialect = _dialect(get_table_detail=lambda pool, schema, table: None)
    text, is_error = execute_tool(dialect, POOL, "inspect_schema",
                                  {"schema": "public", "table": "ghost"})
    assert is_error is True
    assert "not found" in text


def test_render_chart_validates_columns_and_echoes_spec():
    def fake_run_query(pool, sql, max_rows=None, statement_timeout_ms=None):
        return QueryResult(columns=["month", "orders"], rows=[["2025-01", 10]], rowcount=1, duration_ms=1.0)

    dialect = _dialect(run_query=fake_run_query)
    text, is_error = execute_tool(
        dialect, POOL, "render_chart",
        {"sql": "select month, orders from t", "chart_type": "line", "x": "month", "y": ["orders"]},
    )
    assert is_error is False
    payload = json.loads(text)
    assert payload["chart_type"] == "line"
    assert payload["columns"] == ["month", "orders"]


def test_render_chart_reports_unknown_columns():
    def fake_run_query(pool, sql, max_rows=None, statement_timeout_ms=None):
        return QueryResult(columns=["month", "orders"], rows=[], rowcount=0, duration_ms=1.0)

    dialect = _dialect(run_query=fake_run_query)
    text, is_error = execute_tool(
        dialect, POOL, "render_chart",
        {"sql": "select * from t", "chart_type": "bar", "x": "day", "y": ["revenue"]},
    )
    assert is_error is True
    assert "day" in text and "revenue" in text  # both missing columns surfaced


def test_list_saved_queries_returns_name_folder_sql():
    loader = lambda: [
        {"name": "daily_active", "folder_id": "analytics", "sql": "select 1",
         "connection_id": "c1", "id": "analytics/daily_active.sql"},
    ]
    text, is_error = execute_tool(
        _dialect(), POOL, "list_saved_queries", {}, saved_queries_loader=loader
    )
    assert is_error is False
    payload = json.loads(text)
    assert payload == [{"name": "daily_active", "folder": "analytics", "sql": "select 1"}]


def test_list_saved_queries_without_loader_is_graceful():
    text, is_error = execute_tool(_dialect(), POOL, "list_saved_queries", {})
    assert is_error is False
    assert "No saved queries" in text


def test_unknown_tool_is_error():
    text, is_error = execute_tool(_dialect(), POOL, "drop_everything", {})
    assert is_error is True
    assert "Unknown tool" in text


def test_handler_exception_is_caught_and_reported():
    def boom(*a, **k):
        raise RuntimeError("connection lost")

    dialect = _dialect(run_query=boom)
    text, is_error = execute_tool(dialect, POOL, "run_query", {"sql": "select 1"})
    assert is_error is True
    assert "Error running run_query" in text
    assert "connection lost" in text
