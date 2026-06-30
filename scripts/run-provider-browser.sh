#!/usr/bin/env bash
# Bring up the agent's virtual desktop (webtop XFCE + autostarting Chromium).
# The agent's browser IS this desktop's Chromium; the app streams the desktop
# into the browser-tool live preview via the iframe at http://localhost:3001.
# Replaces the old macOS-only local-Chromium launcher. Idempotent and
# non-blocking; gated by PROVIDER_BROWSER_AUTOSTART in scripts/dev.mjs.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${AGENT_DESKTOP_COMPOSE_FILE:-$ROOT_DIR/tools/virtual_desktop/docker-compose.yml}"
SERVICE="${AGENT_DESKTOP_SERVICE:-agent-desktop}"
export PILLAR6_BROWSER_START_URL="${PILLAR6_BROWSER_START_URL:-https://www.google.com}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[desktop] docker not found; skipping agent desktop autostart." >&2
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "[desktop] docker daemon not reachable; skipping agent desktop autostart." >&2
  exit 0
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[desktop] compose file not found at $COMPOSE_FILE; skipping." >&2
  exit 0
fi

echo "[desktop] starting agent desktop ($SERVICE)…"
if docker compose -f "$COMPOSE_FILE" up -d --no-deps "$SERVICE"; then
  echo "[desktop] agent desktop up at http://localhost:3001 (Chromium autostarts inside)."
else
  echo "[desktop] failed to start agent desktop; continuing without it." >&2
fi

exit 0
