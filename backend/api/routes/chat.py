"""Chat sessions + streaming agent (SSE).

Sessions and messages persist in SQLite. The live agent conversation state lives
in an in-memory provider per session (rebuilt on backend restart; history stays
in SQLite for display).
"""

from __future__ import annotations

import json
import queue
import threading

import keyring
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from backend.agent.provider import build_provider, provider_for_model
from backend.api import deps
from backend.api.routes.queries import load_saved_queries
from backend.api.routes.settings import (
    get_agent_max_steps,
    get_agent_max_tokens,
    get_agent_timeout_sec,
    get_custom_instructions,
    get_default_model,
)
from backend.config import KEYRING_SERVICE, llm_key_username
from backend.store.db import get_session, session as new_session
from backend.store.models import ChatMessage, ChatSession

router = APIRouter(prefix="/chat", tags=["chat"])

# In-memory agent providers keyed by chat session id. A provider owns mutable
# conversation state (``provider.messages``) that a single tool-use loop mutates
# in place, so concurrent sends to the *same* session would corrupt it. Each
# session gets a lock; a second in-flight send is rejected rather than
# interleaved. dict.setdefault is atomic under the GIL, so the registry itself
# needs no extra guard.
_providers: dict[str, object] = {}
_session_locks: dict[str, threading.Lock] = {}


def _session_lock(session_id: str) -> threading.Lock:
    return _session_locks.setdefault(session_id, threading.Lock())


class SessionIn(BaseModel):
    connectionId: str
    model: str = ""
    mode: str = "sql"
    title: str = ""


class SessionPatch(BaseModel):
    title: str


class MessageIn(BaseModel):
    content: str


@router.post("/sessions")
def create_session(body: SessionIn, s: Session = Depends(get_session)) -> ChatSession:
    title = body.title.strip()
    if not title:
        count = len(
            s.exec(
                select(ChatSession.id).where(ChatSession.connection_id == body.connectionId)
            ).all()
        )
        title = f"Chat {count + 1}"
    model = body.model or get_default_model(s)
    row = ChatSession(connection_id=body.connectionId, model=model, mode=body.mode, title=title)
    s.add(row)
    s.commit()
    s.refresh(row)
    return row


@router.patch("/sessions/{session_id}")
def rename_session(
    session_id: str, body: SessionPatch, s: Session = Depends(get_session)
) -> ChatSession:
    row = s.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(404, "Chat session not found")
    title = body.title.strip()
    if title:
        row.title = title
        s.add(row)
        s.commit()
        s.refresh(row)
    return row


@router.get("/sessions")
def list_sessions(connectionId: str, s: Session = Depends(get_session)) -> list[ChatSession]:
    return s.exec(
        select(ChatSession)
        .where(ChatSession.connection_id == connectionId)
        .order_by(ChatSession.created_at.desc())
    ).all()


@router.get("/sessions/{session_id}/messages")
def list_messages(session_id: str, s: Session = Depends(get_session)) -> list[ChatMessage]:
    return s.exec(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at)
    ).all()


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str, s: Session = Depends(get_session)) -> dict:
    _providers.pop(session_id, None)
    _session_locks.pop(session_id, None)
    for m in s.exec(select(ChatMessage).where(ChatMessage.session_id == session_id)).all():
        s.delete(m)
    row = s.get(ChatSession, session_id)
    if row:
        s.delete(row)
    s.commit()
    return {"ok": True}


def refresh_connection_context(connection_id: str) -> int:
    """Drop cached agent schema context for every live session on a connection.

    Conversation history is kept; only the stale schema block is rebuilt on the
    next message. Returns how many in-memory providers were refreshed.
    """
    with new_session() as s:
        session_ids = s.exec(
            select(ChatSession.id).where(ChatSession.connection_id == connection_id)
        ).all()
    refreshed = 0
    for sid in session_ids:
        provider = _providers.get(sid)
        if provider is not None:
            provider.refresh_context()
            refreshed += 1
    return refreshed


