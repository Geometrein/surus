"""Pure helpers in backend.db.query (no database needed)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from backend.db.query import QueryResult, _jsonsafe


def test_jsonsafe_passes_through_primitives():
    for v in ("s", 1, 1.5, True, None):
        assert _jsonsafe(v) == v


def test_jsonsafe_serializes_containers_to_json_strings():
    assert _jsonsafe({"a": 1}) == '{"a": 1}'
    assert _jsonsafe([1, 2]) == "[1, 2]"


def test_jsonsafe_stringifies_other_types():
    assert _jsonsafe(Decimal("3.14")) == "3.14"
    assert _jsonsafe(date(2026, 1, 2)) == "2026-01-02"


def test_to_aggrid_shapes_columns_and_rows():
    result = QueryResult(
        columns=["id", "status"],
        rows=[[1, "open"], [2, "closed"]],
        rowcount=2,
        duration_ms=4.2,
    )
    grid = result.to_aggrid()
    assert grid["columnDefs"] == [
        {"headerName": "id", "field": "id"},
        {"headerName": "status", "field": "status"},
    ]
    assert grid["rowData"] == [
        {"id": 1, "status": "open"},
        {"id": 2, "status": "closed"},
    ]
    assert grid["defaultColDef"]["sortable"] is True


def test_query_result_defaults():
    r = QueryResult(columns=[], rows=[], rowcount=0, duration_ms=0.0)
    assert r.truncated is False
    assert r.notice is None
