"""
Modal virtual-desktop body for the Care Navigation agent (separate from the
deployed web endpoint in app.py so the stable service never waits on this build).

Grounded in Modal 1.5.1 docs:
  - modal.Sandbox.create(*cmd, app=, image=, encrypted_ports=[...], volumes=, timeout<=86400, name=)
  - sb.tunnels()[port].url            (guide/sandbox-networking)
  - sb.exec(...), sb.terminate()      (guide/sandbox-spawn)
  - sb.snapshot_filesystem(ttl=)      (guide/sandbox-snapshots)
  - modal.Image.from_dockerfile(path, context_dir=)

The agent loop runs INSIDE this sandbox and drives Chromium over localhost CDP
(:9222), so CDP is never tunneled. Only the auth-gated webtop GUI (:3000) is
exposed for a human to watch.

Launch (ephemeral, prints the VNC URL):
    modal run deploy/modal/desktop.py::start_desktop
Run the continuous 24h relay:
    modal run deploy/modal/desktop.py::run_desktop_relay
Stop the relay chain gracefully:
    modal volume put care-navigation-desktop /dev/null /STOP   # or touch /config/STOP inside
"""

from __future__ import annotations

from pathlib import Path

import modal

# Guarded so it doesn't IndexError inside the Modal container (entrypoint at
# /root/desktop.py); build-time paths are unused there.
try:
    REPO_ROOT = Path(__file__).resolve().parents[2]
except IndexError:
    REPO_ROOT = Path("/")

app = modal.App("care-navigation-desktop")

secret = modal.Secret.from_name("care-navigation")
desktop_volume = modal.Volume.from_name("care-navigation-desktop", create_if_missing=True)

# Reuse the validated webtop image (XFCE + Chromium + CDP + Strands tooling).
desktop_image = modal.Image.from_dockerfile(
    str(REPO_ROOT / "deploy" / "Dockerfile.agent-desktop"),
    context_dir=str(REPO_ROOT),
)

# Webtop GUI port (NoVNC/Selkies). CDP (9222) is intentionally internal-only.
VNC_PORT = 3000
HANDOFF_THRESHOLD_SEC = (23 * 3600) + (20 * 60)


def _create_desktop(restore_image_id: str | None) -> "modal.Sandbox":
    img = modal.Image.from_id(restore_image_id) if restore_image_id else desktop_image
    return modal.Sandbox.create(
        "/init",  # webtop s6 init: starts XFCE + autostarts Chromium with CDP
        app=app,
        image=img,
        encrypted_ports=[VNC_PORT],
        volumes={"/config": desktop_volume},
        timeout=86_400,  # Modal max Sandbox lifetime; the relay extends past it
        name="care-navigation-desktop",
    )


@app.function(image=desktop_image, secrets=[secret], timeout=86_400)
def start_desktop(restore_image_id: str | None = None) -> str:
    """Boot (or restore) the desktop Sandbox and return its public VNC URL."""
    sb = _create_desktop(restore_image_id)
    url = sb.tunnels()[VNC_PORT].url
    print(f"🖥️  Agent desktop live (webtop basic-auth): {url}")
    return url


@app.function(image=desktop_image, secrets=[secret], timeout=86_400)
def run_desktop_relay(restore_image_id: str | None = None) -> None:
    """One ~23h20m lifecycle, then snapshot the filesystem and respawn the successor.

    Browser profile + state persist on the Volume; the filesystem snapshot carries
    any other in-container changes across the hop. Touch `/config/STOP` to end the
    chain gracefully instead of spawning the next link (the escape hatch).
    """
    import time

    sb = _create_desktop(restore_image_id)
    print(f"🖥️  desktop up: {sb.tunnels()[VNC_PORT].url}")

    start = time.time()
    while time.time() - start < HANDOFF_THRESHOLD_SEC:
        flag = sb.exec("bash", "-c", "test -f /config/STOP && echo STOP || true")
        if "STOP" in flag.stdout.read():
            print("🛑 stop flag found — ending relay chain.")
            sb.terminate()
            return
        time.sleep(30)

    print("📸 snapshotting desktop filesystem for handoff…")
    snap = sb.snapshot_filesystem(ttl=7 * 24 * 3600)
    sb.terminate()
    print("🚀 spawning next link in the relay…")
    run_desktop_relay.spawn(restore_image_id=snap.object_id)


@app.local_entrypoint()
def main():
    print("Desktop VNC URL:", start_desktop.remote())
