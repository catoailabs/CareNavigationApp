#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${PILLAR6_BROWSER_PROFILE:-/workspace/.runtime/browser-profile}"
DEBUG_PORT="${PILLAR6_BROWSER_DEBUG_PORT:-9222}"
START_URL="${PILLAR6_BROWSER_START_URL:-http://openemr}"
BROWSER_BIN="${PILLAR6_BROWSER_EXECUTABLE:-/usr/bin/chromium}"

mkdir -p "${PROFILE_DIR}"

if pgrep -af "chromium.*--remote-debugging-port=${DEBUG_PORT}" >/dev/null 2>&1; then
  exit 0
fi

rm -f \
  "${PROFILE_DIR}/SingletonCookie" \
  "${PROFILE_DIR}/SingletonLock" \
  "${PROFILE_DIR}/SingletonSocket" || true

exec "${BROWSER_BIN}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-sandbox \
  --disable-gpu \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${DEBUG_PORT}" \
  --disable-crash-reporter \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --new-window \
  "${START_URL}"
