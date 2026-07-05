"""App paths and secret-store constants.

Non-secret data now lives in SQLite (see :mod:`backend.store`); secrets (DB
passwords, the LLM API key) stay in the system keychain via :mod:`keyring`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "Surus"

# keychain service + the prefix under which each provider's LLM API key is
# stored. Keys are namespaced per provider: "llm-api-key-<provider>".
KEYRING_SERVICE = "surus"
LLM_KEY_PREFIX = "llm-api-key"


def llm_key_username(provider: str) -> str:
    """Keychain username under which ``provider``'s API key is stored."""
    return f"{LLM_KEY_PREFIX}-{provider}"


# Defaults surfaced to the API/UI.
DEFAULT_LLM_PROVIDER = "anthropic"
DEFAULT_LLM_MODEL = "claude-haiku-4-5"
DEFAULT_STATEMENT_TIMEOUT_MS = 120_000
DEFAULT_PREVIEW_ROW_LIMIT = 200
# Per-statement timeout for the agent's own tool queries (run_query/run_explain),
# independent of the editor's pool-level timeout. User-editable in Settings.
DEFAULT_AGENT_TIMEOUT_SEC = 30
# Max tool-use round-trips the agent may take before it's stopped (each step is a
# model call plus a tool query — more depth solves harder tasks but costs more
# time and tokens). Single source for both providers; user-editable in Settings.
DEFAULT_AGENT_MAX_STEPS = 12
# Max output tokens per model call (caps answer/reasoning length and per-call
# cost). Single source for both providers; user-editable in Settings.
DEFAULT_AGENT_MAX_TOKENS = 16_000


def config_dir() -> Path:
    """Per-user data directory for the app's SQLite DB and other state.

    Platform-native, following the same conventions as ``platformdirs`` (kept
    dependency-free). The macOS path is unchanged from earlier versions, so
    existing installs keep their data with no migration.
    """
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / APP_NAME
    elif sys.platform.startswith("win"):  # Windows
        root = os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
        base = Path(root) / APP_NAME
    else:  # Linux and other Unix — XDG base directory spec
        root = os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")
        base = Path(root) / APP_NAME
    base.mkdir(parents=True, exist_ok=True)
    return base


def db_path() -> Path:
    """Path to the SQLite database file."""
    return config_dir() / "surus.db"
