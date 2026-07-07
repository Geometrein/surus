"""View row-estimate substitution (estimate_view_rows / _fill_view_estimates).

A plain view has no stored reltuples, so its catalog row estimate is 0; these
helpers replace it with the planner's EXPLAIN estimate. Driven by a fake pool —
no real database.
"""

from __future__ import annotations

from contextlib import contextmanager

from backend.db.introspect import Table, _fill_view_estimates, estimate_view_rows


class _FakePool:
    """Pool whose EXPLAIN returns a canned plan row-count per (schema, name).

    ``plans`` maps qualified name -> estimated rows. A name mapped to an
    ``Exception`` instance simulates a view that fails to plan.
    """

    def __init__(self, plans):
        self._plans = plans

    @contextmanager
    def connection(self):
        pool = self

        class _Cur:
            def __init__(self_):
                self_._result = None

            def __enter__(self_):
                return self_

            def __exit__(self_, *a):
                return False

            def execute(self_, query, params=None):
                text = query.as_string(None) if hasattr(query, "as_string") else str(query)
                if "EXPLAIN" not in text:  # ignore SET LOCAL statement_timeout etc.
                    return
                # Map by the (schema, name) rendered into the EXPLAIN by sql.Identifier.
                key = next(k for k in pool._plans if f'"{k[0]}"."{k[1]}"' in text)
                val = pool._plans[key]
                if isinstance(val, Exception):
                    raise val
                self_._result = ([{"Plan": {"Plan Rows": val}}],)

            def fetchone(self_):
                return self_._result

        class _Txn:
            def __enter__(self_):
                return self_

            def __exit__(self_, *a):
                return False  # propagate so estimate_view_rows' except catches it

        class _Conn:
            def transaction(self_):
                return _Txn()

            def cursor(self_, row_factory=None):
                return _Cur()

        yield _Conn()


def test_estimate_view_rows_uses_planner_estimate():
    pool = _FakePool({("commerce", "order_summary"): 4210,
                      ("marketing", "campaign_performance"): 87})
    est = estimate_view_rows(
        pool, [("commerce", "order_summary"), ("marketing", "campaign_performance")]
    )
    assert est == {("commerce", "order_summary"): 4210,
                   ("marketing", "campaign_performance"): 87}


def test_estimate_view_rows_skips_unplannable_view():
    pool = _FakePool({("public", "good"): 5,
                      ("public", "broken"): RuntimeError("relation missing")})
    est = estimate_view_rows(pool, [("public", "good"), ("public", "broken")])
    assert est == {("public", "good"): 5}  # broken one omitted, good one kept


def test_estimate_view_rows_empty_is_noop():
    # No pool interaction at all when there are no views.
    assert estimate_view_rows(None, []) == {}


def test_fill_view_estimates_only_touches_zero_row_views():
    pool = _FakePool({("commerce", "order_summary"): 4210})
    tables = [
        Table(schema="commerce", name="order_summary", kind="view", row_estimate=0),
        Table(schema="commerce", name="orders", kind="table", row_estimate=999),
        # A view that somehow already has an estimate is left alone (not re-planned).
        Table(schema="analytics", name="product_sales", kind="matview", row_estimate=50),
    ]
    _fill_view_estimates(pool, tables)
    by_name = {t.name: t.row_estimate for t in tables}
    assert by_name == {"order_summary": 4210, "orders": 999, "product_sales": 50}
