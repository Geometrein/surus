"""The Gemini tool-use loop in GeminiProvider, driven by a fake client.

No real API calls: we queue canned generate_content responses (built from real
``google.genai.types`` objects, so shape mistakes surface here) and stub
execute_tool, then assert the normalized AgentEvent stream and that tool results
feed back into history as functionResponse parts.
"""

from __future__ import annotations

from types import SimpleNamespace

from google.genai import types

from backend.agent.gemini_provider import GeminiProvider
from backend.config import DEFAULT_AGENT_MAX_STEPS


def _response(text=None, calls=None):
    parts = []
    if text is not None:
        parts.append(types.Part(text=text))
    for name, args in calls or []:
        parts.append(types.Part(function_call=types.FunctionCall(name=name, args=args)))
    content = types.Content(role="model", parts=parts)
    return SimpleNamespace(candidates=[SimpleNamespace(content=content)])


class _FakeModels:
    def __init__(self, queue):
        self._queue = queue
        self.calls = 0

    def generate_content(self, **kwargs):
        self.calls += 1
        return self._queue.pop(0)


def _provider_with(queue, monkeypatch, tool_result=("PLAN", False)):
    p = GeminiProvider(api_key="sk-test", model="gemini-3.5-flash", pool=None)
    p._system_text = "sys"  # skip DB-backed _system()
    p.client = SimpleNamespace(models=_FakeModels(queue))
    import backend.agent.gemini_provider as gp
    monkeypatch.setattr(
        gp, "execute_tool",
        lambda dialect, pool, name, inp, statement_timeout_ms=None,
        saved_queries_loader=None: tool_result,
    )
    return p


def test_plain_answer_without_tools(monkeypatch):
    p = _provider_with([_response(text="just an answer")], monkeypatch)
    events = list(p.send("hi"))
    kinds = [(e.kind, e.text) for e in events if e.kind in ("text", "done")]
    assert kinds == [("text", "just an answer"), ("done", "")]


def test_tool_loop_emits_call_then_result_then_answer(monkeypatch):
    queue = [
        _response(text="let me check", calls=[("run_explain", {"sql": "select 1"})]),
        _response(text="here is the query"),
    ]
    p = _provider_with(queue, monkeypatch, tool_result=("PLAN", False))
    events = list(p.send("count rows"))
    assert [e.kind for e in events] == [
        "text", "tool_call", "tool_result", "text", "done",
    ]

    call = next(e for e in events if e.kind == "tool_call")
    assert call.tool_name == "run_explain"
    assert call.tool_input == {"sql": "select 1"}
    assert next(e for e in events if e.kind == "tool_result").ok is True


def test_tool_result_is_fed_back_into_history(monkeypatch):
    queue = [
        _response(calls=[("run_query", {"sql": "select 1"})]),
        _response(text="done"),
    ]
    p = _provider_with(queue, monkeypatch, tool_result=("rows: 1", False))
    list(p.send("go"))
    # user turn, model(function_call), user(function_response), model(final)
    response_part = p.contents[2].parts[0].function_response
    assert p.contents[2].role == "user"
    assert response_part.name == "run_query"
    assert response_part.response == {"result": "rows: 1"}


def test_tool_error_marked_in_result_event(monkeypatch):
    queue = [
        _response(calls=[("run_query", {"sql": "boom"})]),
        _response(text="recovered"),
    ]
    p = _provider_with(queue, monkeypatch, tool_result=("Error: nope", True))
    events = list(p.send("go"))
    assert next(e for e in events if e.kind == "tool_result").ok is False
    assert p.contents[2].parts[0].function_response.response == {"error": "Error: nope"}


def test_runaway_loop_stops_at_iteration_cap(monkeypatch):
    queue = [
        _response(calls=[("run_query", {"sql": "select 1"})])
        for _ in range(DEFAULT_AGENT_MAX_STEPS + 5)
    ]
    p = _provider_with(queue, monkeypatch)
    events = list(p.send("loop forever"))
    assert p.client.models.calls == DEFAULT_AGENT_MAX_STEPS
    errors = [e for e in events if e.kind == "error"]
    assert errors and "too many tool iterations" in errors[0].text


def test_seed_history_maps_assistant_to_model_role(monkeypatch):
    p = _provider_with([_response(text="ok")], monkeypatch)
    p.seed_history([
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ])
    assert [c.role for c in p.contents] == ["user", "model"]
    assert p.contents[1].parts[0].text == "hello"


def test_repair_backfills_orphaned_function_calls(monkeypatch):
    # Simulate an interrupted send: the model asked for two tools, only one
    # response made it into history before the client disconnected.
    p = _provider_with([_response(text="ok")], monkeypatch)
    p.contents = [
        types.Content(role="user", parts=[types.Part(text="go")]),
        types.Content(role="model", parts=[
            types.Part(function_call=types.FunctionCall(name="run_query", args={})),
            types.Part(function_call=types.FunctionCall(name="run_explain", args={})),
        ]),
        types.Content(role="user", parts=[
            types.Part.from_function_response(name="run_query", response={"result": "ok"}),
        ]),
    ]
    list(p.send("next"))
    names = [
        part.function_response.name
        for part in p.contents[2].parts
        if part.function_response
    ]
    assert names == ["run_query", "run_explain"]
    # The new user message is its own turn, after the completed responses.
    assert p.contents[3].parts[0].text == "next"
