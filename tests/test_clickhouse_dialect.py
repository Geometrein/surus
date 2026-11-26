"""ClickHouse dialect: connection settings, queries, cancel, EXPLAIN, introspection."""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from backend.agent.prompts import FIXED_SYSTEM_PROMPT, build_system_prompt
from backend.db import querylog
from backend.db.connections import ConnectionProfile
from backend.db.dialects import get_dialect
from backend.db.dialects import clickhouse as ch
from backend.db.dialects.clickhouse import ClickHouseDialect, ClickHousePool, client_kwargs
from backend.db.dialects.postgres import PostgresDialect
from backend.db.statements import UnsafeStatementError


def _profile(**kw) -> ConnectionProfile:
    base = dict(id="c1", kind="clickhouse", host="ch.example", port=8443, dbname="analytics", user="me")
    return ConnectionProfile(**{**base, **kw})


@pytest.fixture
def certs(tmp_path):
    for name in ("client.crt", "client.key", "server.pem"):
        (tmp_path / name).write_text("placeholder")
    return tmp_path


class FakeClient:
    """Answers queries from a list of rows chosen by a substring of the SQL."""

    def __init__(self, answers: dict[str, list[tuple]] | None = None, columns=("n",), summary=None):
        self.answers = answers or {}
        self.columns = columns
        self.summary = summary or {}
        self.calls: list[tuple[str, dict]] = []
        self.closed = False

    def _answer(self, sql: str) -> list[tuple]:
        for key, rows in self.answers.items():
            if key in sql:
                return rows
        return []

    def query(self, sql, parameters=None, settings=None):
        self.calls.append((sql, settings or {}))
        return SimpleNamespace(result_rows=self._answer(sql), summary=self.summary)

    @contextmanager
    def query_rows_stream(self, sql, settings=None):
        self.calls.append((sql, settings or {}))
        yield _Stream(self._answer(sql), self.columns)

    def command(self, sql, parameters=None, settings=None):
        self.calls.append((sql, {**(settings or {}), **(parameters or {})}))
        return ""

    def close(self):
        self.closed = True


class _Stream:
    def __init__(self, rows, columns):
        self.rows = rows
        self.source = SimpleNamespace(column_names=columns)

    def __iter__(self):
        return iter(self.rows)


def _pool(client: FakeClient, kind: str = "ro") -> ClickHousePool:
    return ClickHousePool(client=client, kind=kind, connection_id="c1")


# -- registry, metadata, contract ---------------------------------------------


def test_registry_resolves_clickhouse():
    dialect = get_dialect("clickhouse")
    assert isinstance(dialect, ClickHouseDialect)
    assert dialect.default_port == 8443
    assert dialect.label == "ClickHouse"


# -- connection settings ------------------------------------------------------


def test_certificate_login_sends_certificate_and_no_password(certs):
    profile = _profile(
        sslmode="verify-full", ssl_cert=str(certs / "client.crt"),
        ssl_key=str(certs / "client.key"), ssl_root_cert=str(certs / "server.pem"),
    )
    kw = client_kwargs(profile, "stale-password")
    assert kw["client_cert"] == str(certs / "client.crt")
    assert kw["client_cert_key"] == str(certs / "client.key")
    assert kw["ca_cert"] == str(certs / "server.pem")
    assert "password" not in kw
    assert "verify" not in kw
    assert kw["secure"] is True
    assert kw["autogenerate_session_id"] is False


def test_password_login_and_ssl_modes():
    assert client_kwargs(_profile(sslmode="disable"), "pw")["secure"] is False
    prefer = client_kwargs(_profile(sslmode="prefer"), "pw")
    assert prefer["password"] == "pw"
    # prefer checks the server's certificate: the password must not reach an
    # unchecked server.
    assert prefer["secure"] is True and "verify" not in prefer
    assert "verify" not in client_kwargs(_profile(sslmode="verify-full"), "pw")
    assert client_kwargs(_profile(sslmode="require"), "pw")["verify"] is False


def test_read_timeout_follows_the_query_timeout():
    assert "send_receive_timeout" not in client_kwargs(_profile(), None)
    kw = client_kwargs(_profile(), None, statement_timeout_ms=1_200_000)
    assert kw["send_receive_timeout"] == 1200 + ch.READ_TIMEOUT_MARGIN_S


def test_empty_database_falls_back_to_default():
    assert client_kwargs(_profile(dbname=""), None)["database"] == "default"


