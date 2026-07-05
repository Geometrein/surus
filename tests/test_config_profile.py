"""Connection profile formatting + keychain secret helpers."""

from __future__ import annotations

from backend.db import connections as secrets
from backend.db.connections import ConnectionProfile
from backend.db.dialects.postgres import PostgresDialect

_pg = PostgresDialect()


def _profile(**kw) -> ConnectionProfile:
    base = dict(id="abc", host="db.example", port=6543, dbname="sales", user="ro")
    base.update(kw)
    return ConnectionProfile(**base)


def test_conninfo_includes_all_parts_and_app_name():
    info = _pg.build_conninfo(_profile(), "s3cret")
    assert "host=db.example" in info
    assert "port=6543" in info
    assert "dbname=sales" in info
    assert "user=ro" in info
    assert "application_name=surus" in info
    assert "password=s3cret" in info


def test_conninfo_omits_password_when_none():
    info = _pg.build_conninfo(_profile(), None)
    assert "password=" not in info


def test_keyring_username_is_namespaced_by_id():
    assert _profile(id="xyz").keyring_username() == "conn:xyz"


def test_password_roundtrip_and_delete(memory_keyring):
    p = _profile(id="conn-1")
    assert secrets.get_password(p) is None

    secrets.set_password(p, "hunter2")
    assert secrets.get_password(p) == "hunter2"

    secrets.delete_password(p)
    assert secrets.get_password(p) is None


def test_delete_missing_password_is_silent(memory_keyring):
    # delete_password swallows PasswordDeleteError for an absent secret.
    secrets.delete_password(_profile(id="never-set"))


def test_passwords_are_isolated_per_profile(memory_keyring):
    a, b = _profile(id="a"), _profile(id="b")
    secrets.set_password(a, "aaa")
    secrets.set_password(b, "bbb")
    assert secrets.get_password(a) == "aaa"
    assert secrets.get_password(b) == "bbb"
