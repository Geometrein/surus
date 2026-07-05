"""SQLite engine + session helpers."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

from backend.config import db_path

# check_same_thread=False: FastAPI handlers and the chat worker thread share it.
_engine = create_engine(
    f"sqlite:///{db_path()}",
    connect_args={"check_same_thread": False},
)


def init_db() -> None:
    # Importing models registers the tables on SQLModel.metadata.
    from backend.store import models  # noqa: F401

    SQLModel.metadata.create_all(_engine)
    _migrate()


def _migrate() -> None:
    """Lightweight, additive column migrations.

    ``create_all`` only creates missing *tables*, never new columns on existing
    ones. Each entry adds a column to a table if it isn't already present.
    """
    additive: list[tuple[str, str, str]] = [
        ("connections", "color", "VARCHAR DEFAULT '' NOT NULL"),
        ("connections", "kind", "VARCHAR DEFAULT 'postgres' NOT NULL"),
        ("chat_sessions", "mode", "VARCHAR DEFAULT 'sql' NOT NULL"),
    ]
    inspector = inspect(_engine)
    with _engine.begin() as conn:
        for table, column, ddl in additive:
            if table not in inspector.get_table_names():
                continue
            existing = {c["name"] for c in inspector.get_columns(table)}
            if column not in existing:
                conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN {column} {ddl}'))


def get_session() -> Iterator[Session]:
    with Session(_engine) as session:
        yield session


def session() -> Session:
    """Standalone session (e.g. for the background chat worker)."""
    return Session(_engine)
