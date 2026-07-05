"""FastAPI app: the Surus backend service.

Wraps the verified db + agent Python and persists to SQLite. It binds to
loopback only and is meant to be driven exclusively by our own UI (Vite dev or
the Tauri-bundled shell). Two guards keep a random web page the user happens to
visit from reaching it:

* an **Origin allowlist** — a browser always stamps a truthful ``Origin`` on a
  cross-origin request, so any page outside our known origins is rejected; and
* a **Host allowlist** — the request's ``Host`` must be loopback, which defeats
  DNS-rebinding (an attacker pointing their own hostname at ``127.0.0.1``).

A non-browser process on the same machine already runs with the user's
privileges, so it is out of scope — no bearer token would meaningfully change
that threat model.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.api.routes import chat, connections, logs, queries, query, schema, settings, snapshot
from backend.store.db import init_db

# The packaged Tauri desktop shell serves the UI from tauri://localhost; the
# Vite dev server uses http://localhost:5173 (or 127.0.0.1). These are the only
# origins allowed to call the API.
ALLOWED_ORIGINS = [
    "tauri://localhost",
    "http://tauri.localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
# Hostnames the request's Host header may carry (anti DNS-rebinding). The API
# only ever binds loopback; ``testserver`` is FastAPI's TestClient default.
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1", "testserver"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Surus", version="0.2.0", lifespan=lifespan)


@app.middleware("http")
async def guard_origin_and_host(request: Request, call_next):
    hostname = (request.headers.get("host", "") or "").rsplit(":", 1)[0].strip("[]").lower()
    if hostname and hostname not in ALLOWED_HOSTS:
        return JSONResponse({"detail": "Forbidden host"}, status_code=403)
    origin = request.headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        return JSONResponse({"detail": "Forbidden origin"}, status_code=403)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    # No cookies are used — auth is by origin/host, not credentials.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(connections.router)
app.include_router(snapshot.router)
app.include_router(schema.router)
app.include_router(query.router)
app.include_router(queries.router)
app.include_router(settings.router)
app.include_router(chat.router)
app.include_router(logs.router)


@app.get("/health")
def health() -> dict:
    return {"ok": True}
