"""Tests for chat-history rehydration (``_history_messages``).

The function reloads a persisted chat into the alternating user/assistant shape
the Anthropic API requires. These tests exercise it against an in-memory SQLite
store, so no Postgres or LLM key is involved.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.api.routes.chat import _history_messages
from backend.store.models import ChatMessage

_BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def seed(s: Session, session_id: str, turns: list[tuple[str, str]]) -> None:
    """Insert (role, content) turns with strictly increasing timestamps."""
    for i, (role, content) in enumerate(turns):
        s.add(ChatMessage(
            session_id=session_id,
            role=role,
            content=content,
            created_at=_BASE + timedelta(seconds=i),
        ))
    s.commit()


def test_empty_history_returns_empty(db):
    assert _history_messages(db, "missing") == []


def test_well_formed_conversation_restored(db):
    seed(db, "s1", [
        ("user", "count orders"),
        ("assistant", "```sql\nSELECT count(*) FROM orders\n```"),
        ("user", "now by status"),
        ("assistant", "```sql\nSELECT status, count(*) FROM orders GROUP BY 1\n```"),
    ])
    assert _history_messages(db, "s1") == [
        {"role": "user", "content": "count orders"},
        {"role": "assistant", "content": "```sql\nSELECT count(*) FROM orders\n```"},
        {"role": "user", "content": "now by status"},
        {"role": "assistant",
         "content": "```sql\nSELECT status, count(*) FROM orders GROUP BY 1\n```"},
    ]


def test_only_named_session_loaded(db):
    seed(db, "s1", [("user", "mine"), ("assistant", "ok")])
    seed(db, "s2", [("user", "other"), ("assistant", "nope")])
    assert _history_messages(db, "s1") == [
        {"role": "user", "content": "mine"},
        {"role": "assistant", "content": "ok"},
    ]


def test_empty_and_whitespace_content_skipped(db):
    seed(db, "s1", [
        ("user", "hello"),
        ("assistant", ""),       # errored turn, no text persisted
        ("user", "  "),          # whitespace only
        ("assistant", "world"),
    ])
    # The empty assistant + whitespace user drop out; "hello" and "world" then
    # sit adjacent as user/assistant — a valid alternating pair.
    assert _history_messages(db, "s1") == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "world"},
    ]


def test_leading_assistant_dropped(db):
    seed(db, "s1", [
        ("assistant", "stray opener"),
        ("user", "real start"),
        ("assistant", "reply"),
    ])
    assert _history_messages(db, "s1") == [
        {"role": "user", "content": "real start"},
        {"role": "assistant", "content": "reply"},
    ]


def test_trailing_user_dropped(db):
    # A user turn whose assistant reply never landed (e.g. crash mid-stream):
    # it is dropped so the next live user message doesn't double up.
    seed(db, "s1", [
        ("user", "q1"),
        ("assistant", "a1"),
        ("user", "q2 unanswered"),
    ])
    assert _history_messages(db, "s1") == [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
    ]


def test_consecutive_same_role_merged(db):
    seed(db, "s1", [
        ("user", "first"),
        ("user", "second"),
        ("assistant", "got both"),
    ])
    assert _history_messages(db, "s1") == [
        {"role": "user", "content": "first\n\nsecond"},
        {"role": "assistant", "content": "got both"},
    ]


def test_result_starts_user_ends_assistant(db):
    # Messy history: leading assistant, double user, trailing user.
    seed(db, "s1", [
        ("assistant", "x"),
        ("user", "a"),
        ("user", "b"),
        ("assistant", "c"),
        ("user", "d"),
    ])
    out = _history_messages(db, "s1")
    assert out[0]["role"] == "user"
    assert out[-1]["role"] == "assistant"
    # roles strictly alternate
    roles = [m["role"] for m in out]
    assert all(roles[i] != roles[i + 1] for i in range(len(roles) - 1))


def test_unknown_role_skipped(db):
    seed(db, "s1", [
        ("user", "hi"),
        ("system", "should not appear"),
        ("assistant", "bye"),
    ])
    assert _history_messages(db, "s1") == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "bye"},
    ]