def test_timeout_is_rounded_up_to_whole_seconds():
    assert ch._timeout_settings(None) == {}
    assert ch._timeout_settings(1500) == {"max_execution_time": 2}
    assert ch._timeout_settings(10) == {"max_execution_time": 1}


# -- queries ------------------------------------------------------------------


def test_select_streams_rows_and_flags_truncation():
    client = FakeClient({"numbers": [(i,) for i in range(10)]})
    result = ClickHouseDialect().run_query(_pool(client), "SELECT number FROM numbers(10)", max_rows=3)
    assert result.columns == ["n"]
    assert result.rows == [[0], [1], [2]]
    assert result.truncated is True
    sql, settings = client.calls[0]
    assert "query_id" in settings


def test_non_row_statement_runs_as_command_on_the_write_pool():
    client = FakeClient()
    result = ClickHouseDialect().run_query(
        _pool(client, "rw"), "CREATE TABLE t (x Int8) ENGINE = Memory", read_only=False
    )
    assert result.notice == "OK"
    assert client.calls[0][0].startswith("CREATE TABLE")


def test_read_only_path_rejects_multiple_statements():
    with pytest.raises(UnsafeStatementError):
        ClickHouseDialect().run_query(_pool(FakeClient()), "SELECT 1; DROP TABLE t")


def test_queries_are_recorded_in_the_query_log():
    before = querylog.get_since(0)
    last = before[-1]["seq"] if before else 0
    ClickHouseDialect().run_query(_pool(FakeClient()), "SELECT 42")
    entries = querylog.get_since(last)
    assert entries[-1]["sql"] == "SELECT 42"
    assert entries[-1]["pool"] == "ro"
    assert entries[-1]["connectionId"] == "c1"


def test_cancel_kills_the_running_query_by_id(monkeypatch):
    dialect = ClickHouseDialect()
    killer = FakeClient()
    monkeypatch.setattr(dialect, "_client", lambda profile, settings=None: killer)
    assert dialect.cancel(_profile(), "c1") is None

    monkeypatch.setitem(ch._running, "c1", "abc123")
    assert dialect.cancel(_profile(), "c1") is True
    sql, params = killer.calls[0]
    assert sql.startswith("KILL QUERY") and params["qid"] == "abc123"
    assert killer.closed


# -- EXPLAIN --------------------------------------------------------------------


def test_explain_returns_text_plan():
    client = FakeClient({"EXPLAIN": [("Expression",), ("  ReadFromMergeTree",)]})
    plan = ClickHouseDialect().run_explain(_pool(client), "SELECT 1")
    assert plan == {"plan": "Expression\n  ReadFromMergeTree"}
    assert client.calls[0][0] == "EXPLAIN indexes = 1\nSELECT 1"


def test_explain_analyze_reports_read_statistics():
    summary = {"read_rows": "1000", "read_bytes": "8000", "elapsed_ns": "2500000", "memory_usage": "4096"}
    client = FakeClient({"EXPLAIN": [("Expression",)], "count()": [(7,)]}, summary=summary)
    plan = ClickHouseDialect().run_explain(
        _pool(client), "SELECT x FROM t WHERE y -- note\n;", analyze=True
    )
    assert plan["execution"] == {
        "result_rows": 7, "read_rows": 1000, "read_bytes": 8000,
        "elapsed_ms": 2.5, "memory_usage_bytes": 4096,
    }
    count_sql, settings = client.calls[1]
    assert count_sql == "SELECT count() FROM (\nSELECT x FROM t WHERE y -- note\n)"
    assert settings["wait_end_of_query"] == 1


# -- introspection ------------------------------------------------------------


def _catalog() -> FakeClient:
    return FakeClient({
        "system.tables": [
            ("analytics", "page_views", "MergeTree", 10, 2048, "user_id, viewed_at", "toYYYYMM(viewed_at)"),
            ("analytics", "daily", "MaterializedView", None, None, "", ""),
        ],
        "system.columns": [
            ("analytics", "page_views", "user_id", "Int64", "", 1),
            ("analytics", "page_views", "session_count", "Nullable(Int32)", "", 0),
            ("analytics", "page_views", "inserted_at", "DateTime64(6, 'UTC')", "now64(6)", 0),
        ],
        "system.data_skipping_indices": [("analytics", "page_views", "u_bf", "bloom_filter(0.001)", "user_id")],
    })


