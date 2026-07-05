"""Connection profile CRUD + connect/disconnect."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from backend.api import deps
from backend.api.routes.settings import get_query_timeout_sec
from backend.db import connections as conn_secrets
from backend.db.connections import ConnectionProfile
from backend.db.dialects import get_dialect
from backend.store.db import get_session
from backend.store.models import ConnectionRow

router = APIRouter(prefix="/connections", tags=["connections"])


class ConnectionIn(BaseModel):
    name: str = "Connection"
    kind: str = "postgres"
    host: str = "localhost"
    port: int = 5432
    dbname: str = "postgres"
    user: str = "postgres"
    password: str = ""
    sslmode: str = "prefer"
    color: str = ""


class ConnectionTestIn(ConnectionIn):
    # When editing, the form password may be blank ("unchanged"); pass the
    # existing connection id so the stored keychain password is used.
    id: str | None = None


class ConnectionOut(BaseModel):
    id: str
    name: str
    kind: str
    host: str
    port: int
    dbname: str
    user: str
    sslmode: str
    color: str
    connected: bool


def _to_out(row: ConnectionRow) -> ConnectionOut:
    return ConnectionOut(
        id=row.id, name=row.name, kind=row.kind, host=row.host, port=row.port, dbname=row.dbname,
        user=row.user, sslmode=row.sslmode, color=row.color,
        connected=deps.is_connected(row.id),
    )


@router.get("")
def list_connections(s: Session = Depends(get_session)) -> list[ConnectionOut]:
    rows = s.exec(select(ConnectionRow).order_by(ConnectionRow.created_at)).all()
    return [_to_out(r) for r in rows]


@router.post("/test")
def test_connection(body: ConnectionTestIn) -> dict:
    """Probe a connection with the given form values without saving it."""
    profile = ConnectionProfile(
        id=body.id or "test", name=body.name, kind=body.kind, host=body.host, port=body.port,
        dbname=body.dbname, user=body.user, sslmode=body.sslmode,
    )
    password = body.password or None
    if not password and body.id:
        password = conn_secrets.get_password(profile)
    try:
        version = get_dialect(profile.kind).probe(profile, password)
    except Exception as exc:  # noqa: BLE001 - surface a clean driver error
        raise HTTPException(400, str(exc).splitlines()[0])
    return {"ok": True, "version": version}


@router.post("")
def create_connection(body: ConnectionIn, s: Session = Depends(get_session)) -> ConnectionOut:
    row = ConnectionRow(
        name=body.name, kind=body.kind, host=body.host, port=body.port, dbname=body.dbname,
        user=body.user, sslmode=body.sslmode, color=body.color,
    )
    s.add(row)
    s.commit()
    s.refresh(row)
    if body.password:
        conn_secrets.set_password(row.to_profile(), body.password)
    return _to_out(row)


@router.put("/{connection_id}")
def update_connection(
    connection_id: str, body: ConnectionIn, s: Session = Depends(get_session)
) -> ConnectionOut:
    row = s.get(ConnectionRow, connection_id)
    if row is None:
        raise HTTPException(404, "Connection not found")
    row.name, row.kind, row.host, row.port = body.name, body.kind, body.host, body.port
    row.dbname, row.user, row.sslmode = body.dbname, body.user, body.sslmode
    row.color = body.color
    s.add(row)
    s.commit()
    s.refresh(row)
    if body.password:
        conn_secrets.set_password(row.to_profile(), body.password)
    return _to_out(row)


@router.delete("/{connection_id}")
def delete_connection(connection_id: str, s: Session = Depends(get_session)) -> dict:
    row = s.get(ConnectionRow, connection_id)
    if row is None:
        raise HTTPException(404, "Connection not found")
    deps.disconnect(connection_id)
    conn_secrets.delete_password(row.to_profile())
    s.delete(row)
    s.commit()
    return {"ok": True}


@router.post("/{connection_id}/connect")
def connect(connection_id: str, s: Session = Depends(get_session)) -> dict:
    row = s.get(ConnectionRow, connection_id)
    if row is None:
        raise HTTPException(404, "Connection not found")
    try:
        version = deps.connect(row.to_profile(), get_query_timeout_sec(s) * 1000)
    except Exception as exc:  # noqa: BLE001 - surface a clean driver error
        raise HTTPException(400, str(exc).splitlines()[0])
    return {"connected": True, "version": version}


@router.post("/{connection_id}/disconnect")
def disconnect(connection_id: str) -> dict:
    deps.disconnect(connection_id)
    return {"connected": False}


@router.get("/{connection_id}/info")
def get_info(connection_id: str) -> dict:
    db = deps.get_database(connection_id)
    return db.server_info()
