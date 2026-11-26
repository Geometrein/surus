"""Client certificate login: profile paths, the Postgres connection string, the API."""

from __future__ import annotations

import keyring
import pytest
from psycopg.conninfo import conninfo_to_dict

from backend.config import KEYRING_SERVICE
from backend.db.connections import ConnectionProfile, explain_connect_error
from backend.db.dialects.postgres import PostgresDialect


@pytest.fixture
def cert_dir(tmp_path, monkeypatch):
    for name in ("client.crt", "client.key", "server.pem"):
        (tmp_path / name).write_text("placeholder")
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def _profile(**kw) -> ConnectionProfile:
    return ConnectionProfile(id="c1", host="db.example", dbname="app", user="me", **kw)


def test_conninfo_carries_certificate_paths_with_home_expanded(cert_dir):
    profile = _profile(
        sslmode="verify-full",
        ssl_cert="~/client.crt",
        ssl_key="~/client.key",
        ssl_root_cert=str(cert_dir / "server.pem"),
    )
    info = conninfo_to_dict(PostgresDialect().build_conninfo(profile, None))
    assert info["sslcert"] == str(cert_dir / "client.crt")
    assert info["sslkey"] == str(cert_dir / "client.key")
    assert info["sslrootcert"] == str(cert_dir / "server.pem")
    assert info["sslmode"] == "verify-full"
    assert "password" not in info


def test_conninfo_without_certificates_is_unchanged():
    info = conninfo_to_dict(PostgresDialect().build_conninfo(_profile(), "pw"))
    assert info["password"] == "pw"
    assert not {"sslcert", "sslkey", "sslrootcert"} & info.keys()


def test_missing_certificate_file_fails_before_connecting(cert_dir):
    profile = _profile(ssl_cert="~/client.crt", ssl_key="~/missing.key")
    with pytest.raises(FileNotFoundError, match="missing.key"):
        PostgresDialect().build_conninfo(profile, None)


def test_expired_certificate_error_names_the_cause():
    raw = Exception("connection failed: SSL error: sslv3 alert certificate expired\nmore")
    explained = explain_connect_error(raw)
    assert str(explained).startswith("The client certificate has expired.")
    assert "sslv3 alert certificate expired" in str(explained)


def test_other_connect_errors_pass_through_unchanged():
    raw = Exception("connection refused")
    assert explain_connect_error(raw) is raw


def test_certificate_connection_roundtrip_drops_stored_password(client, cert_dir):
    created = client.post("/connections", json={
        "name": "Prod", "host": "db.example", "port": 5432, "dbname": "app",
        "user": "me", "password": "pw",
    }).json()
    cid = created["id"]
    assert keyring.get_password(KEYRING_SERVICE, f"conn:{cid}") == "pw"

    updated = client.put(f"/connections/{cid}", json={
        "name": "Prod", "host": "db.example", "port": 5432, "dbname": "app",
        "user": "me", "password": "", "sslmode": "verify-full",
        "ssl_cert": "~/client.crt", "ssl_key": "~/client.key", "ssl_root_cert": "",
    }).json()
    assert updated["ssl_cert"] == "~/client.crt"
    assert updated["ssl_key"] == "~/client.key"
    assert updated["sslmode"] == "verify-full"
    assert keyring.get_password(KEYRING_SERVICE, f"conn:{cid}") is None

    listed = client.get("/connections").json()
    assert listed[0]["ssl_key"] == "~/client.key"


def test_certificate_login_never_sends_a_password(cert_dir):
    profile = _profile(ssl_cert="~/client.crt", ssl_key="~/client.key")
    info = conninfo_to_dict(PostgresDialect().build_conninfo(profile, "left-in-keychain"))
    assert "password" not in info


def test_testing_a_certificate_login_ignores_the_stored_password(client, cert_dir, monkeypatch):
    from backend.db.dialects import postgres

    created = client.post("/connections", json={
        "name": "Prod", "host": "db.example", "dbname": "app", "user": "me", "password": "pw",
    }).json()
    seen = {}

    def probe(self, profile, password):
        seen["password"] = password
        return "PostgreSQL 17"

    monkeypatch.setattr(postgres.PostgresDialect, "probe", probe)
    client.post("/connections/test", json={
        "id": created["id"], "name": "Prod", "host": "db.example", "dbname": "app", "user": "me",
        "password": "", "ssl_cert": "~/client.crt", "ssl_key": "~/client.key",
    })
    assert seen["password"] is None


def test_changing_the_engine_disconnects(client, monkeypatch):
    from backend.api import deps

    created = client.post("/connections", json={"name": "X", "host": "h"}).json()
    disconnected = []
    monkeypatch.setattr(deps, "disconnect", lambda cid: disconnected.append(cid))
    body = {"name": "X", "host": "h", "port": 8443, "dbname": "default", "user": "me", "password": ""}
    client.put(f"/connections/{created['id']}", json={**body, "kind": "postgres"})
    assert disconnected == []
    client.put(f"/connections/{created['id']}", json={**body, "kind": "clickhouse"})
    assert disconnected == [created["id"]]
