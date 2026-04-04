#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="$ROOT_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Missing Python runtime at $PYTHON_BIN" >&2
  exit 1
fi

cd "$ROOT_DIR"

UVICORN_ARGS=(
  agent:app
  --host "${STRANDS_AGENT_HOST:-127.0.0.1}"
  --port "${STRANDS_AGENT_PORT:-8000}"
)

if [[ "${STRANDS_AGENT_RELOAD:-0}" == "1" ]]; then
  UVICORN_ARGS+=(--reload)
fi

exec "$PYTHON_BIN" -m uvicorn "${UVICORN_ARGS[@]}"
