"""Schema introspection routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from backend.api import deps
from backend.api.routes import chat
from backend.db.introspect import serialize_foreign_key

router = APIRouter(prefix="/connections/{connection_id}", tags=["schema"])


@router.post("/schema/refresh")
def refresh_schema(connection_id: str) -> dict:
    """Invalidate the snapshot and agent context caches, then rebuild the snapshot."""
    db = deps.get_database(connection_id)
    db.refresh_snapshot()
    refreshed = chat.refresh_connection_context(connection_id)
    return {"ok": True, "agentContextsRefreshed": refreshed}


@router.get("/schema")
def get_schema(connection_id: str) -> dict:
    db = deps.get_database(connection_id)
    snap = db.snapshot
    grouped: dict[str, list] = {}
    for t in snap.tables:
        grouped.setdefault(t.schema, []).append(
            {"schema": t.schema, "name": t.name, "kind": t.kind,
             "rowEstimate": t.row_estimate}
        )
    return {"schemas": [{"name": k, "tables": v} for k, v in grouped.items()]}


@router.get("/schema/columns")
def get_all_columns(connection_id: str) -> dict:
    db = deps.get_database(connection_id)
    snap = db.snapshot
    result: dict[str, dict[str, list[str]]] = {}
    for t in snap.tables:
        result.setdefault(t.schema, {})[t.name] = [col.name for col in t.columns]
    return result


@router.get("/schema/relationships")
def get_relationships(connection_id: str) -> dict:
    """Full relationship graph for the database: table nodes + FK edges.

    Served from the cached snapshot (same source as ``/snapshot``), so it adds
    no catalog queries. Edges are already restricted to surviving tables and FK
    columns are pre-flagged so the UI needs no per-table round trip.
    """
    db = deps.get_database(connection_id)
    snap = db.snapshot
    return {
        "tables": [
            {
                "schema": t.schema,
                "name": t.name,
                "kind": t.kind,
                "rowEstimate": t.row_estimate,
                "columns": [
                    {"name": col.name,
                     "isFk": any(fk.column == col.name for fk in t.foreign_keys)}
                    for col in t.columns
                ],
            }
            for t in snap.tables
        ],
        "edges": snap.edges,
    }


@router.get("/schema/{schema}/{table}")
def get_table(connection_id: str, schema: str, table: str) -> dict:
    db = deps.get_database(connection_id)
    detail = db.get_table_detail(schema, table)
    if detail is None:
        raise HTTPException(404, "Table not found")
    return {
        "schema": detail.schema,
        "name": detail.name,
        "kind": detail.kind,
        "rowEstimate": detail.row_estimate,
        "columns": [
            {"name": c.name, "type": c.data_type, "nullable": c.nullable,
             "isPk": c.is_pk, "default": c.default}
            for c in detail.columns
        ],
        "foreignKeys": [serialize_foreign_key(fk) for fk in detail.foreign_keys],
        "indexes": [
            {"name": i.name, "definition": i.definition,
             "isUnique": i.is_unique, "isPrimary": i.is_primary}
            for i in detail.indexes
        ],
    }
