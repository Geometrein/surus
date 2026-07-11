"""Catalog snapshot endpoints for the ERD and schema tree.

The base snapshot is metadata only (names/columns/FKs); on-disk table sizes are
served separately by ``/snapshot/sizes`` so they're only computed when the ERD's
"sizes" toggle asks for them.
"""

from __future__ import annotations

from fastapi import APIRouter

from backend.api import deps

router = APIRouter(prefix="/connections/{connection_id}", tags=["snapshot"])


@router.get("/snapshot")
def get_snapshot(connection_id: str) -> dict:
    db = deps.get_database(connection_id)
    s = db.snapshot
    return {
        "sampledAt": s.sampled_at,
        "tables": [
            {
                "schema":      t.schema,
                "name":        t.name,
                "kind":        t.kind,
                "rowEstimate": t.row_estimate,
                "columns": [
                    {"name": col.name, "type": col.data_type,
                     "isFk": any(fk.column == col.name for fk in t.foreign_keys)}
                    for col in t.columns
                ],
            }
            for t in s.tables
        ],
        "edges": s.edges,
    }


@router.get("/snapshot/sizes")
def get_snapshot_sizes(connection_id: str) -> dict:
    """Per-table on-disk sizes — the expensive query, run only when requested."""
    db = deps.get_database(connection_id)
    return {
        "sizes": [
            {"schema": t.schema, "name": t.name, "sizeBytes": t.total_bytes}
            for t in db.table_sizes()
        ],
    }


@router.post("/snapshot/refresh")
def refresh_snapshot(connection_id: str) -> dict:
    db = deps.get_database(connection_id)
    db.refresh_snapshot()
    return {"ok": True}
