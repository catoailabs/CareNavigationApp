#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${PILLAR6_BROWSER_PROFILE:-/workspace/.runtime/browser-profile}"
DEBUG_PORT="${PILLAR6_BROWSER_DEBUG_PORT:-9222}"
# Bind address for the DevTools (CDP) socket. Defaults to loopback for local dev;
# set PILLAR6_BROWSER_DEBUG_ADDRESS=0.0.0.0 in the self-hosted stack so the web
# container can reach it over the internal Docker network (never publish 9222).
DEBUG_ADDRESS="${PILLAR6_BROWSER_DEBUG_ADDRESS:-127.0.0.1}"
# Chromium binds remote debugging to loopback only and ignores
# --remote-debugging-address, so a tiny stdlib TCP forwarder exposes the CDP
# endpoint to sibling containers on 0.0.0.0:${FORWARD_PORT} -> 127.0.0.1:${DEBUG_PORT}.
# The agent's DesktopCDPBrowser connects here (never publish 9222 directly).
FORWARD_PORT="${PILLAR6_BROWSER_FORWARD_PORT:-9223}"
START_URL="${PILLAR6_BROWSER_START_URL:-http://openemr}"
BROWSER_BIN="${PILLAR6_BROWSER_EXECUTABLE:-/usr/bin/chromium}"

mkdir -p "${PROFILE_DIR}"

# --- CDP TCP forwarder (dependency-free; disconnect-safe) ---------------------
FORWARD_MARKER="pillar6-cdp-forward"
FORWARD_SCRIPT="/tmp/${FORWARD_MARKER}.py"
if ! pgrep -f "${FORWARD_MARKER}" >/dev/null 2>&1; then
  cat >"${FORWARD_SCRIPT}" <<'PYFWD'
# pillar6-cdp-forward: 0.0.0.0:FORWARD_PORT -> 127.0.0.1:DEBUG_PORT
import os, socket, threading

LISTEN = int(os.environ.get("PILLAR6_BROWSER_FORWARD_PORT", "9223"))
TARGET = int(os.environ.get("PILLAR6_BROWSER_DEBUG_PORT", "9222"))


def _pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _handle(client):
    try:
        upstream = socket.create_connection(("127.0.0.1", TARGET))
    except OSError:
        client.close()
        return
    threading.Thread(target=_pipe, args=(client, upstream), daemon=True).start()
    _pipe(upstream, client)


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", LISTEN))
    srv.listen(64)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=_handle, args=(conn,), daemon=True).start()


main()
PYFWD
  PILLAR6_BROWSER_FORWARD_PORT="${FORWARD_PORT}" \
    PILLAR6_BROWSER_DEBUG_PORT="${DEBUG_PORT}" \
    setsid python3 "${FORWARD_SCRIPT}" >/tmp/${FORWARD_MARKER}.log 2>&1 &
fi
# -----------------------------------------------------------------------------

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
