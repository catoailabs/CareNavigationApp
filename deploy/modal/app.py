"""
Modal deployment for the Care Navigation app.

Grounded entirely in Modal docs pulled at build time (client 1.5.1):
  - HTTP serving:        @modal.asgi_app()              (guide/webhooks)
  - Sandboxes:           modal.Sandbox.create(...)      (guide/sandboxes, sandbox-spawn)
  - Public ports:        encrypted_ports=[...] + sb.tunnels()[port].url   (guide/sandbox-networking)
  - 24h cap + relay:     timeout<=86400, sb.snapshot_filesystem(ttl=)     (guide/sandbox-snapshots)
  - Images:              Image.from_registry / from_dockerfile / add_local_dir / pip_install_from_requirements
  - Persistence:         modal.Volume.from_name(..., create_if_missing=True)
  - Config:              modal.Secret.from_name("care-navigation")

Architecture (the "mind/body" split, per your relay design):
  * agent_web   — the FastAPI agent (agent:app) served as a stable ASGI web endpoint.
  * desktop     — the virtual desktop (webtop XFCE + Chromium + CDP) as a long-lived
                  Sandbox; the agent loop drives Chromium over localhost CDP *inside*
                  the sandbox, so CDP is never tunneled. Only the VNC web UI (:3000,
                  webtop basic-auth) is exposed via an encrypted tunnel for viewing.
  * relay       — optional 23h20m handoff that snapshots the desktop filesystem and
                  respawns, so the body survives Modal's 24h Sandbox cap.

Prereqs (run once):
  modal secret create care-navigation --from-dotenv .env
    # .env must contain at least: XAI_API_KEY, PERPLEXITY_API_KEY
    # and (for production CORS) CORS_ALLOWED_ORIGINS=<your web endpoint origin>

Deploy:
  modal deploy deploy/modal/app.py        # deploys agent_web (stable URL)
  modal run deploy/modal/app.py::start_desktop   # boots the desktop sandbox, prints VNC URL
"""

from __future__ import annotations

from pathlib import Path

import modal

# Local paths are resolved from this file so `modal deploy` works from any CWD.
# Inside the Modal container the entrypoint is /root/app.py (only 2 parents), so
# guard the lookup — the build-time paths below are already baked into the image.
try:
    REPO_ROOT = Path(__file__).resolve().parents[2]
except IndexError:
    REPO_ROOT = Path("/")

app = modal.App("care-navigation")

# Config + secrets (XAI_API_KEY, PERPLEXITY_API_KEY, optional CORS_ALLOWED_ORIGINS, ...).
secret = modal.Secret.from_name("care-navigation")

# Persisted state: Strands sessions for the API.
sessions_volume = modal.Volume.from_name("care-navigation-sessions", create_if_missing=True)

# Repo paths that don't belong in the agent image.
_IGNORE = [
    ".git",
    "node_modules",
    "**/node_modules",
    ".venv",
    "venv",
    "dist",
    "**/__pycache__",
    ".strands-sessions",
    "logs",
    "ron",
    "**/.runtime",
    "src",  # frontend; the agent backend doesn't need it
    "public",
]

# ---------------------------------------------------------------------------
# Agent backend image: the lean CI requirement set + the app/tool tree.
# ---------------------------------------------------------------------------
agent_image = (
    modal.Image.from_registry("python:3.13-slim")
    .apt_install("git", "curl", "ca-certificates", "libgomp1")
    .add_local_file(
        str(REPO_ROOT / "requirements-ci.txt"), "/app/requirements-ci.txt", copy=True
    )
    .workdir("/app")
    .pip_install_from_requirements(str(REPO_ROOT / "requirements-ci.txt"))
    .env(
        {
            "PYTHONPATH": "/app:/app/tools/ronbrowser_agent_tools/src",
            # FIRST-DEPLOY BOOTSTRAP ONLY. APP_ENV=development boots without
            # CORS_ALLOWED_ORIGINS and with the auth bypass active so you can
            # smoke-test before Firebase/CORS are provisioned.
            #
            # SECURITY: before exposing this to real users you MUST set
            # APP_ENV=production (+ CORS_ALLOWED_ORIGINS, Firebase service
            # account) in the `care-navigation` secret and redeploy. At
            # APP_ENV=production the FIREBASE_AUTH_DISABLED flag is IGNORED
            # (server.firebase_admin_support.auth_disabled is fail-closed), so
            # real per-user auth is enforced and tenant isolation cannot silently
            # collapse onto a single dev uid.
            "APP_ENV": "development",
            "STRANDS_AGENT_RELOAD": "0",
            "BYPASS_TOOL_CONSENT": "true",
            "FIREBASE_AUTH_DISABLED": "true",
        }
    )
    .add_local_dir(str(REPO_ROOT), "/app", copy=True, ignore=_IGNORE)
)


@app.function(
    image=agent_image,
    secrets=[secret],
    volumes={"/app/.strands-sessions": sessions_volume},
    timeout=3600,
    min_containers=1,  # keep one container warm so the chat URL is always responsive
)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def agent_web():
    """Serve the existing FastAPI app (agent:app) as a stable Modal web endpoint."""
    import agent  # noqa: WPS433 — imported inside the container

    return agent.app
