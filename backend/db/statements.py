"""Statement-level validation for the read-only execution paths.

The read-only pool sets ``default_transaction_read_only`` as a *session* GUC.
That is not a hard wall: a statement can flip the current transaction with
``SET TRANSACTION READ WRITE``, and psycopg3 permits several semicolon-separated
commands in one ``execute()`` when no parameters are bound — so a chained
``SET TRANSACTION READ WRITE; UPDATE …`` would slip past the GUC if the
connecting role has write privileges.

The *sound* fix for that is to connect as a role that only holds ``SELECT`` (or
to a hot standby). This module is **defense-in-depth** for the common case where
the user connects with a writable role: it refuses anything that isn't a single
statement, and refuses statements that try to change the transaction access
mode. Its second job is UX — turning a would-be silent bypass into a clear error
instead of a raw driver failure.

The scanner is a small hand-rolled tokenizer (no SQL-parser dependency) that
understands the lexical constructs a naive ``split(";")`` gets wrong: single-
and double-quoted strings with doubled-quote escapes, dollar-quoted strings,
line comments (``--``), and nested block comments (``/* */``).
"""

from __future__ import annotations

import re


class UnsafeStatementError(ValueError):
    """SQL headed for the read-only pool isn't a single, safe statement."""


def _dollar_tag(sql: str, i: int) -> str | None:
    """Return the dollar-quote tag opening at ``i`` (e.g. ``$$`` or ``$fn$``), else None."""
    j = i + 1
    while j < len(sql) and (sql[j].isalnum() or sql[j] == "_"):
        j += 1
    if j < len(sql) and sql[j] == "$":
        return sql[i : j + 1]
    return None


def _segments(sql: str) -> list[tuple[bool, str]]:
    """Split ``sql`` into ``(is_code, text)`` segments.

    ``is_code`` is False for string literals and comments (regions where a
    ``;`` or keyword must be ignored) and True for everything else. Concatenating
    all ``text`` reproduces the input exactly.
    """
    segs: list[tuple[bool, str]] = []
    n = len(sql)
    i = code_start = 0

    def push_code(upto: int) -> None:
        nonlocal code_start
        if upto > code_start:
            segs.append((True, sql[code_start:upto]))

    while i < n:
        ch = sql[i]
        # Line comment: -- to end of line.
        if ch == "-" and sql[i + 1 : i + 2] == "-":
            push_code(i)
            j = sql.find("\n", i)
            j = n if j == -1 else j
            segs.append((False, sql[i:j]))
            i = code_start = j
            continue
        # Block comment: /* ... */, which nests in PostgreSQL.
        if ch == "/" and sql[i + 1 : i + 2] == "*":
            push_code(i)
            depth, j = 1, i + 2
            while j < n and depth:
                if sql[j : j + 2] == "/*":
                    depth += 1
                    j += 2
                elif sql[j : j + 2] == "*/":
                    depth -= 1
                    j += 2
                else:
                    j += 1
            segs.append((False, sql[i:j]))
            i = code_start = j
            continue
        # Single/double-quoted string; a doubled quote is an escaped quote.
        if ch in ("'", '"'):
            push_code(i)
            quote, j = ch, i + 1
            while j < n:
                if sql[j] == quote:
                    if sql[j + 1 : j + 2] == quote:
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            segs.append((False, sql[i:j]))
            i = code_start = j
            continue
        # Dollar-quoted string: $tag$ ... $tag$.
        if ch == "$":
            tag = _dollar_tag(sql, i)
            if tag is not None:
                push_code(i)
                end = sql.find(tag, i + len(tag))
                end = n if end == -1 else end + len(tag)
                segs.append((False, sql[i:end]))
                i = code_start = end
                continue
        i += 1

    push_code(n)
    return segs


def split_statements(sql: str) -> list[str]:
    """Split ``sql`` into top-level statements on unquoted, uncommented ``;``.

    Statements are stripped of surrounding whitespace; empties are dropped.
    """
    statements: list[str] = []
    current: list[str] = []
    for is_code, text in _segments(sql):
        if not is_code:
            current.append(text)
            continue
        parts = text.split(";")
        for k, part in enumerate(parts):
            current.append(part)
            if k < len(parts) - 1:  # a ';' followed this part
                statements.append("".join(current))
                current = []
    statements.append("".join(current))
    return [s.strip() for s in statements if s.strip()]


def _code_skeleton(sql: str) -> str:
    """``sql`` with string/comment regions blanked out, for keyword matching."""
    return "".join(text if is_code else " " for is_code, text in _segments(sql))


# Transaction-access-mode changes that would defeat the read-only session GUC.
_TXN_MODE_RE = re.compile(
    r"""
      \bset\s+(?:session\s+|local\s+)?transaction\b[^;]*\bread\s+write\b
    | \bset\s+session\s+characteristics\b[^;]*\bread\s+write\b
    | \bset\s+(?:session\s+|local\s+)?default_transaction_read_only\b
    | \breset\s+default_transaction_read_only\b
    | \breset\s+all\b
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _changes_transaction_mode(sql: str) -> bool:
    return bool(_TXN_MODE_RE.search(_code_skeleton(sql)))


def ensure_read_only_safe(sql: str) -> None:
    """Raise :class:`UnsafeStatementError` if ``sql`` isn't safe for the RO pool.

    Enforced invariants:

    * exactly one statement (multi-statement chaining is how a write rides in
      behind a ``SET TRANSACTION READ WRITE``); and
    * no attempt to change the transaction access mode / read-only GUC.

    This is a guardrail, not a substitute for connecting as a read-only role.
    """
    statements = split_statements(sql)
    if not statements or not _code_skeleton(statements[0]).strip():
        raise UnsafeStatementError("Empty query.")
    if len(statements) > 1:
        raise UnsafeStatementError(
            "Multiple SQL statements are not allowed here — run one statement at a time."
        )
    if _changes_transaction_mode(statements[0]):
        raise UnsafeStatementError(
            "Changing the transaction access mode is not permitted on a read-only connection."
        )
