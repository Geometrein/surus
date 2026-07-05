"""Dialect registry.

Maps a profile's ``kind`` to a concrete :class:`~backend.db.dialects.base.Dialect`.
Register additional engines here; nothing else in the app branches on engine.
"""

from __future__ import annotations

from backend.db.dialects.base import Dialect
from backend.db.dialects.postgres import PostgresDialect

# Instances are stateless, so one shared instance per engine is enough.
_DIALECTS: dict[str, Dialect] = {
    PostgresDialect.name: PostgresDialect(),
}

DEFAULT_DIALECT = PostgresDialect.name


def get_dialect(kind: str | None) -> Dialect:
    """Resolve a dialect by ``kind`` (falling back to the default engine)."""
    dialect = _DIALECTS.get(kind or DEFAULT_DIALECT)
    if dialect is None:
        raise ValueError(f"Unknown database kind: {kind!r}")
    return dialect


def available_kinds() -> list[str]:
    return list(_DIALECTS)


__all__ = ["Dialect", "get_dialect", "available_kinds", "DEFAULT_DIALECT"]
