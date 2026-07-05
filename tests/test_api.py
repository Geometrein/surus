"""HTTP API smoke tests via FastAPI's TestClient.

These exercise the SQLite-backed routes (health, settings, connections, chat
sessions, file-workspace queries) end-to-end against the in-memory store and
keyring. Routes that require a live Postgres connection are only tested on their
not-connected / not-found error paths.
"""

from __future__ import annotations

import pytest


def test_health(client):
    assert client.get("/health").json() == {"ok": True}


# --- origin / host guard ----------------------------------------------------

def test_request_from_untrusted_origin_is_forbidden(client):
    # A random web page the user visits would carry its own Origin.
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_request_from_allowed_origin_passes(client):
    r = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert r.status_code == 200


def test_non_loopback_host_is_forbidden(client):
    # Defeats DNS-rebinding: an attacker's hostname pointed at 127.0.0.1.
    r = client.get("/health", headers={"Host": "attacker.example"})
    assert r.status_code == 403


# --- settings ---------------------------------------------------------------

def test_settings_reports_no_key_then_key(client):
    body = client.get("/settings").json()
    assert body["hasLlmKey"] is False
    assert {p["id"] for p in body["providers"]} == {"anthropic", "openai"}
    assert all(p["hasKey"] is False for p in body["providers"])
    assert "claude-opus-4-8" in body["models"]
    assert "gpt-5" in body["models"]
    assert body["modelProviders"]["gpt-5"] == "openai"
    assert body["defaultModel"]

    # Setting an OpenAI key flips only that provider's status.
    assert client.put(
        "/settings/llm-key", json={"key": "  sk-test  ", "provider": "openai"}
    ).json() == {"provider": "openai", "hasKey": True}
    body = client.get("/settings").json()
    assert body["hasLlmKey"] is True
    providers = {p["id"]: p["hasKey"] for p in body["providers"]}
    assert providers == {"anthropic": False, "openai": True}


def test_agent_limits_default_roundtrip_and_clamp(client):
    body = client.get("/settings").json()
    assert body["agentMaxSteps"] == 12
    assert body["agentMaxTokens"] == 16_000

    # In-range values persist; out-of-range values clamp to the bounds.
    assert client.put("/settings/agent-max-steps", json={"agentMaxSteps": 20}).json() == {"agentMaxSteps": 20}
    assert client.put("/settings/agent-max-steps", json={"agentMaxSteps": 999}).json() == {"agentMaxSteps": 50}
    assert client.put("/settings/agent-max-steps", json={"agentMaxSteps": 1}).json() == {"agentMaxSteps": 2}
    assert client.put("/settings/agent-max-tokens", json={"agentMaxTokens": 5000}).json() == {"agentMaxTokens": 5000}
    assert client.put("/settings/agent-max-tokens", json={"agentMaxTokens": 999_999}).json() == {"agentMaxTokens": 64_000}

    body = client.get("/settings").json()
    assert body["agentMaxSteps"] == 2
    assert body["agentMaxTokens"] == 64_000


# --- connections CRUD -------------------------------------------------------

def test_connection_crud_lifecycle(client):
    assert client.get("/connections").json() == []

    created = client.post("/connections", json={
        "name": "Demo", "host": "localhost", "port": 55432,
        "dbname": "demo", "user": "postgres", "password": "pw",
    }).json()
    cid = created["id"]
    assert created["name"] == "Demo"
    assert created["connected"] is False

    listed = client.get("/connections").json()
    assert [c["id"] for c in listed] == [cid]

    updated = client.put(f"/connections/{cid}", json={
        "name": "Renamed", "host": "localhost", "port": 55432,
        "dbname": "demo", "user": "postgres", "password": "",
    }).json()
    assert updated["name"] == "Renamed"

    assert client.delete(f"/connections/{cid}").json() == {"ok": True}
    assert client.get("/connections").json() == []


def test_update_missing_connection_404(client):
    r = client.put("/connections/nope", json={
        "name": "x", "host": "h", "port": 1, "dbname": "d", "user": "u", "password": "",
    })
    assert r.status_code == 404


def test_connect_missing_connection_404(client):
    assert client.post("/connections/nope/connect").status_code == 404


def test_disconnect_is_idempotent(client):
    assert client.post("/connections/whatever/disconnect").json() == {"connected": False}


# --- chat sessions ----------------------------------------------------------

def test_chat_session_crud(client):
    conn = client.post("/connections", json={"name": "C"}).json()
    cid = conn["id"]

    session = client.post("/chat/sessions", json={"connectionId": cid}).json()
    sid = session["id"]
    assert session["title"] == "Chat 1"  # auto-numbered

    # second session increments the default title
    second = client.post("/chat/sessions", json={"connectionId": cid}).json()
    assert second["title"] == "Chat 2"

    assert {s["id"] for s in client.get(f"/chat/sessions?connectionId={cid}").json()} == {
        sid, second["id"]
    }

    renamed = client.patch(f"/chat/sessions/{sid}", json={"title": "Revenue"}).json()
    assert renamed["title"] == "Revenue"

    assert client.get(f"/chat/sessions/{sid}/messages").json() == []
    assert client.delete(f"/chat/sessions/{sid}").json() == {"ok": True}
    assert {s["id"] for s in client.get(f"/chat/sessions?connectionId={cid}").json()} == {
        second["id"]
    }


def test_rename_missing_session_404(client):
    assert client.patch("/chat/sessions/ghost", json={"title": "x"}).status_code == 404


# --- file workspace / saved queries ----------------------------------------

def test_queries_empty_without_workspace(client):
    assert client.get("/queries/workspace").json() == {"path": None}
    assert client.get("/queries").json() == []
    assert client.get("/queries/folders").json() == []
    # creating a query without a workspace is a 400
    assert client.post("/queries", json={"name": "q", "sql": "select 1"}).status_code == 400


def test_query_create_list_update_in_workspace(client, tmp_path):
    ws = tmp_path / "workspace"
    set_resp = client.post("/queries/workspace", json={"path": str(ws)}).json()
    assert set_resp["path"] == str(ws.resolve())

    created = client.post("/queries", json={
        "name": "top customers", "sql": "select * from customers",
    }).json()
    assert created["name"] == "top customers"
    assert created["sql"] == "select * from customers"
    # written to disk as a .sql file at the workspace root
    assert (ws / "top customers.sql").read_text() == "select * from customers"

    listed = client.get("/queries").json()
    assert [q["name"] for q in listed] == ["top customers"]

    updated = client.put(f"/queries/{created['id']}", json={
        "name": "top customers", "sql": "select id from customers",
    }).json()
    assert updated["sql"] == "select id from customers"
    assert (ws / "top customers.sql").read_text() == "select id from customers"


def test_create_folder_writes_connection_marker(client, tmp_path):
    client.post("/queries/workspace", json={"path": str(tmp_path / "ws")})
    folder = client.post("/queries/folders", json={
        "name": "analytics", "connectionId": "conn-9",
    }).json()
    assert folder["name"] == "analytics"
    assert folder["connectionId"] == "conn-9"
    # appears in the folder tree
    assert [f["name"] for f in client.get("/queries/folders").json()] == ["analytics"]
