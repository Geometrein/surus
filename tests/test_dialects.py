"""The database-engine dialect abstraction and its registry."""

from __future__ import annotations

import inspect

import pytest

from backend.db.dialects import DEFAULT_DIALECT, available_kinds, get_dialect
from backend.db.dialects.base import Dialect
from backend.db.dialects.postgres import PostgresDialect


def test_registry_resolves_postgres():
    assert isinstance(get_dialect("postgres"), PostgresDialect)


def test_registry_falls_back_to_default_when_kind_missing():
    assert isinstance(get_dialect(None), PostgresDialect)
    assert DEFAULT_DIALECT == "postgres"
    assert "postgres" in available_kinds()


def test_registry_rejects_unknown_kind():
    with pytest.raises(ValueError):
        get_dialect("nosuchdb")


def test_abstract_dialect_cannot_be_instantiated():
    with pytest.raises(TypeError):
        Dialect()  # type: ignore[abstract]


def test_postgres_dialect_implements_the_full_contract():
    # Concrete instantiation already proves no abstractmethods are left, but
    # assert the surface explicitly so a new abstract method can't silently slip.
    abstract = {
        name
        for name, member in inspect.getmembers(Dialect, predicate=inspect.isfunction)
        if getattr(member, "__isabstractmethod__", False)
    }
    pg = PostgresDialect()
    for name in abstract:
        assert callable(getattr(pg, name)), f"PostgresDialect missing {name}"


def test_postgres_metadata():
    pg = PostgresDialect()
    assert pg.name == "postgres"
    assert pg.default_port == 5432
