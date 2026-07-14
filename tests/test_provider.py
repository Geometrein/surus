"""Provider factory + AnthropicProvider state management (no network)."""

from __future__ import annotations

import pytest

from backend.agent import provider as provider_mod
from backend.agent.provider import MODELS, AgentEvent, build_provider, provider_for_model
from backend.agent.anthropic_provider import AnthropicProvider
from backend.agent.gemini_provider import GeminiProvider
from backend.agent.openai_provider import OpenAIProvider


def _provider(model="claude-haiku-4-5") -> AnthropicProvider:
    # pool is unused unless _system() runs; api key never leaves the client.
    return AnthropicProvider(api_key="sk-test", model=model, pool=None)


def test_models_lists_provider_options():
    assert "claude-opus-4-8" in MODELS["anthropic"]
    assert "gpt-5" in MODELS["openai"]
    assert "gemini-3.5-flash" in MODELS["google"]


def test_provider_for_model_resolves_by_list_then_prefix():
    assert provider_for_model("claude-opus-4-8") == "anthropic"
    assert provider_for_model("gpt-5") == "openai"
    assert provider_for_model("gemini-3.5-flash") == "google"
    # Unknown ids fall back to a known prefix.
    assert provider_for_model("gpt-4o-mini") == "openai"
    assert provider_for_model("claude-future") == "anthropic"
    assert provider_for_model("gemini-9-ultra") == "google"


def test_agent_event_defaults():
    ev = AgentEvent("text", text="hi")
    assert ev.kind == "text"
    assert ev.ok is True
    assert ev.tool_input is None


def test_build_provider_returns_anthropic():
    p = build_provider("anthropic", "sk-test", "claude-opus-4-8", pool=None)
    assert isinstance(p, AnthropicProvider)


def test_build_provider_returns_openai():
    p = build_provider("openai", "sk-test", "gpt-5", pool=None)
    assert isinstance(p, OpenAIProvider)


def test_build_provider_returns_gemini():
    p = build_provider("google", "sk-test", "gemini-3.5-flash", pool=None)
    assert isinstance(p, GeminiProvider)


def test_build_provider_rejects_unknown():
    with pytest.raises(ValueError):
        build_provider("cohere", "sk-test", "command", pool=None)


def test_adaptive_thinking_disabled_only_for_haiku():
    assert _provider("claude-haiku-4-5")._supports_adaptive_thinking() is False
    assert _provider("claude-opus-4-8")._supports_adaptive_thinking() is True
    assert _provider("claude-sonnet-4-6")._supports_adaptive_thinking() is True


def test_seed_history_replaces_messages():
    p = _provider()
    history = [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
    p.seed_history(history)
    assert p.messages == history
    # stored as a copy, not the same list object
    assert p.messages is not history


def test_reset_clears_history_and_cached_system():
    p = _provider()
    p.seed_history([{"role": "user", "content": "q"}])
    p._system_blocks = [{"type": "text", "text": "cached"}]
    p.reset()
    assert p.messages == []
    assert p._system_blocks is None


def test_refresh_context_drops_cached_system_but_keeps_history():
    p = _provider()
    p.seed_history([{"role": "user", "content": "q"}])
    p._system_blocks = [{"type": "text", "text": "cached"}]
    p.refresh_context()
    assert p._system_blocks is None
    assert p.messages == [{"role": "user", "content": "q"}]


def test_system_blocks_built_once_and_cached(monkeypatch):
    calls = {"context": 0}

    def fake_context(dialect, pool, plugins=None):
        calls["context"] += 1
        return "SCHEMA\n\nSTATS"

    import backend.agent.anthropic_provider as ap
    monkeypatch.setattr(ap.ctx, "build_context", fake_context)

    p = _provider()
    first = p._system()
    second = p._system()
    assert first is second  # cached
    assert calls == {"context": 1}  # built once, then served from cache
    # system prompt block + cached context block
    assert first[0]["text"].startswith("You are a senior PostgreSQL engineer")
    assert "SCHEMA" in first[1]["text"] and "STATS" in first[1]["text"]
    assert first[1]["cache_control"] == {"type": "ephemeral"}
