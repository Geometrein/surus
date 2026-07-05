"""Statement validation for the read-only execution paths."""

from __future__ import annotations

import pytest

from backend.db.statements import (
    UnsafeStatementError,
    ensure_read_only_safe,
    split_statements,
)


def test_single_statement_passes():
    ensure_read_only_safe("SELECT 1")
    ensure_read_only_safe("  SELECT * FROM t WHERE x = 1;  ")


def test_semicolon_inside_string_is_not_a_split():
    stmts = split_statements("SELECT ';' AS a, 'b;c' AS b")
    assert len(stmts) == 1
    ensure_read_only_safe("SELECT ';not a split;' AS a")


def test_semicolon_inside_comment_is_not_a_split():
    ensure_read_only_safe("SELECT 1 -- trailing ; comment\n")
    ensure_read_only_safe("SELECT 1 /* block ; comment */")


def test_dollar_quoted_body_is_not_split():
    sql = "SELECT $$ a; b; c $$ AS x"
    assert len(split_statements(sql)) == 1
    ensure_read_only_safe(sql)


def test_trailing_semicolon_is_single_statement():
    assert split_statements("SELECT 1;") == ["SELECT 1"]
    ensure_read_only_safe("SELECT 1;")


def test_multiple_statements_rejected():
    with pytest.raises(UnsafeStatementError):
        ensure_read_only_safe("SELECT 1; SELECT 2")


def test_write_chained_behind_read_write_rejected():
    with pytest.raises(UnsafeStatementError):
        ensure_read_only_safe("SET TRANSACTION READ WRITE; DELETE FROM orders")


@pytest.mark.parametrize(
    "sql",
    [
        "SET TRANSACTION READ WRITE",
        "set transaction read write",
        "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
        "SET default_transaction_read_only = off",
        "SET LOCAL default_transaction_read_only TO off",
        "RESET default_transaction_read_only",
        "RESET ALL",
    ],
)
def test_transaction_mode_tampering_rejected(sql):
    with pytest.raises(UnsafeStatementError):
        ensure_read_only_safe(sql)


def test_read_write_as_string_literal_is_allowed():
    # The phrase only matters as code, not inside a quoted value.
    ensure_read_only_safe("SELECT 'set transaction read write' AS note")


def test_empty_is_rejected():
    with pytest.raises(UnsafeStatementError):
        ensure_read_only_safe("   ;  -- nothing\n")