def _history_messages(s: Session, session_id: str) -> list[dict]:
    """Rebuild the provider conversation from persisted chat messages.

    Only each turn's text is restored (tool-use/thinking blocks were transient).
    The result is normalized to the alternating user/assistant shape the
    Anthropic API requires: it starts with a user turn, consecutive same-role
    turns are merged, and a trailing user turn is dropped so the next live user
    message continues cleanly.
    """
    rows = s.exec(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at)
    ).all()
    messages: list[dict] = []
    for row in rows:
        content = row.content.strip()
        if not content or row.role not in ("user", "assistant"):
            continue
        if messages and messages[-1]["role"] == row.role:
            messages[-1]["content"] += "\n\n" + content
        else:
            messages.append({"role": row.role, "content": content})
    if messages and messages[0]["role"] == "assistant":
        messages.pop(0)  # history must open on a user turn
    if messages and messages[-1]["role"] == "user":
        messages.pop()  # the next live message is the user's
    return messages


def _get_provider(session: ChatSession, s: Session):
    provider = _providers.get(session.id)
    if provider is None:
        provider_name = provider_for_model(session.model)
        api_key = keyring.get_password(KEYRING_SERVICE, llm_key_username(provider_name))
        if not api_key:
            raise HTTPException(400, f"No {provider_name} API key set (Settings).")
        db = deps.get_database(session.connection_id)  # raises 409 if not connected
        connection_id = session.connection_id
        provider = build_provider(
            provider_name, api_key, session.model, db.ro, plugins=db.plugins, dialect=db.dialect,
            custom_instructions=get_custom_instructions(s),
            statement_timeout_ms=get_agent_timeout_sec(s) * 1000,
            mode=session.mode,
            max_steps=get_agent_max_steps(s),
            max_tokens=get_agent_max_tokens(s),
            saved_queries_loader=lambda: load_saved_queries(connection_id),
        )
        # Rehydrate prior turns so reopening an old chat (or a backend restart)
        # doesn't start the agent with an empty conversation.
        provider.seed_history(_history_messages(s, session.id))
        _providers[session.id] = provider
    return provider


@router.post("/sessions/{session_id}/messages")
def send_message(session_id: str, body: MessageIn, s: Session = Depends(get_session)):
    session = s.get(ChatSession, session_id)
    if session is None:
        raise HTTPException(404, "Chat session not found")

    # Serialize sends per session: the provider's history is mutated in place, so
    # a concurrent send would corrupt it. Held across all provider/DB work below.
    lock = _session_lock(session_id)
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "This chat is already generating a response.")
    try:
        provider = _get_provider(session, s)
        provider.clear_stop()  # a prior stop() must not carry into this send
        # Persist the user message.
        s.add(ChatMessage(session_id=session_id, role="user", content=body.content))
        s.commit()
    except BaseException:
        lock.release()
        raise

    # Run the agent in a background thread that owns the lock and drains into a
    # queue, so a client disconnect can't strand the lock (worker still releases
    # it in finally, at completion or the next cancel checkpoint).
    events: "queue.Queue[dict | None]" = queue.Queue()

    def worker():
        text_parts: list[str] = []
        steps: list[dict] = []
        try:
            for ev in provider.send(body.content):
                data = {
                    "kind": ev.kind,
                    "text": ev.text,
                    "toolName": ev.tool_name,
                    "toolInput": ev.tool_input,
                    "ok": ev.ok,
                }
                if ev.kind == "text":
                    text_parts.append(ev.text)
                elif ev.kind in ("tool_call", "tool_result"):
                    steps.append(data)
                events.put(data)
        except Exception as exc:  # noqa: BLE001
            events.put({"kind": "error", "text": str(exc)})
        finally:
            with new_session() as ws:
                ws.add(ChatMessage(
                    session_id=session_id,
                    role="assistant",
                    content="".join(text_parts),
                    steps_json=json.dumps(steps) if steps else None,
                ))
                ws.commit()
            lock.release()
            events.put(None)  # sentinel: worker done

    threading.Thread(target=worker, name=f"chat-{session_id}", daemon=True).start()

    def event_stream():
        while True:
            data = events.get()
            if data is None:
                yield "data: {\"kind\": \"end\"}\n\n"
                return
            yield f"data: {json.dumps(data)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/sessions/{session_id}/stop")
def stop_message(session_id: str) -> dict:
    """Signal the provider's cancel flag so the worker halts at its next
    checkpoint and releases the lock. No-op if nothing is running."""
    provider = _providers.get(session_id)
    if provider is not None:
        provider.stop()
    return {"ok": True}
