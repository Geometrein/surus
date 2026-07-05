"""Query-log feed: every SQL statement the app has sent to a database.

The frontend polls this with the highest ``seq`` it has already ingested, so it
only ever pulls new entries.
"""

from __future__ import annotations

from fastapi import APIRouter

from backend.db import querylog

router = APIRouter(tags=["logs"])


@router.get("/logs/queries")
def query_logs(after: int = 0) -> dict:
    entries = querylog.get_since(after)
    last_seq = entries[-1]["seq"] if entries else after
    return {"entries": entries, "lastSeq": last_seq}
