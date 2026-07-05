.PHONY: setup backend frontend dev demo-db build clean help \
        tauri-dev backend-bin app

# Cargo/rustup live under ~/.cargo; make's non-interactive shell may not have it.
export PATH := $(HOME)/.cargo/bin:$(PATH)

# Keep every build artifact under one repo-root build/ dir (Cargo/Tauri would
# otherwise write to frontend/src-tauri/target). Takes precedence over .cargo/config.toml.
export CARGO_TARGET_DIR := $(CURDIR)/build/tauri

help:
	@echo "Surus — make targets:"
	@echo "  make setup       install backend (uv) + frontend (npm) deps"
	@echo "  make demo-db     create/refresh the local Postgres demo DB (Docker)"
	@echo "  make dev         run backend (:8765) + frontend (:5173) together"
	@echo "  make backend     run only the FastAPI backend"
	@echo "  make frontend    run only the Vite dev server"
	@echo "  make build       production build of the frontend"
	@echo "  make tauri-dev   run the native desktop shell in dev (spawns the backend)"
	@echo "  make backend-bin freeze the Python backend into a standalone binary"
	@echo "  make app         build the packaged desktop app (Surus.app + .dmg)"
	@echo "  make clean       remove build artifacts and caches"

setup:
	uv sync
	cd frontend && npm install

demo-db:
	bash scripts/demo_db.sh

dev:
	./run

backend:
	uv run uvicorn backend.api.main:app --port 8765 --reload

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

tauri-dev:
	cd frontend && npm run tauri dev

backend-bin:
	bash scripts/build_backend.sh

app: backend-bin
	cd frontend && npm run tauri build

clean:
	rm -rf frontend/dist frontend/node_modules/.vite
	rm -rf frontend/src-tauri/target frontend/src-tauri/binaries build
	find backend -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
