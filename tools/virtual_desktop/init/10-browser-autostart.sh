#!/usr/bin/with-contenv bash
set -euo pipefail

AUTOSTART_DIR="/config/.config/autostart"
PROFILE_DIR="${PILLAR6_BROWSER_PROFILE:-/workspace/.runtime/browser-profile}"

mkdir -p "${AUTOSTART_DIR}" "${PROFILE_DIR}"
chown -R abc:abc "${AUTOSTART_DIR}" "${PROFILE_DIR}"

cat > "${AUTOSTART_DIR}/pillar6-browser.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Version=1.0
Name=Pillar 6 Browser
Comment=Launch Chromium with CDP enabled for the Pillar 6 runtime
Exec=/usr/local/bin/start-pillar6-browser.sh
Terminal=false
X-GNOME-Autostart-enabled=true
StartupNotify=false
EOF

chmod 0644 "${AUTOSTART_DIR}/pillar6-browser.desktop"
chown abc:abc "${AUTOSTART_DIR}/pillar6-browser.desktop"
