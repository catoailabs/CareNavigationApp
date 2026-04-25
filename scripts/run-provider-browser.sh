#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_DIR="${PROVIDER_TAB_BRIDGE_EXTENSION_DIR:-$ROOT_DIR/browser-extension/provider-tab-bridge}"
PROFILE_DIR="${PROVIDER_BROWSER_PROFILE:-$ROOT_DIR/.runtime/provider-tab-bridge-profile}"
START_URL="${PROVIDER_BROWSER_START_URL:-http://127.0.0.1:${VITE_PORT:-5173}}"
DEBUG_PORT="${PILLAR6_BROWSER_DEBUG_PORT:-9222}"
WAIT_TIMEOUT_SECS="${PROVIDER_BROWSER_WAIT_TIMEOUT_SECS:-45}"
BROWSER_BIN="${PROVIDER_BROWSER_EXECUTABLE:-/Applications/Chromium.app/Contents/MacOS/Chromium}"
INSTALL_CMD='brew install --cask chromium'

if [[ ! -d "$EXTENSION_DIR" ]]; then
  echo "Missing Provider Tab Bridge extension at $EXTENSION_DIR" >&2
  exit 1
fi

if [[ ! -x "$BROWSER_BIN" ]]; then
  # Auto-detect Playwright Chromium installation
  PLAYWRIGHT_CR="$(ls -1t ~/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium 2>/dev/null | head -n 1)"
  if [[ -n "$PLAYWRIGHT_CR" && -x "$PLAYWRIGHT_CR" ]]; then
    BROWSER_BIN="$PLAYWRIGHT_CR"
  fi
fi

if [[ ! -x "$BROWSER_BIN" ]]; then
  cat >&2 <<EOF
Provider Tab Bridge autostart requires Chromium.
Install it once with:
  $INSTALL_CMD

Then rerun:
  npm run dev

If you need your existing Google Chrome tabs instead of the auto-launched Chromium window,
load this unpacked extension manually:
  $EXTENSION_DIR
EOF
  exit 0
fi

mkdir -p "$PROFILE_DIR"

if pgrep -af "Chromium.*--user-data-dir=${PROFILE_DIR}" >/dev/null 2>&1; then
  exit 0
fi

rm -f \
  "${PROFILE_DIR}/SingletonCookie" \
  "${PROFILE_DIR}/SingletonLock" \
  "${PROFILE_DIR}/SingletonSocket" || true

deadline=$((SECONDS + WAIT_TIMEOUT_SECS))
until curl -fs -o /dev/null "$START_URL" 2>/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "Timed out waiting for the app at $START_URL; skipping browser autostart." >&2
    exit 0
  fi
  sleep 1
done

nohup "$BROWSER_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --disable-extensions-except="$EXTENSION_DIR" \
  --load-extension="$EXTENSION_DIR" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$DEBUG_PORT" \
  --disable-crash-reporter \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  "$START_URL" >/dev/null 2>&1 < /dev/null &

echo "Launched Chromium with Provider Tab Bridge at $START_URL"
