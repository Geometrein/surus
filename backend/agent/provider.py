"""Provider-agnostic agent interface.

A provider owns the conversation: it holds message history, talks to its LLM,
runs the tool-use loop against the read-only pool, and yields normalized
:class:`AgentEvent`s the chat UI can render. Claude is the default
implementation; an OpenAI/local provider can implement the same ``send`` shape
later without the UI changing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Iterator, Literal, Protocol

if TYPE_CHECKING:
    from backend.agent.tools import SavedQueriesLoader
    from backend.db.dialects.base import Dialect
    from backend.db.extensions import ExtensionPlugin

# Models offered in the UI, per provider. Anthropic defaults to Opus 4.8 — the
# EXPLAIN→evaluate→iterate loop benefits from its reasoning; the smaller models
# are cheaper, faster options. These are just the defaults surfaced in the
# picker; any model the provider accepts will run.
MODELS: dict[str, list[str]] = {
    "anthropic": ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"],
    "openai": ["gpt-5", "gpt-5-mini", "gpt-4.1"],
}

# Human-facing metadata for each provider (label + API-key placeholder), keyed
# in the same order they should appear in Settings.
PROVIDERS: dict[str, dict[str, str]] = {
    "anthropic": {"label": "Anthropic", "keyPlaceholder": "sk-ant-…"},
    "openai": {"label": "OpenAI", "keyPlaceholder": "sk-…"},
}


def provider_for_model(model: str) -> str:
    """Resolve which provider serves ``model`` (falls back to the default)."""
    for name, models in MODELS.items():
        if model in models:
            return name
    # Unknown/custom model id: infer from a known prefix so custom entries still
    # route correctly, else fall back to the default provider.
    if model.startswith("claude"):
        return "anthropic"
    if model.startswith(("gpt", "o1", "o3", "o4")):
        return "openai"
    return next(iter(MODELS))


def all_models() -> list[str]:
    """Every offered model across providers, in provider order."""
    return [m for models in MODELS.values() for m in models]


EventKind = Literal["text", "tool_call", "tool_result", "done", "error"]


@dataclass
class AgentEvent:
    kind: EventKind
    text: str = ""
    tool_name: str = ""
    tool_input: dict | None = None
    ok: bool = True


class AgentProvider(Protocol):
    def send(self, user_message: str) -> Iterator[AgentEvent]:
        """Send a user message; yield events as the agent works."""
        ...

    def stop(self) -> None:
        """Request the in-flight send() loop to halt at the next checkpoint."""
        ...

    def clear_stop(self) -> None:
        """Reset the cancel flag before starting a new send()."""
        ...

    def reset(self) -> None:
        """Clear conversation history (e.g. on connection change)."""
        ...

    def seed_history(self, messages: list[dict]) -> None:
        """Replace conversation history (e.g. rehydrating a persisted chat)."""
        ...

    def refresh_context(self) -> None:
        """Rebuild the cached schema context on the next turn; keep the chat."""
        ...


def build_provider(
    provider: str,
    api_key: str,
    model: str,
    pool: Any,
    plugins: "list[ExtensionPlugin] | None" = None,
    dialect: "Dialect | None" = None,
    custom_instructions: str = "",
    statement_timeout_ms: int | None = None,
    mode: str = "sql",
    max_steps: int | None = None,
    max_tokens: int | None = None,
    saved_queries_loader: "SavedQueriesLoader | None" = None,
) -> AgentProvider:
    if provider == "anthropic":
        from backend.agent.anthropic_provider import AnthropicProvider

        cls: type = AnthropicProvider
    elif provider == "openai":
        from backend.agent.openai_provider import OpenAIProvider

        cls = OpenAIProvider
    else:
        raise ValueError(f"Unknown provider: {provider}")

    # Only forward limit overrides when provided, so each provider's config-backed
    # defaults remain the single source of truth otherwise.
    limits = {}
    if max_steps is not None:
        limits["max_steps"] = max_steps
    if max_tokens is not None:
        limits["max_tokens"] = max_tokens

    return cls(
        api_key=api_key, model=model, pool=pool, plugins=plugins, dialect=dialect,
        custom_instructions=custom_instructions,
        statement_timeout_ms=statement_timeout_ms,
        mode=mode,
        saved_queries_loader=saved_queries_loader,
        **limits,
    )
