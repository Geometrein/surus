"""Gemini-backed agent: NL request -> performant SQL via a tool-use loop.

Same contract as :class:`~backend.agent.anthropic_provider.AnthropicProvider`
(the :class:`~backend.agent.provider.AgentProvider` protocol), so the chat UI is
unchanged. Only the transport differs: the loop runs against the Gemini API, the
shared tool schemas become ``FunctionDeclaration``s, and the schema context goes
in ``system_instruction`` (Gemini caches long prefixes implicitly, so there are
no explicit cache markers).

The assistant turn is stored as the SDK's own ``Content`` object rather than a
rebuilt copy: Gemini 3 returns thought signatures alongside function calls and
rejects a follow-up turn that drops them.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any, Iterator

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from backend.agent import context as ctx
from backend.agent.prompts import build_system_prompt
from backend.agent.provider import AgentEvent
from backend.agent.tools import execute_tool, tools_for_mode
from backend.config import DEFAULT_AGENT_MAX_STEPS, DEFAULT_AGENT_MAX_TOKENS
from backend.db.dialects import get_dialect

if TYPE_CHECKING:
    from backend.agent.tools import SavedQueriesLoader
    from backend.db.dialects.base import Dialect
    from backend.db.extensions import ExtensionPlugin


def _to_gemini_tools(defs: list[dict]) -> list[types.Tool]:
    """Translate the shared Anthropic-style tool defs to Gemini function decls."""
    declarations = [
        types.FunctionDeclaration(
            name=d["name"],
            description=d["description"],
            parameters_json_schema=d["input_schema"],
        )
        for d in defs
    ]
    return [types.Tool(function_declarations=declarations)]


def _function_calls(content: types.Content | None) -> list[types.FunctionCall]:
    parts = (content.parts if content else None) or []
    return [p.function_call for p in parts if p.function_call]


class GeminiProvider:
    def __init__(
        self,
        api_key: str,
        model: str,
        pool: Any,
        plugins: "list[ExtensionPlugin] | None" = None,
        dialect: "Dialect | None" = None,
        custom_instructions: str = "",
        statement_timeout_ms: int | None = None,
        mode: str = "sql",
        max_steps: int = DEFAULT_AGENT_MAX_STEPS,
        max_tokens: int = DEFAULT_AGENT_MAX_TOKENS,
        saved_queries_loader: "SavedQueriesLoader | None" = None,
    ):
        self.client = genai.Client(api_key=api_key)
        self.model = model
        self.pool = pool
        self.plugins = plugins or []
        self.dialect = dialect or get_dialect(None)
        self.custom_instructions = custom_instructions
        self.statement_timeout_ms = statement_timeout_ms
        self.mode = mode
        self.max_steps = max_steps
        self.max_tokens = max_tokens
        self.saved_queries_loader = saved_queries_loader
        # History holds Gemini Contents (roles "user"/"model"), without the
        # system instruction — that is (re)built lazily and passed per request.
        self.contents: list[types.Content] = []
        self._system_text: str | None = None
        # Set by stop() to interrupt an in-flight tool-use loop.
        self._cancel = threading.Event()

    def stop(self) -> None:
        """Request the current send() loop to halt at the next checkpoint."""
        self._cancel.set()

    def clear_stop(self) -> None:
        """Reset the cancel flag; call before starting a new send()."""
        self._cancel.clear()

    def reset(self) -> None:
        self.contents = []
        self._system_text = None

    def seed_history(self, messages: list[dict]) -> None:
        """Replace history from persisted turns.

        ``messages`` is the alternating user/assistant *text* shape shared with
        the other providers; Gemini names the assistant role "model".
        """
        self.contents = [
            types.Content(
                role="model" if m["role"] == "assistant" else "user",
                parts=[types.Part(text=m["content"])],
            )
            for m in messages
        ]

    def refresh_context(self) -> None:
        """Drop the cached schema/stats context so it rebuilds next turn."""
        self._system_text = None

    def _system(self) -> str:
        if self._system_text is None:
            context = ctx.build_context(self.dialect, self.pool, plugins=self.plugins)
            prompt = build_system_prompt(self.custom_instructions, self.mode)
            self._system_text = f"{prompt}\n\n# Database context\n\n{context}"
        return self._system_text

    def _config(self) -> types.GenerateContentConfig:
        return types.GenerateContentConfig(
            system_instruction=self._system(),
            max_output_tokens=self.max_tokens,
            tools=_to_gemini_tools(tools_for_mode(self.mode)),
            # We run the tool loop ourselves (the pool and timeouts live here),
            # so the SDK must not call anything on our behalf.
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )

    def _repair_history(self) -> None:
        """Ensure every model ``function_call`` is answered by a response part.

        Gemini rejects a request where a function call has no matching
        functionResponse. An interrupted send() (the SSE client disconnecting
        mid-loop) can leave such orphans; we backfill synthetic error results so
        the conversation stays valid.
        """
        i = 0
        while i < len(self.contents):
            calls = _function_calls(self.contents[i]) if self.contents[i].role == "model" else []
            if not calls:
                i += 1
                continue

            # The responses to this turn, if any, are the immediately next Content.
            covered: set[str] = set()
            nxt = self.contents[i + 1] if i + 1 < len(self.contents) else None
            if nxt is not None and nxt.role == "user":
                covered = {
                    p.function_response.name
                    for p in (nxt.parts or [])
                    if p.function_response
                }

            orphaned = [c for c in calls if c.name not in covered]
            if not orphaned:
                i += 1
                continue

            synthetic = [
                types.Part.from_function_response(
                    name=c.name, response={"error": "Interrupted."}
                )
                for c in orphaned
            ]
            if nxt is not None and nxt.role == "user" and covered:
                # Fold the missing responses into the partial answer turn.
                nxt.parts = list(nxt.parts or []) + synthetic
            else:
                self.contents.insert(i + 1, types.Content(role="user", parts=synthetic))
            i += 2

    def send(self, user_message: str) -> Iterator[AgentEvent]:
        self._repair_history()
        self.contents.append(
            types.Content(role="user", parts=[types.Part(text=user_message)])
        )
        try:
            yield from self._run_loop()
        except genai_errors.APIError as exc:
            if exc.code in (401, 403):
                yield AgentEvent("error", text="Invalid API key. Check Settings.")
            elif exc.code == 429:
                yield AgentEvent("error", text="Rate limited — wait a moment and retry.")
            else:
                yield AgentEvent("error", text=f"API error {exc.code}: {exc.message}")
        except Exception as exc:  # noqa: BLE001
            yield AgentEvent("error", text=f"Agent error: {exc}")

    def _run_loop(self) -> Iterator[AgentEvent]:
        for _ in range(self.max_steps):
            if self._cancel.is_set():
                yield AgentEvent("done")
                return
            response = self.client.models.generate_content(
                model=self.model,
                contents=self.contents,
                config=self._config(),
            )
            candidate = response.candidates[0] if response.candidates else None
            content = candidate.content if candidate else None
            parts = (content.parts if content else None) or []

            # Keep the SDK's own Content: it carries the thought signatures Gemini
            # requires back on the next turn alongside the function calls.
            if content is not None:
                self.contents.append(content)

            for part in parts:
                # Thought summaries are internal reasoning, not an answer.
                if part.text and not part.thought and part.text.strip():
                    yield AgentEvent("text", text=part.text)

            calls = _function_calls(content)
            if not calls:
                yield AgentEvent("done")
                return

            results: list[types.Part] = []
            for call in calls:
                # Stop before running further tools; unanswered calls are
                # backfilled by _repair_history on the next send.
                if self._cancel.is_set():
                    break
                tool_input = dict(call.args or {})
                yield AgentEvent("tool_call", tool_name=call.name, tool_input=tool_input)
                result_text, is_error = execute_tool(
                    self.dialect, self.pool, call.name, tool_input,
                    statement_timeout_ms=self.statement_timeout_ms,
                    saved_queries_loader=self.saved_queries_loader,
                )
                yield AgentEvent("tool_result", tool_name=call.name, ok=not is_error)
                results.append(
                    types.Part.from_function_response(
                        name=call.name,
                        response={"error" if is_error else "result": result_text},
                    )
                )
            self.contents.append(types.Content(role="user", parts=results))
            if self._cancel.is_set():
                yield AgentEvent("done")
                return

        yield AgentEvent("error", text="Stopped: too many tool iterations.")
        yield AgentEvent("done")
