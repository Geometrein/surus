"""Shared fixtures: an isolated in-memory store + an in-memory keychain.

Tests must never touch the user's real SQLite DB or macOS keychain. We:

* swap ``backend.store.db._engine`` for a throwaway in-memory SQLite engine
  (read at call time inside ``get_session``/``session``/``init_db``), and
* install a process-local keyring backend so secret reads/writes stay in RAM.
"""

from __future__ import annotations

import keyring
import pytest
from keyring.backend import KeyringBackend
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, create_engine


class MemoryKeyring(KeyringBackend):
    """A keyring backend that keeps secrets in a dict for the test session."""

    priority = 1  # type: ignore[assignment]

    def __init__(self) -> None:
        super().__init__()
        self._store: dict[tuple[str, str], str] = {}

    def get_password(self, service, username):
        return self._store.get((service, username))

    def set_password(self, service, username, password):
        self._store[(service, username)] = password

    def delete_password(self, service, username):
        try:
            del self._store[(service, username)]
        except KeyError as exc:
            raise keyring.errors.PasswordDeleteError("not found") from exc


@pytest.fixture(autouse=True)
def memory_keyring():
    previous = keyring.get_keyring()
    keyring.set_keyring(MemoryKeyring())
    try:
        yield
    finally:
        keyring.set_keyring(previous)


@pytest.fixture
def engine():
    # Importing the models registers the tables on SQLModel.metadata.
    import backend.store.models  # noqa: F401

    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # one shared in-memory connection across threads
    )
    SQLModel.metadata.create_all(eng)
    return eng


@pytest.fixture
def store(engine, monkeypatch):
    """Point the store module at the in-memory engine for the duration of a test."""
    import backend.store.db as store_db

    monkeypatch.setattr(store_db, "_engine", engine)
    return engine


@pytest.fixture
def client(store):
    from fastapi.testclient import TestClient

    from backend.api.main import app

    with TestClient(app) as c:
        yield c
