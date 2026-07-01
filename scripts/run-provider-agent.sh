#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="$ROOT_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Missing Python runtime at $PYTHON_BIN" >&2
  exit 1
fi

cd "$ROOT_DIR"

export BYPASS_TOOL_CONSENT="${BYPASS_TOOL_CONSENT:-true}"

# Local dev defaults to the Firebase auth bypass so the agent and the Vite app
# (which defaults VITE_AUTH_DISABLED=true via .env.development) agree out of the
# box — otherwise the backend enforces auth while the app sends no token and
# every /api/* call 401s. Override with FIREBASE_AUTH_DISABLED=false to exercise
# real Firebase auth locally. Production (modal/docker) sets this explicitly.
export FIREBASE_AUTH_DISABLED="${FIREBASE_AUTH_DISABLED:-true}"

UVICORN_ARGS=(
  agent:app
  --host "${STRANDS_AGENT_HOST:-127.0.0.1}"
  --port "${STRANDS_AGENT_PORT:-8000}"
)

if [[ "${STRANDS_AGENT_RELOAD:-1}" == "1" ]]; then
  UVICORN_ARGS+=(--reload)
  # The agent writes runtime artifacts (a live Chromium profile, logs, REPL
  # state, streaming event logs) into the workspace during a run. Without these
  # excludes, uvicorn's reloader watches the whole tree and restarts the worker
  # mid-run whenever those files churn — which kills the in-flight response and
  # forces the frontend to reload. Exclude the agent-owned paths.
  UVICORN_ARGS+=(
    --reload-exclude "tools/.runtime/*"
    --reload-exclude ".venv/*"
    --reload-exclude "logs/*"
    --reload-exclude "repl_state/*"
    --reload-exclude "errors/*"
    --reload-exclude "node_modules/*"
    --reload-exclude "*.jsonl"
    --reload-exclude "*.log"
  )
fi

exec "$PYTHON_BIN" -m uvicorn "${UVICORN_ARGS[@]}"
