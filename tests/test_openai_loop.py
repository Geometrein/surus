"""The OpenAI tool-use loop in OpenAIProvider, driven by a fake client.

No real API calls: we queue canned Chat Completions responses and stub
execute_tool, then assert the normalized AgentEvent stream and that tool results
feed back into history in OpenAI's message shape.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from backend.agent.openai_provider import OpenAIProvider
from backend.config import DEFAULT_AGENT_MAX_STEPS


def _tool_call(name, args, id="t1"):
    return SimpleNamespace(
        id=id, type="function",
        function=SimpleNamespace(name=name, arguments=json.dumps(args)),
    )


def _response(content=None, tool_calls=None):
    message = SimpleNamespace(content=content, tool_calls=tool_calls or None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class _FakeCompletions:
    def __init__(self, queue):
        self._queue = queue
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        return self._queue.pop(0)


class _FakeClient:
    def __init__(self, queue):
        self.chat = SimpleNamespace(completions=_FakeCompletions(queue))


def _provider_with(queue, monkeypatch, tool_result=("PLAN", False)):
    p = OpenAIProvider(api_key="sk-test", model="gpt-5", pool=None)
    p._system_text = "sys"  # skip DB-backed _system()
    p.client = _FakeClient(queue)
    import backend.agent.openai_provider as op
    monkeypatch.setattr(
        op, "execute_tool",
        lambda dialect, pool, name, inp, statement_timeout_ms=None: tool_result,
    )
    return p


def test_plain_answer_without_tools(monkeypatch):
    queue = [_response(content="just an answer")]
    p = _provider_with(queue, monkeypatch)
    events = list(p.send("hi"))
    kinds = [(e.kind, e.text) for e in events if e.kind in ("text", "done")]
    assert kinds == [("text", "just an answer"), ("done", "")]


def test_tool_loop_emits_call_then_result_then_answer(monkeypatch):
    queue = [
        _response(content="let me check",
                  tool_calls=[_tool_call("run_explain", {"sql": "select 1"})]),
        _response(content="here is the query"),
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
        _response(tool_calls=[_tool_call("run_query", {"sql": "select 1"}, id="abc")]),
        _response(content="done"),
    ]
    p = _provider_with(queue, monkeypatch, tool_result=("rows: 1", False))
    list(p.send("go"))
    # user msg, assistant(tool_calls), tool(result), assistant(final)
    tool_msg = p.messages[2]
    assert tool_msg["role"] == "tool"
    assert tool_msg["tool_call_id"] == "abc"
    assert tool_msg["content"] == "rows: 1"


def test_tool_error_marked_in_result_event(monkeypatch):
    queue = [
        _response(tool_calls=[_tool_call("run_query", {"sql": "boom"})]),
        _response(content="recovered"),
    ]
    p = _provider_with(queue, monkeypatch, tool_result=("Error: nope", True))
    events = list(p.send("go"))
    assert next(e for e in events if e.kind == "tool_result").ok is False


def test_runaway_loop_stops_at_iteration_cap(monkeypatch):
    queue = [
        _response(tool_calls=[_tool_call("run_query", {"sql": "select 1"})])
        for _ in range(DEFAULT_AGENT_MAX_STEPS + 5)
    ]
    p = _provider_with(queue, monkeypatch)
    events = list(p.send("loop forever"))
    assert p.client.chat.completions.calls == DEFAULT_AGENT_MAX_STEPS
    errors = [e for e in events if e.kind == "error"]
    assert errors and "too many tool iterations" in errors[0].text


def test_repair_backfills_orphaned_tool_calls(monkeypatch):
    # Simulate an interrupted send: assistant asked for two tools, only one
    # result made it into history before the client disconnected.
    p = _provider_with([_response(content="ok")], monkeypatch)
    p.messages = [
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": "",
         "tool_calls": [
             {"id": "a", "type": "function", "function": {"name": "run_query", "arguments": "{}"}},
             {"id": "b", "type": "function", "function": {"name": "run_query", "arguments": "{}"}},
         ]},
        {"role": "tool", "tool_call_id": "a", "content": "done"},
    ]
    list(p.send("next"))
    # The orphaned call "b" gets a synthetic tool result before the new user turn.
    tool_ids = [m["tool_call_id"] for m in p.messages if m["role"] == "tool"]
    assert tool_ids == ["a", "b"]
