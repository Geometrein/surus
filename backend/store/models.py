"""SQLite-backed persistence models (connections, saved queries, chats, settings)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from pydantic import field_serializer
from sqlmodel import Field, SQLModel

from backend.config import DEFAULT_LLM_MODEL
from backend.db.connections import ConnectionProfile


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_isoformat(dt: datetime) -> str:
    """UTC ISO-8601 with a trailing 'Z'. SQLite returns naive datetimes, which
    browsers would otherwise parse as local time — so stamp them as UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class ConnectionRow(SQLModel, table=True):
    __tablename__ = "connections"

    id: str = Field(default_factory=_uuid, primary_key=True)
    name: str = "Connection"
    kind: str = "postgres"  # engine dialect; see backend.db.dialects
    host: str = "localhost"
    port: int = 5432
    dbname: str = "postgres"
    user: str = "postgres"
    sslmode: str = "prefer"
    color: str = ""  # cosmetic accent; "" = none, otherwise a hex like "#4a8fe0"
    created_at: datetime = Field(default_factory=_now)

    def to_profile(self) -> ConnectionProfile:
        return ConnectionProfile(
            id=self.id, name=self.name, kind=self.kind, host=self.host, port=self.port,
            dbname=self.dbname, user=self.user, sslmode=self.sslmode,
        )



class ChatSession(SQLModel, table=True):
    __tablename__ = "chat_sessions"

    id: str = Field(default_factory=_uuid, primary_key=True)
    connection_id: str | None = Field(default=None, index=True)
    model: str = DEFAULT_LLM_MODEL
    mode: str = "sql"
    title: str = "New chat"
    created_at: datetime = Field(default_factory=_now)

    _ser_created_at = field_serializer("created_at")(staticmethod(_utc_isoformat))


class ChatMessage(SQLModel, table=True):
    __tablename__ = "chat_messages"

    id: str = Field(default_factory=_uuid, primary_key=True)
    session_id: str = Field(index=True)
    role: str  # "user" | "assistant"
    content: str = ""
    steps_json: str | None = None  # serialized tool steps for replay/inspection
    created_at: datetime = Field(default_factory=_now)

    _ser_created_at = field_serializer("created_at")(staticmethod(_utc_isoformat))


class Setting(SQLModel, table=True):
    __tablename__ = "settings"

    key: str = Field(primary_key=True)
    value: str = ""
