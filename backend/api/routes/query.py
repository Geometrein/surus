"""Query execution + EXPLAIN routes.

Reads run on the read-only pool. A statement runs on the write pool only when
the request sets ``write`` — driven by the editor's explicit write-mode toggle.
EXPLAIN always stays read-only.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from backend.api import deps
from backend.api.routes.settings import get_preview_row_limit
from backend.db import query as q
from backend.db import querylog
from backend.store.db import get_session

router = APIRouter(prefix="/connections/{connection_id}", tags=["query"])


def _clean_sql(sql: str) -> str:
    """Strip surrounding whitespace and trailing semicolons."""
    return sql.strip().rstrip(";")


class QueryIn(BaseModel):
    sql: str
    maxRows: int | None = None
    # Opt into the write pool. Set only by the editor's write-mode toggle; the
    # agent has no path here. EXPLAIN is unaffected — it always runs read-only.
    write: bool = False


class ExplainIn(BaseModel):
    sql: str
    analyze: bool = False


@router.post("/query")
def run_query(
    connection_id: str, body: QueryIn, s: Session = Depends(get_session)
) -> dict:
    db = deps.get_database(connection_id)
    sql = _clean_sql(body.sql)
    if not sql:
        raise HTTPException(400, "Empty query")
    # Cap editor result rows at the configured preview limit by default;
    # ``truncated`` then flags "more rows available". A caller may pass an
    # explicit count, or ``maxRows <= 0`` to opt out of the cap entirely (the
    # editor's "Load all rows" action) and fetch the full result set.
    if body.maxRows is None:
        max_rows: int | None = get_preview_row_limit(s)
    elif body.maxRows <= 0:
        max_rows = None
    else:
        max_rows = body.maxRows
    try:
        with querylog.source("user"):
            result = db.run_query(
                sql, max_rows=max_rows, connection_id=connection_id, write=body.write
            )
    except Exception as exc:  # noqa: BLE001 - surface SQL errors to the client
        raise HTTPException(400, str(exc))
    return {
        "columns": result.columns,
        "rows": result.rows,
        "rowCount": result.rowcount,
        "truncated": result.truncated,
        "durationMs": round(result.duration_ms, 1),
        "notice": result.notice,
    }


@router.post("/query/cancel")
def cancel_query(connection_id: str) -> dict:
    """Cancel the running query for this connection.

    The dialect cancels via a one-off connection (not from the pool) so we can
    never deadlock waiting for a pool slot the running query already holds.
    """
    pid = q.get_running_pid(connection_id)
    if pid is None:
        return {"ok": False, "reason": "no running query"}
    db = deps.get_database(connection_id)
    try:
        return {"ok": db.cancel(pid)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Cancel failed: {exc}")


@router.post("/explain")
def explain(connection_id: str, body: ExplainIn) -> dict:
    db = deps.get_database(connection_id)
    sql = _clean_sql(body.sql)
    if not sql:
        raise HTTPException(400, "Empty query")
    try:
        with querylog.source("user"):
            plan = db.run_explain(sql, analyze=body.analyze)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, str(exc))
    return {"plan": plan}
