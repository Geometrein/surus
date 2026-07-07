"""The Claude tool-use loop in AnthropicProvider, driven by a fake client.

No real API calls: we queue canned responses and stub execute_tool, then assert
the normalized AgentEvent stream and that tool results feed back into history.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.agent.anthropic_provider import AnthropicProvider
from backend.config import DEFAULT_AGENT_MAX_STEPS


def _text(s):
    return SimpleNamespace(type="text", text=s)


def _tool_use(name, tool_input, id="t1"):
    return SimpleNamespace(type="tool_use", name=name, input=tool_input, id=id)


def _response(content, stop_reason):
    return SimpleNamespace(content=content, stop_reason=stop_reason)


class _FakeMessages:
    def __init__(self, queue):
        self._queue = queue
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        return self._queue.pop(0)


class _FakeClient:
    def __init__(self, queue):
        self.messages = _FakeMessages(queue)


def _provider_with(queue, monkeypatch, tool_result=("PLAN", False)):
    p = AnthropicProvider(api_key="sk-test", model="claude-haiku-4-5", pool=None)
    p._system_blocks = [{"type": "text", "text": "sys"}]  # skip DB-backed _system()
    p.client = _FakeClient(queue)
    import backend.agent.anthropic_provider as ap
    monkeypatch.setattr(
        ap, "execute_tool",
        lambda dialect, pool, name, inp, statement_timeout_ms=None,
        saved_queries_loader=None: tool_result,
    )
    return p


def test_plain_answer_without_tools(monkeypatch):
    queue = [_response([_text("just an answer")], "end_turn")]
    p = _provider_with(queue, monkeypatch)
    events = list(p.send("hi"))
    kinds = [(e.kind, e.text) for e in events if e.kind in ("text", "done")]
    assert kinds == [("text", "just an answer"), ("done", "")]


def test_stop_halts_the_loop_before_the_next_model_call(monkeypatch):
    # A runaway tool loop; stop() is armed via a tool result side effect. The
    # loop must terminate (releasing the caller's lock) instead of running to the
    # iteration cap — this is what keeps a stopped chat continuable.
    queue = [
        _response([_tool_use("run_query", {"sql": "select 1"})], "tool_use")
        for _ in range(DEFAULT_AGENT_MAX_STEPS + 5)
    ]
    p = _provider_with(queue, monkeypatch)

    def stopping_tool(*a, **k):
        p.stop()
        return ("PLAN", False)

    import backend.agent.anthropic_provider as ap
    monkeypatch.setattr(ap, "execute_tool", stopping_tool)

    events = list(p.send("loop"))
    assert events[-1].kind == "done"
    assert not any(e.kind == "error" for e in events)  # not the iteration-cap path
    assert p.client.messages.calls == 1  # stopped after the first step's tool


def test_clear_stop_re_enables_sending(monkeypatch):
    p = _provider_with([_response([_text("hi")], "end_turn")], monkeypatch)
    p.stop()
    p.clear_stop()
    events = list(p.send("hello"))
    assert [e.kind for e in events] == ["text", "done"]


def test_tool_loop_emits_call_then_result_then_answer(monkeypatch):
    queue = [
        _response([_text("let me check"), _tool_use("run_explain", {"sql": "select 1"})],
                  "tool_use"),
        _response([_text("here is the query")], "end_turn"),
    ]
    p = _provider_with(queue, monkeypatch, tool_result=("PLAN", False))
    events = list(p.send("count rows"))
    kinds = [e.kind for e in events]
    assert kinds == ["text", "tool_call", "tool_result", "text", "done"]

    call = next(e for e in events if e.kind == "tool_call")
    assert call.tool_name == "run_explain"
    assert call.tool_input == {"sql": "select 1"}
    assert next(e for e in events if e.kind == "tool_result").ok is True


def test_tool_result_is_fed_back_into_history(monkeypatch):
    queue = [
        _response([_tool_use("run_query", {"sql": "select 1"}, id="abc")], "tool_use"),
        _response([_text("done")], "end_turn"),
    ]
    p = _provider_with(queue, monkeypatch, tool_result=("rows: 1", False))
    list(p.send("go"))
    # user msg, assistant(tool_use), user(tool_result), assistant(final)
    tool_result_msg = p.messages[2]
    assert tool_result_msg["role"] == "user"
    block = tool_result_msg["content"][0]
    assert block["type"] == "tool_result"
    assert block["tool_use_id"] == "abc"
    assert block["content"] == "rows: 1"
    assert block["is_error"] is False


def test_tool_error_marked_in_result_event(monkeypatch):
    queue = [
        _response([_tool_use("run_query", {"sql": "boom"})], "tool_use"),
        _response([_text("recovered")], "end_turn"),
    ]
    p = _provider_with(queue, monkeypatch, tool_result=("Error: nope", True))
    events = list(p.send("go"))
    assert next(e for e in events if e.kind == "tool_result").ok is False


def test_runaway_loop_stops_at_iteration_cap(monkeypatch):
    # Always returns tool_use -> the loop must bail after the max-steps cap.
    queue = [
        _response([_tool_use("run_query", {"sql": "select 1"})], "tool_use")
        for _ in range(DEFAULT_AGENT_MAX_STEPS + 5)
    ]
    p = _provider_with(queue, monkeypatch)
    events = list(p.send("loop forever"))
    assert p.client.messages.calls == DEFAULT_AGENT_MAX_STEPS
    errors = [e for e in events if e.kind == "error"]
    assert errors and "too many tool iterations" in errors[0].text


def test_api_exception_becomes_error_event(monkeypatch):
    p = AnthropicProvider(api_key="sk-test", model="claude-haiku-4-5", pool=None)
    p._system_blocks = [{"type": "text", "text": "sys"}]

    class Boom:
        class messages:
            @staticmethod
            def create(**kwargs):
                raise RuntimeError("network down")

    p.client = Boom()
    events = list(p.send("hi"))
    assert events[-1].kind == "error"
    assert "network down" in events[-1].text
