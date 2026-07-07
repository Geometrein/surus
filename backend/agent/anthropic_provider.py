"""Claude-backed agent: NL request -> performant SQL via a tool-use loop.

The loop is the manual agentic pattern from the Anthropic SDK: call the model,
execute any tool_use blocks against the read-only pool, feed results back, and
repeat until the model stops calling tools. Adaptive thinking is on so the model
decides how much to reason; the schema context is sent as a cached system block.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any, Iterator

import anthropic

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


class AnthropicProvider:
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
        self.client = anthropic.Anthropic(api_key=api_key)
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
        self.messages: list[dict] = []
        self._system_blocks: list[dict] | None = None
        # Set by stop() to interrupt an in-flight tool-use loop. The loop checks
        # it between steps and tools; the lifecycle owner clears it per send.
        self._cancel = threading.Event()

    def stop(self) -> None:
        """Request the current send() loop to halt at the next checkpoint."""
        self._cancel.set()

    def clear_stop(self) -> None:
        """Reset the cancel flag; call before starting a new send()."""
        self._cancel.clear()

    def reset(self) -> None:
        self.messages = []
        self._system_blocks = None

    def seed_history(self, messages: list[dict]) -> None:
        """Replace the conversation history (e.g. rehydrating a persisted chat).

        Only prior turn *text* is restored; transient tool-use/thinking blocks
        are not replayed. ``messages`` must already be in the alternating
        user/assistant shape the API requires.
        """
        self.messages = list(messages)

    def refresh_context(self) -> None:
        """Drop the cached schema/stats context so it rebuilds next turn.

        The conversation history is preserved; only the (stale) schema block is
        discarded and re-fetched on the next message.
        """
        self._system_blocks = None

    def _tools(self) -> list[dict]:
        return tools_for_mode(self.mode)

    def _system(self) -> list[dict]:
        if self._system_blocks is None:
            context = ctx.build_context(self.dialect, self.pool, plugins=self.plugins)
            self._system_blocks = [
                {"type": "text", "text": build_system_prompt(self.custom_instructions, self.mode)},
                {"type": "text", "text": context,
                 "cache_control": {"type": "ephemeral"}},
            ]
        return self._system_blocks

    def _repair_history(self) -> None:
        """Ensure self.messages satisfies the Anthropic API's two invariants:

        1. Every assistant message containing tool_use blocks must be immediately
           followed by a user message that contains matching tool_result blocks.
        2. No two consecutive messages may share the same role.

        This handles interrupted tool-use loops at *any* position in the history,
        not just the tail — a previous failed send() may have already appended a
        plain user message, leaving the orphan one step back.
        """
        # ── Pass 1: insert synthetic tool_results for every uncovered tool_use ──
        i = 0
        while i < len(self.messages):
            msg = self.messages[i]
            if msg.get("role") != "assistant":
                i += 1
                continue

            content = msg.get("content", [])
            if not isinstance(content, list):
                i += 1
                continue

            tool_use_ids: list[str] = []
            for block in content:
                if hasattr(block, "type") and block.type == "tool_use":
                    tool_use_ids.append(block.id)
                elif isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_use_ids.append(block["id"])

            if not tool_use_ids:
                i += 1
                continue

            # Which IDs already have a result in the immediately following message?
            covered: set[str] = set()
            next_i = i + 1
            if next_i < len(self.messages):
                nxt = self.messages[next_i]
                nc = nxt.get("content", [])
                if nxt.get("role") == "user" and isinstance(nc, list):
                    for b in nc:
                        if hasattr(b, "type") and b.type == "tool_result":
                            covered.add(b.tool_use_id)
                        elif isinstance(b, dict) and b.get("type") == "tool_result":
                            covered.add(b["tool_use_id"])

            orphaned = [tid for tid in tool_use_ids if tid not in covered]
            if not orphaned:
                i += 1
                continue

            synthetic = [
                {"type": "tool_result", "tool_use_id": tid,
                 "content": "Interrupted.", "is_error": True}
                for tid in orphaned
            ]

            if next_i < len(self.messages) and self.messages[next_i].get("role") == "user":
                # Prepend synthetic results to the existing next user message.
                nc = self.messages[next_i].get("content", [])
                if isinstance(nc, str):
                    nc = [{"type": "text", "text": nc}]
                self.messages[next_i] = {**self.messages[next_i], "content": synthetic + list(nc)}
            else:
                # Insert a new user message carrying only the synthetic results.
                self.messages.insert(next_i, {"role": "user", "content": synthetic})

            i += 2  # step past both the assistant turn and the (now fixed) user turn

        # ── Pass 2: merge consecutive same-role messages ──
        i = 0
        while i < len(self.messages) - 1:
            cur, nxt = self.messages[i], self.messages[i + 1]
            if cur.get("role") != nxt.get("role"):
                i += 1
                continue
            cc = cur.get("content", [])
            nc = nxt.get("content", [])
            if isinstance(cc, str):
                cc = [{"type": "text", "text": cc}]
            if isinstance(nc, str):
                nc = [{"type": "text", "text": nc}]
            self.messages[i] = {**cur, "content": list(cc) + list(nc)}
            self.messages.pop(i + 1)
            # Don't advance i — recheck in case of three-or-more consecutive.

    def send(self, user_message: str) -> Iterator[AgentEvent]:
        self._repair_history()
        # If _repair_history left a trailing user message (synthetic tool_results),
        # fold the new text into it rather than creating consecutive user turns.
        if self.messages and self.messages[-1].get("role") == "user":
            last = self.messages[-1]
            existing = last.get("content", [])
            if isinstance(existing, str):
                existing = [{"type": "text", "text": existing}]
            self.messages[-1] = {**last, "content": list(existing) + [{"type": "text", "text": user_message}]}
        else:
            self.messages.append({"role": "user", "content": user_message})
        try:
            yield from self._run_loop()
        except anthropic.AuthenticationError:
            yield AgentEvent("error", text="Invalid API key. Check Settings.")
        except anthropic.RateLimitError:
            yield AgentEvent("error", text="Rate limited — wait a moment and retry.")
        except anthropic.APIStatusError as exc:
            yield AgentEvent("error", text=f"API error {exc.status_code}: {exc.message}")
        except Exception as exc:  # noqa: BLE001
            yield AgentEvent("error", text=f"Agent error: {exc}")

    def _supports_adaptive_thinking(self) -> bool:
        # Adaptive thinking is available on Opus 4.6+, Sonnet 4.6, and Fable 5 —
        # not on Haiku (which 400s on the thinking param).
        return "haiku" not in self.model

    def _run_loop(self) -> Iterator[AgentEvent]:
        for _ in range(self.max_steps):
            if self._cancel.is_set():
                yield AgentEvent("done")
                return
            kwargs = dict(
                model=self.model,
                max_tokens=self.max_tokens,
                system=self._system(),
                tools=self._tools(),
                messages=self.messages,
            )
            if self._supports_adaptive_thinking():
                kwargs["thinking"] = {"type": "adaptive"}
            response = self.client.messages.create(**kwargs)
            # Preserve full content (incl. thinking/tool_use) for the next turn.
            self.messages.append({"role": "assistant", "content": response.content})

            for block in response.content:
                if block.type == "text" and block.text.strip():
                    yield AgentEvent("text", text=block.text)

            if response.stop_reason != "tool_use":
                yield AgentEvent("done")
                return

            tool_results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                # Stop before running further tools; any tool_use blocks left
                # unanswered here are backfilled by _repair_history next send.
                if self._cancel.is_set():
                    break
                yield AgentEvent("tool_call", tool_name=block.name, tool_input=dict(block.input))
                result_text, is_error = execute_tool(
                    self.dialect, self.pool, block.name, block.input,
                    statement_timeout_ms=self.statement_timeout_ms,
                    saved_queries_loader=self.saved_queries_loader,
                )
                yield AgentEvent("tool_result", tool_name=block.name, ok=not is_error)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result_text,
                    "is_error": is_error,
                })
            self.messages.append({"role": "user", "content": tool_results})
            if self._cancel.is_set():
                yield AgentEvent("done")
                return

        yield AgentEvent("error", text="Stopped: too many tool iterations.")
        yield AgentEvent("done")
