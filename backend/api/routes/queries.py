"""File-based query storage: .sql files inside a workspace directory.

Folder IDs are relative paths from the workspace root (e.g. "analytics" or
"analytics/reports"). Query IDs are also relative paths (e.g. "analytics/q.sql").
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from backend.store.db import get_session, session as new_session
from backend.store.models import ConnectionRow, Setting

router = APIRouter(prefix="/queries", tags=["queries"])

MARKER = ".surus"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _workspace(s: Session) -> Path | None:
    row = s.get(Setting, "workspace_path")
    if row is None or not row.value:
        return None
    p = Path(row.value)
    return p if p.is_dir() else None


def _require_workspace(s: Session) -> Path:
    ws = _workspace(s)
    if ws is None:
        raise HTTPException(400, "No workspace open — open a folder first")
    return ws


def _safe_name(name: str) -> str:
    """Sanitise a single directory/file name (no slashes allowed)."""
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip() or "unnamed"


def _resolve_folder(ws: Path, folder_id: str) -> Path:
    """Resolve a relative folder path safely; raises 400 on path traversal."""
    folder = (ws / folder_id).resolve()
    if not str(folder).startswith(str(ws.resolve())):
        raise HTTPException(400, "Invalid folder path")
    return folder


def _read_marker(folder: Path) -> str | None:
    marker = folder / MARKER
    if marker.exists():
        try:
            return json.loads(marker.read_text(encoding="utf-8")).get("connectionId")
        except Exception:
            pass
    return None


def _write_marker(folder: Path, connection_id: str) -> None:
    (folder / MARKER).write_text(
        json.dumps({"connectionId": connection_id}), encoding="utf-8"
    )


# The path is passed as an argv item (via `on run argv`), never interpolated
# into the script text, so a filename containing quotes can't break out of the
# AppleScript string.
_TRASH_SCRIPT = (
    'on run argv\n'
    '    tell application "Finder" to delete POSIX file (item 1 of argv)\n'
    'end run'
)


def _trash(path: Path) -> None:
    """Move *path* to the macOS Trash via osascript; raises HTTPException(500) on failure."""
    result = subprocess.run(
        ["osascript", "-e", _TRASH_SCRIPT, str(path)],
        capture_output=True,
    )
    if result.returncode != 0:
        raise HTTPException(500, "Could not move to Trash")


def _find_conn_id(path: Path, ws: Path) -> str | None:
    """Walk up from path toward workspace root looking for a .surus marker."""
    current = path.parent
    while True:
        conn_id = _read_marker(current)
        if conn_id:
            return conn_id
        if current == ws:
            break
        current = current.parent
    return None


def _folder_row(folder: Path, ws: Path) -> dict:
    return {
        "id": str(folder.relative_to(ws)),
        "name": folder.name,
        "connectionId": _read_marker(folder),
        "children": [
            _folder_row(p, ws)
            for p in sorted(folder.iterdir())
            if p.is_dir() and not p.name.startswith(".")
        ],
    }


def _list_folders(ws: Path) -> list[dict]:
    return [
        _folder_row(p, ws)
        for p in sorted(ws.iterdir())
        if p.is_dir() and not p.name.startswith(".")
    ]


def _query_row(path: Path, ws: Path) -> dict:
    folder = path.parent
    folder_id = str(folder.relative_to(ws)) if folder != ws else None
    return {
        "id": str(path.relative_to(ws)),
        "name": path.stem,
        "sql": path.read_text(encoding="utf-8"),
        "folder_id": folder_id,
        "connection_id": _find_conn_id(path, ws),
    }


def _list_queries(ws: Path) -> list[dict]:
    rows: list[dict] = []
    for p in sorted(ws.glob("*.sql")):
        rows.append(_query_row(p, ws))
    for folder in sorted(ws.iterdir()):
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        for p in sorted(folder.rglob("*.sql")):
            rows.append(_query_row(p, ws))
    return rows


def load_saved_queries(connection_id: str | None = None) -> list[dict]:
    """Saved ``.sql`` queries in the open workspace (opens its own session for the
    agent's worker thread). Filtered to ``connection_id`` when given; ``[]`` if no
    workspace is open."""
    with new_session() as s:
        ws = _workspace(s)
        if ws is None:
            return []
        rows = _list_queries(ws)
    if connection_id is None:
        return rows
    return [r for r in rows if r["connection_id"] in (connection_id, None)]


# ---------------------------------------------------------------------------
# Workspace
# ---------------------------------------------------------------------------

class WorkspaceIn(BaseModel):
    path: str


@router.get("/workspace")
def get_workspace(s: Session = Depends(get_session)) -> dict:
    row = s.get(Setting, "workspace_path")
    return {"path": row.value if row else None}


@router.post("/workspace")
def set_workspace(body: WorkspaceIn, s: Session = Depends(get_session)) -> dict:
    p = Path(body.path).expanduser().resolve()
    p.mkdir(parents=True, exist_ok=True)
    row = s.get(Setting, "workspace_path") or Setting(key="workspace_path")
    row.value = str(p)
    s.add(row)
    s.commit()
    return {"path": str(p)}


@router.post("/workspace/pick")
def pick_workspace(s: Session = Depends(get_session)) -> dict:
    result = subprocess.run(
        ["osascript", "-e",
         'POSIX path of (choose folder with prompt "Open Surus Workspace")'],
        capture_output=True, text=True,
    )
    path = result.stdout.strip().rstrip("/")
    if not path or result.returncode != 0:
        raise HTTPException(400, "No folder selected")
    p = Path(path)
    if not p.is_dir():
        raise HTTPException(400, f"Not a directory: {path}")
    row = s.get(Setting, "workspace_path") or Setting(key="workspace_path")
    row.value = str(p)
    s.add(row)
    s.commit()
    return {"path": str(p)}


@router.post("/workspace/reveal")
def reveal_workspace(s: Session = Depends(get_session)) -> dict:
    ws = _require_workspace(s)
    subprocess.Popen(["open", str(ws)])
    return {"ok": True}


# ---------------------------------------------------------------------------
# Folders
# ---------------------------------------------------------------------------

class FolderIn(BaseModel):
    name: str
    connectionId: str | None = None
    parentFolderId: str | None = None   # relative path of parent; None = workspace root


@router.get("/folders")
def list_folders(s: Session = Depends(get_session)) -> list:
    ws = _workspace(s)
    return _list_folders(ws) if ws else []


@router.post("/folders")
def create_folder(body: FolderIn, s: Session = Depends(get_session)) -> dict:
    ws = _require_workspace(s)
    parent = _resolve_folder(ws, body.parentFolderId) if body.parentFolderId else ws
    if not parent.is_dir():
        raise HTTPException(404, "Parent folder not found")
    folder = parent / _safe_name(body.name)
    folder.mkdir(exist_ok=True)
    if body.connectionId:
        _write_marker(folder, body.connectionId)
    return _folder_row(folder, ws)


@router.put("/folders/{folder_path:path}")
def rename_folder(
    folder_path: str, body: FolderIn, s: Session = Depends(get_session)
) -> dict:
    ws = _require_workspace(s)
    old = _resolve_folder(ws, folder_path)
    if not old.is_dir():
        raise HTTPException(404, "Folder not found")
    # parentFolderId="" → workspace root; None → keep old parent; "path" → move there
    if body.parentFolderId is None:
        new_parent = old.parent
    elif body.parentFolderId == "":
        new_parent = ws
    else:
        new_parent = _resolve_folder(ws, body.parentFolderId)
        if not new_parent.is_dir():
            raise HTTPException(404, "Target folder not found")
        # Prevent moving into itself or a descendant
        if str(new_parent).startswith(str(old.resolve())):
            raise HTTPException(400, "Cannot move a folder into itself")
    new = new_parent / _safe_name(body.name)
    if new.exists() and old.resolve() != new.resolve():
        raise HTTPException(409, f"'{body.name}' already exists")
    old.rename(new)
    return _folder_row(new, ws)


@router.delete("/folders/{folder_path:path}")
def delete_folder(folder_path: str, s: Session = Depends(get_session)) -> dict:
    ws = _require_workspace(s)
    folder = _resolve_folder(ws, folder_path)
    if not folder.is_dir():
        raise HTTPException(404, "Folder not found")
    _trash(folder)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------

class QueryIn(BaseModel):
    name: str
    sql: str
    connectionId: str | None = None
    folderId: str | None = None         # relative folder path; None = workspace root


@router.get("")
def list_queries(s: Session = Depends(get_session)) -> list:
    ws = _workspace(s)
    return _list_queries(ws) if ws else []


@router.post("")
def create_query(body: QueryIn, s: Session = Depends(get_session)) -> dict:
    ws = _require_workspace(s)

    if body.folderId:
        folder = _resolve_folder(ws, body.folderId)
        folder.mkdir(parents=True, exist_ok=True)
        if body.connectionId and not (folder / MARKER).exists():
            _write_marker(folder, body.connectionId)
    elif body.connectionId:
        folder = next(
            (p for p in ws.rglob("*") if p.is_dir() and _read_marker(p) == body.connectionId),
            None,
        )
        if folder is None:
            conn = s.get(ConnectionRow, body.connectionId)
            folder = ws / _safe_name(conn.name if conn else body.connectionId)
            folder.mkdir(exist_ok=True)
            _write_marker(folder, body.connectionId)
    else:
        folder = ws

    file_name = _safe_name(body.name) + ".sql"
    (folder / file_name).write_text(body.sql, encoding="utf-8")
    return _query_row(folder / file_name, ws)


@router.put("/{query_path:path}")
def update_query(
    query_path: str, body: QueryIn, s: Session = Depends(get_session)
) -> dict:
    ws = _require_workspace(s)
    old_path = (ws / query_path).resolve()
    if not old_path.exists():
        raise HTTPException(404, "Query not found")

    new_folder = _resolve_folder(ws, body.folderId) if body.folderId else ws
    new_folder.mkdir(parents=True, exist_ok=True)
    new_path = new_folder / (_safe_name(body.name) + ".sql")

    if old_path != new_path:
        old_path.unlink()
    new_path.write_text(body.sql, encoding="utf-8")
    return _query_row(new_path, ws)


@router.delete("/{query_path:path}")
def delete_query(query_path: str, s: Session = Depends(get_session)) -> dict:
    ws = _require_workspace(s)
    path = (ws / query_path).resolve()
    if not path.exists():
        raise HTTPException(404, "Query not found")
    _trash(path)
    return {"ok": True}
