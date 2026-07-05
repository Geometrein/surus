"""OpenAI-backed agent: NL request -> performant SQL via a tool-use loop.

Same contract as :class:`~backend.agent.anthropic_provider.AnthropicProvider`
(the :class:`~backend.agent.provider.AgentProvider` protocol), so the chat UI is
unchanged. Only the transport differs: the tool-use loop runs against OpenAI's
Chat Completions API, the shared tool schemas are translated to the ``function``
tool shape, and the schema context is sent as a plain system message (OpenAI
caches prompts automatically, so no explicit cache markers are needed).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Iterator

import openai

from backend.agent import context as ctx
from backend.agent.prompts import build_system_prompt
from backend.agent.provider import AgentEvent
from backend.agent.tools import execute_tool, tools_for_mode
from backend.config import DEFAULT_AGENT_MAX_STEPS, DEFAULT_AGENT_MAX_TOKENS
from backend.db.dialects import get_dialect

if TYPE_CHECKING:
    from backend.db.dialects.base import Dialect
    from backend.db.extensions import ExtensionPlugin


def _to_openai_tools(defs: list[dict]) -> list[dict]:
    """Translate the shared Anthropic-style tool defs to OpenAI's function shape."""
    tools: list[dict] = []
    for d in defs:
        fn: dict[str, Any] = {
            "name": d["name"],
            "description": d["description"],
            "parameters": d["input_schema"],
        }
        if d.get("strict"):
            fn["strict"] = True
        tools.append({"type": "function", "function": fn})
    return tools


class OpenAIProvider:
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
    ):
        self.client = openai.OpenAI(api_key=api_key)
        self.model = model
        self.pool = pool
        self.plugins = plugins or []
        self.dialect = dialect or get_dialect(None)
        self.custom_instructions = custom_instructions
        self.statement_timeout_ms = statement_timeout_ms
        self.mode = mode
        self.max_steps = max_steps
        self.max_tokens = max_tokens
        # History holds OpenAI chat messages (user/assistant/tool), without the
        # system message — that is (re)built lazily and prepended per request.
        self.messages: list[dict] = []
        self._system_text: str | None = None

    def reset(self) -> None:
        self.messages = []
        self._system_text = None

    def seed_history(self, messages: list[dict]) -> None:
        """Replace history from persisted turns.

        ``messages`` is the alternating user/assistant *text* shape shared with
        the Anthropic provider, which is already a valid OpenAI chat sequence.
        """
        self.messages = list(messages)

    def refresh_context(self) -> None:
        """Drop the cached schema/stats context so it rebuilds next turn."""
        self._system_text = None

    def _tools(self) -> list[dict]:
        return _to_openai_tools(tools_for_mode(self.mode))

    def _system(self) -> str:
        if self._system_text is None:
            context = ctx.build_context(self.dialect, self.pool, plugins=self.plugins)
            prompt = build_system_prompt(self.custom_instructions, self.mode)
            self._system_text = f"{prompt}\n\n# Database context\n\n{context}"
        return self._system_text

    def _repair_history(self) -> None:
        """Ensure every assistant ``tool_calls`` is answered by tool messages.

        OpenAI rejects a request where an assistant message requests tool calls
        that aren't each followed by a matching ``tool`` message. An interrupted
        send() (the SSE client disconnecting mid-loop) can leave such orphans;
        we backfill synthetic error results so the conversation stays valid.
        """
        i = 0
        while i < len(self.messages):
            msg = self.messages[i]
            tool_calls = msg.get("tool_calls") if msg.get("role") == "assistant" else None
            if not tool_calls:
                i += 1
                continue

            call_ids = [tc["id"] for tc in tool_calls]
            # Tool messages answering this call run consecutively right after it.
            covered: set[str] = set()
            j = i + 1
            while j < len(self.messages) and self.messages[j].get("role") == "tool":
                covered.add(self.messages[j].get("tool_call_id"))
                j += 1

            orphaned = [cid for cid in call_ids if cid not in covered]
            synthetic = [
                {"role": "tool", "tool_call_id": cid, "content": "Interrupted."}
                for cid in orphaned
            ]
            # Insert missing results directly after the already-present ones.
            self.messages[j:j] = synthetic
            i = j + len(synthetic)

    def send(self, user_message: str) -> Iterator[AgentEvent]:
        self._repair_history()
        self.messages.append({"role": "user", "content": user_message})
        try:
            yield from self._run_loop()
        except openai.AuthenticationError:
            yield AgentEvent("error", text="Invalid API key. Check Settings.")
        except openai.RateLimitError:
            yield AgentEvent("error", text="Rate limited — wait a moment and retry.")
        except openai.APIStatusError as exc:
            yield AgentEvent("error", text=f"API error {exc.status_code}: {exc.message}")
        except Exception as exc:  # noqa: BLE001
            yield AgentEvent("error", text=f"Agent error: {exc}")

    def _run_loop(self) -> Iterator[AgentEvent]:
        for _ in range(self.max_steps):
            response = self.client.chat.completions.create(
                model=self.model,
                max_completion_tokens=self.max_tokens,
                messages=[{"role": "system", "content": self._system()}, *self.messages],
                tools=self._tools(),
            )
            message = response.choices[0].message
            tool_calls = message.tool_calls or []

            # Preserve the assistant turn (text + any tool calls) for the next turn.
            assistant_msg: dict[str, Any] = {"role": "assistant", "content": message.content or ""}
            if tool_calls:
                assistant_msg["tool_calls"] = [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in tool_calls
                ]
            self.messages.append(assistant_msg)

            if message.content and message.content.strip():
                yield AgentEvent("text", text=message.content)

            if not tool_calls:
                yield AgentEvent("done")
                return

            for tc in tool_calls:
                try:
                    tool_input = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    tool_input = {}
                yield AgentEvent("tool_call", tool_name=tc.function.name, tool_input=tool_input)
                result_text, is_error = execute_tool(
                    self.dialect, self.pool, tc.function.name, tool_input,
                    statement_timeout_ms=self.statement_timeout_ms,
                )
                yield AgentEvent("tool_result", tool_name=tc.function.name, ok=not is_error)
                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_text,
                })

        yield AgentEvent("error", text="Stopped: too many tool iterations.")
        yield AgentEvent("done")
