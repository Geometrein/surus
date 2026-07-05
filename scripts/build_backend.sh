#!/usr/bin/env bash
# Freeze the FastAPI backend into a single self-contained binary (PyInstaller)
# and place it where Tauri expects its sidecar, named with the Rust target triple.
#
# The result has no dependency on the repo or an installed Python — so the
# packaged desktop app never reaches into protected folders (no TCC issues).
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT"

RUSTC="$(command -v rustc || echo "$HOME/.cargo/bin/rustc")"
TRIPLE="$("$RUSTC" -Vv | sed -n 's/host: //p')"
[ -n "$TRIPLE" ] || { echo "could not determine Rust target triple"; exit 1; }

echo "→ freezing backend for $TRIPLE (this takes a minute)…"
rm -rf build

uv run --with pyinstaller pyinstaller \
  --name surus-backend \
  --onefile \
  --noconfirm \
  --console \
  --distpath build/dist \
  --workpath build/pyinstaller \
  --specpath build \
  --collect-all psycopg \
  --collect-all psycopg_binary \
  --collect-all keyring \
  --copy-metadata keyring \
  --collect-submodules uvicorn \
  --collect-submodules anthropic \
  --collect-submodules sqlmodel \
  --hidden-import backend.api.main \
  backend/server.py

DEST="$PROJECT/frontend/src-tauri/binaries"
mkdir -p "$DEST"
cp build/dist/surus-backend "$DEST/surus-backend-$TRIPLE"
chmod +x "$DEST/surus-backend-$TRIPLE"

echo "✓ sidecar: $DEST/surus-backend-$TRIPLE"