def test_snapshot_maps_tables_columns_and_keys():
    snap = ClickHouseDialect().build_snapshot(_pool(_catalog()))
    assert snap.edges == []
    metrics, daily = snap.tables
    assert (metrics.schema, metrics.name, metrics.kind) == ("analytics", "page_views", "table")
    assert (metrics.row_estimate, metrics.total_bytes) == (10, 2048)
    assert [c.name for c in metrics.columns] == ["user_id", "session_count", "inserted_at"]
    assert metrics.columns[0].is_pk and not metrics.columns[0].nullable
    assert metrics.columns[1].nullable
    assert metrics.columns[2].default == "now64(6)"
    assert [i.definition for i in metrics.indexes] == [
        "ORDER BY (user_id, viewed_at)",
        "PARTITION BY toYYYYMM(viewed_at)",
        "INDEX u_bf user_id TYPE bloom_filter(0.001)",
    ]
    assert daily.kind == "matview" and daily.row_estimate == 0 and daily.indexes == []


def test_snapshot_without_structure_skips_columns():
    client = _catalog()
    snap = ClickHouseDialect().build_snapshot(_pool(client), structure=False)
    assert all(not t.columns for t in snap.tables)
    assert len(client.calls) == 1


# -- agent prompts --------------------------------------------------------------


def test_prompt_names_the_connected_engine():
    prompt = build_system_prompt("", "sql", ClickHouseDialect())
    assert "senior ClickHouse engineer" in prompt
    assert "ClickHouse specifics" in prompt
    assert "PostgreSQL" not in prompt
    assert "senior PostgreSQL engineer" in build_system_prompt("", "sql", PostgresDialect())
    assert "{engine}" not in FIXED_SYSTEM_PROMPT


def test_empty_select_still_names_its_columns():
    client = FakeClient({"DESCRIBE": [("user_id", "Int64"), ("email", "String")]}, columns=())
    result = ClickHouseDialect().run_query(
        _pool(client), 'SELECT * FROM "analytics"."customers" LIMIT 10', max_rows=5
    )
    assert result.columns == ["user_id", "email"]
    assert result.rows == [] and result.notice is None
    describe_sql, settings = client.calls[1]
    assert describe_sql == 'DESCRIBE (\nSELECT * FROM "analytics"."customers" LIMIT 10\n)'
    # Its own query id, and no row cap that could cut off columns.
    assert not {"query_id", "max_result_rows", "result_overflow_mode"} & settings.keys()


def test_row_limit_is_enforced_by_the_server():
    client = FakeClient({"numbers": [(i,) for i in range(10)]})
    ClickHouseDialect().run_query(_pool(client), "SELECT number FROM numbers(10)", max_rows=3)
    settings = client.calls[0][1]
    assert settings["max_result_rows"] == 4
    assert settings["result_overflow_mode"] == "break"
    ClickHouseDialect().run_query(_pool(client), "SELECT number FROM numbers(10)")
    assert "max_result_rows" not in client.calls[1][1]


@pytest.mark.parametrize("sql", [
    "-- monthly totals\nSELECT 1",
    "/* note */ SELECT 1",
    "  -- a\n  -- b\n(SELECT 1)",
])
def test_leading_comments_do_not_turn_a_select_into_a_command(sql):
    client = FakeClient({"SELECT": [(1,)]})
    result = ClickHouseDialect().run_query(_pool(client), sql)
    assert result.rows == [[1]] and result.notice is None


def test_low_cardinality_nullable_columns_count_as_nullable():
    client = FakeClient({
        "system.tables": [("db", "t", "MergeTree", 0, 0, "", "")],
        "system.columns": [("db", "t", "label", "LowCardinality(Nullable(String))", "", 0)],
    })
    (table,) = ClickHouseDialect().build_snapshot(_pool(client)).tables
    assert table.columns[0].nullable is True


def test_expired_certificate_during_a_query_is_named():
    class Expired(FakeClient):
        @contextmanager
        def query_rows_stream(self, sql, settings=None):
            raise OSError("SSL: sslv3 alert certificate expired")
            yield

    with pytest.raises(ConnectionError, match="certificate has expired"):
        ClickHouseDialect().run_query(_pool(Expired()), "SELECT 1")


def test_query_log_records_row_counts_from_the_driver():
    before = querylog.get_since(0)
    last = before[-1]["seq"] if before else 0
    client = FakeClient()
    client.query = lambda sql, parameters=None, settings=None: SimpleNamespace(
        result_rows=[], summary={}, row_count=7
    )
    ch._rows(_pool(client), "SELECT 7")
    assert querylog.get_since(last)[-1]["rowCount"] == 7
