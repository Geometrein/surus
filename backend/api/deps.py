"""Active-connection registry.

Holds open :class:`Database` pools keyed by connection id. Replaces v1's single
global ``state`` — the API is now multi-connection. Routes resolve the read-only
pool for a given connection id.
"""

from __future__ import annotations

from fastapi import HTTPException

from backend.db.connections import ConnectionProfile
from backend.db.dialects import get_dialect
from backend.db.pool import Database

_pools: dict[str, Database] = {}


def connect(profile: ConnectionProfile, statement_timeout_ms: int = 30_000) -> str:
    """Open (or reopen) pools for a profile; returns the server version."""
    disconnect(profile.id)
    dialect = get_dialect(profile.kind)
    db = Database(profile, statement_timeout_ms=statement_timeout_ms, dialect=dialect)  # fast-fail probe
    _pools[profile.id] = db
    return db.ping()


def disconnect(connection_id: str) -> None:
    db = _pools.pop(connection_id, None)
    if db is not None:
        db.close()


def is_connected(connection_id: str) -> bool:
    return connection_id in _pools


def get_database(connection_id: str) -> Database:
    db = _pools.get(connection_id)
    if db is None:
        raise HTTPException(status_code=409, detail="Not connected to this database")
    return db
