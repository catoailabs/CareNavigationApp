#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${PILLAR6_BROWSER_PROFILE:-/workspace/.runtime/browser-profile}"
DEBUG_PORT="${PILLAR6_BROWSER_DEBUG_PORT:-9222}"
# Bind address for the DevTools (CDP) socket. Defaults to loopback for local dev;
# set PILLAR6_BROWSER_DEBUG_ADDRESS=0.0.0.0 in the self-hosted stack so the web
# container can reach it over the internal Docker network (never publish 9222).
DEBUG_ADDRESS="${PILLAR6_BROWSER_DEBUG_ADDRESS:-127.0.0.1}"
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
  --remote-debugging-address="${DEBUG_ADDRESS}" \
  --remote-debugging-port="${DEBUG_PORT}" \
  --disable-crash-reporter \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --new-window \
  "${START_URL}"
