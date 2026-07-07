"""Agent tool definitions (JSON schema) and their handlers.

All handlers run against the **read-only** pool, so the agent can explore and
benchmark queries but never mutate the database.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Callable

from backend.db import querylog
from backend.db.introspect import serialize_foreign_key

if TYPE_CHECKING:
    from backend.db.dialects.base import Dialect

# A zero-arg callable returning the user's saved queries (name/folder/sql), or
# None when the agent has no workspace to read from. Injected per session.
SavedQueriesLoader = Callable[[], list[dict[str, Any]]]

# Tool schemas sent to the model. Prescriptive descriptions ("call this
# when...") materially improve when the model reaches for each tool.
TOOL_DEFS: list[dict] = [
    {
        "name": "run_explain",
        "description": (
            "Run EXPLAIN on a SELECT query and return the JSON plan. Call this "
            "to evaluate whether a query is performant BEFORE returning it: look "
            "for sequential scans on large tables, bad row estimates, and unused "
            "indexes. Only set analyze=true if the plain EXPLAIN plan looks cheap "
            "(low estimated rows, index scans) — ANALYZE actually executes the "
            "query, which can be slow or resource-intensive on large tables."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "A single SELECT statement."},
                "analyze": {
                    "type": "boolean",
                    "description": "If true, run EXPLAIN ANALYZE (executes the query).",
                },
            },
            "required": ["sql"],
        },
    },
    {
        "name": "run_query",
        "description": (
            "Execute a read-only SELECT and return a small sample of rows. Call "
            "this to check that a query returns sensible results, or to inspect "
            "sample values. Always limited; never use for writes."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "A single SELECT statement."},
                "limit": {
                    "type": "integer",
                    "description": "Max rows to return (default 20, capped at 100).",
                },
            },
            "required": ["sql"],
        },
    },
    {
        "name": "inspect_schema",
        "description": (
            "Get detailed columns, types, primary keys, foreign keys, and indexes "
            "for one table. Call this when you need detail on a table that wasn't "
            "fully described in the schema context."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "schema": {"type": "string", "description": "Schema name, e.g. 'public'."},
                "table": {"type": "string", "description": "Table name."},
            },
            "required": ["schema", "table"],
        },
    },
    {
        "name": "render_chart",
        "description": (
            "Draw a chart in the chat to visualize data. Call this when a trend, "
            "comparison, distribution, or time series reads better as a picture "
            "than a table — the UI runs your SELECT and renders it with a charting "
            "library. Provide a SELECT that returns tidy rows already aggregated "
            "and ordered for plotting (e.g. one row per month, ORDER BY month), "
            "keep it to a few hundred rows, and map columns to the axes. You can "
            "still explain the chart in text afterwards; this does not end your turn."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "A single SELECT returning the rows to plot."},
                "chart_type": {
                    "type": "string",
                    "enum": ["line", "bar", "area", "pie", "scatter"],
                    "description": "The chart to draw.",
                },
                "x": {
                    "type": "string",
                    "description": "Column for the x-axis (or the category/label for pie).",
                },
                "y": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "One or more numeric columns to plot on the y-axis. Use "
                        "exactly one for pie and scatter."
                    ),
                },
                "series": {
                    "type": "string",
                    "description": (
                        "Optional column whose distinct values become separate "
                        "series (use with a single y column)."
                    ),
                },
                "title": {"type": "string", "description": "Optional chart title."},
            },
            "required": ["sql", "chart_type", "x", "y"],
        },
    },
    {
        "name": "list_saved_queries",
        "description": (
            "List the SQL queries the user has already saved in their workspace "
            "for this connection. Call this early to check whether a suitable "
            "query already exists (reuse or adapt it rather than writing from "
            "scratch) and to learn the user's conventions — which tables and "
            "filters they actually use, and the shape of a 'known-good' query on "
            "a large table (so you don't sample it blindly). Returns each saved "
            "query's name, folder, and SQL. Takes no arguments."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "submit_query",
        "description": (
            "Return the final answer. Call this exactly once, after the plan is "
            "sound, to hand back the finished SELECT and a short rationale. The UI "
            "renders the query with an 'Open in editor' action, so put the SQL "
            "here rather than in a markdown code block."
        ),
        # strict guarantees the input validates exactly against this schema, so
        # the UI can rely on {sql, rationale} always being present and well-formed.
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "The final SELECT statement (no trailing semicolon needed).",
                },
                "rationale": {
                    "type": "string",
                    "description": (
                        "A brief explanation: what the query does and why it is "
                        "efficient (key plan nodes, indexes used)."
                    ),
                },
            },
            "required": ["sql", "rationale"],
            "additionalProperties": False,
        },
    },
]


# In "question" mode the agent only reads — no EXPLAIN/tuning or submit_query —
# but it can still visualize what it finds.
_QA_TOOL_NAMES = {"inspect_schema", "run_query", "list_saved_queries", "render_chart"}


def tools_for_mode(mode: str) -> list[dict]:
    """The subset of tool definitions available in a given chat mode."""
    if mode == "question":
        return [t for t in TOOL_DEFS if t["name"] in _QA_TOOL_NAMES]
    return TOOL_DEFS


def execute_tool(
    dialect: "Dialect",
    pool: Any,
    name: str,
    tool_input: dict[str, Any],
    statement_timeout_ms: int | None = None,
    saved_queries_loader: "SavedQueriesLoader | None" = None,
) -> tuple[str, bool]:
    """Run a tool. Returns (result_text, is_error)."""
    with querylog.source("agent"):
        return _execute_tool(
            dialect, pool, name, tool_input, statement_timeout_ms, saved_queries_loader
        )


def _execute_tool(
    dialect: "Dialect",
    pool: Any,
    name: str,
    tool_input: dict[str, Any],
    statement_timeout_ms: int | None = None,
    saved_queries_loader: "SavedQueriesLoader | None" = None,
) -> tuple[str, bool]:
    try:
        if name == "list_saved_queries":
            queries = saved_queries_loader() if saved_queries_loader else []
            if not queries:
                return "No saved queries found (no workspace open, or it's empty).", False
            payload = [
                {"name": q["name"], "folder": q.get("folder_id"), "sql": q["sql"]}
                for q in queries
            ]
            return json.dumps(payload, default=str), False

        if name == "run_explain":
            plan = dialect.run_explain(
                pool, tool_input["sql"], analyze=bool(tool_input.get("analyze", False)),
                statement_timeout_ms=statement_timeout_ms,
            )
            return json.dumps(plan, indent=2, default=str), False

        if name == "run_query":
            limit = min(int(tool_input.get("limit", 20)), 100)
            result = dialect.run_query(
                pool, tool_input["sql"], max_rows=limit,
                statement_timeout_ms=statement_timeout_ms,
            )
            payload = {
                "columns": result.columns,
                "rows": result.rows,
                "row_count": result.rowcount,
                "truncated": result.truncated,
                "duration_ms": round(result.duration_ms, 1),
            }
            return json.dumps(payload, default=str), False

        if name == "render_chart":
            # Validate the SELECT + column mapping so a wrong column name gets
            # feedback; the UI re-runs this SQL (larger cap) to draw the chart.
            y = tool_input.get("y") or []
            if isinstance(y, str):
                y = [y]
            result = dialect.run_query(
                pool, tool_input["sql"], max_rows=50,
                statement_timeout_ms=statement_timeout_ms,
            )
            cols = set(result.columns)
            needed = [tool_input.get("x")] + list(y)
            if tool_input.get("series"):
                needed.append(tool_input["series"])
            missing = [c for c in needed if c and c not in cols]
            if missing:
                return (
                    f"Columns {missing} are not in the query result. Available "
                    f"columns: {result.columns}. Fix x/y/series to match the SELECT.",
                    True,
                )
            payload = {
                "status": "chart rendered in the chat",
                "chart_type": tool_input.get("chart_type"),
                "columns": result.columns,
                "sample_rows": result.rowcount,
            }
            return json.dumps(payload, default=str), False

        if name == "submit_query":
            # Terminal "return" tool: the sql/rationale are surfaced to the UI
            # from the tool_call event itself. Just acknowledge so the model can
            # end its turn (a strict schema already validated the input).
            return "Query submitted to the user.", False

        if name == "inspect_schema":
            detail = dialect.get_table_detail(
                pool, tool_input["schema"], tool_input["table"]
            )
            if detail is None:
                return f"Table {tool_input['schema']}.{tool_input['table']} not found.", True
            payload = {
                "table": detail.qualified,
                "row_estimate": detail.row_estimate,
                "columns": [
                    {"name": c.name, "type": c.data_type, "nullable": c.nullable,
                     "is_pk": c.is_pk, "default": c.default}
                    for c in detail.columns
                ],
                "foreign_keys": [serialize_foreign_key(fk) for fk in detail.foreign_keys],
                "indexes": [{"name": i.name, "definition": i.definition} for i in detail.indexes],
            }
            return json.dumps(payload, default=str), False

        return f"Unknown tool: {name}", True
    except Exception as exc:  # noqa: BLE001 - surface DB errors back to the model
        return f"Error running {name}: {exc}", True
