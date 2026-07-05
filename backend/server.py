"""Standalone entrypoint for the backend, used by the Tauri desktop shell.

In the packaged app this is frozen (PyInstaller) into the ``surus-backend``
sidecar; in dev the shell runs it via ``uv run python -m backend.server``. Either
way it runs the FastAPI app under uvicorn on a fixed localhost port and exits if
its launching parent (the Tauri app) goes away, so the backend is never orphaned.
"""

from __future__ import annotations

import multiprocessing
import os
import threading
import time

import uvicorn

from backend.api.main import app

HOST = "127.0.0.1"
PORT = 8765


def _watch_parent(parent_pid: int) -> None:
    """Exit when the launching app dies, so we never leave an orphan on the port.

    macOS has no parent-death signal; polling the parent pid is the portable
    equivalent and covers both a clean quit and a crash of the shell.
    """
    while True:
        time.sleep(1.0)
        try:
            os.kill(parent_pid, 0)
        except ProcessLookupError:
            os._exit(0)
        except OSError:
            pass  # exists but not signalable (EPERM) — still alive


def main() -> None:
    parent = os.environ.get("SURUS_PARENT_PID")
    if parent:
        threading.Thread(
            target=_watch_parent, args=(int(parent),), daemon=True
        ).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    # Required so a frozen binary doesn't re-launch itself if anything forks.
    multiprocessing.freeze_support()
    main()
