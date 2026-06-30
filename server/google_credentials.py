"""Google OAuth client helpers: token exchange, revocation, encryption, scopes.

Responsibilities:
  * Encrypt/decrypt secrets at rest (Fernet) — reused by the tenant env store.
  * Exchange GIS authorization codes for tokens, and revoke on disconnect.
  * Build refreshed ``google.oauth2`` Credentials from a refresh token.
  * Expose a scope catalog mapping friendly service keys to Google scope URLs.

Per-user credential persistence and the request-scoped overlay now live in
``server.tenant_environment``: the user's authorized-user JSON is stored as the
sensitive tenant variable ``GOOGLE_OAUTH_CREDENTIALS`` (encrypted at rest) and
read from the request overlay by ``use_google``. This module no longer keeps a
standalone Google store or credential contextvar.

Configuration (env vars):
  GOOGLE_OAUTH_CLIENT_ID         – OAuth 2.0 client id (web application)
  GOOGLE_OAUTH_CLIENT_SECRET     – OAuth 2.0 client secret
  GOOGLE_TOKEN_ENCRYPTION_KEY    – urlsafe base64 Fernet key for secrets at rest
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
GOOGLE_REVOKE_URI = "https://oauth2.googleapis.com/revoke"


# ---------------------------------------------------------------------------
# Scope catalog
# ---------------------------------------------------------------------------

# Friendly, user-selectable Google access bundles → concrete OAuth scope URLs.
SCOPE_CATALOG: list[dict[str, str]] = [
    {
        "key": "gmail.readonly",
        "label": "Gmail (read)",
        "description": "Read email messages and threads.",
        "scope": "https://www.googleapis.com/auth/gmail.readonly",
    },
    {
        "key": "gmail.send",
        "label": "Gmail (send)",
        "description": "Send email on your behalf.",
        "scope": "https://www.googleapis.com/auth/gmail.send",
    },
    {
        "key": "gmail.modify",
        "label": "Gmail (modify)",
        "description": "Read, compose, label, and modify messages.",
        "scope": "https://www.googleapis.com/auth/gmail.modify",
    },
    {
        "key": "calendar",
        "label": "Calendar",
        "description": "View and manage calendars and events.",
        "scope": "https://www.googleapis.com/auth/calendar",
    },
    {
        "key": "calendar.readonly",
        "label": "Calendar (read)",
        "description": "View calendars and events.",
        "scope": "https://www.googleapis.com/auth/calendar.readonly",
    },
    {
        "key": "drive.readonly",
        "label": "Drive (read)",
        "description": "View files in Google Drive.",
        "scope": "https://www.googleapis.com/auth/drive.readonly",
    },
    {
        "key": "drive.file",
        "label": "Drive (app files)",
        "description": "Create and manage files the agent opens or creates.",
        "scope": "https://www.googleapis.com/auth/drive.file",
    },
    {
        "key": "contacts.readonly",
        "label": "Contacts (read)",
        "description": "View your contacts.",
        "scope": "https://www.googleapis.com/auth/contacts.readonly",
    },
    {
        "key": "userinfo.email",
        "label": "Identity (email)",
        "description": "Know which Google account is connected.",
        "scope": "https://www.googleapis.com/auth/userinfo.email",
    },
]

_KEY_TO_SCOPE = {entry["key"]: entry["scope"] for entry in SCOPE_CATALOG}
_VALID_SCOPES = set(_KEY_TO_SCOPE.values())


def scope_catalog() -> list[dict[str, str]]:
    """Return the public scope catalog for the connect UI."""
    return [dict(entry) for entry in SCOPE_CATALOG]


def resolve_scopes(selection: Any) -> list[str]:
    """Map a list of catalog keys and/or raw scope URLs to scope URLs.

    Unknown entries are dropped. ``userinfo.email`` is always included so the
    backend can identify the connected account.
    """
    resolved: list[str] = []
    if isinstance(selection, (list, tuple)):
        for item in selection:
            value = str(item).strip()
            if not value:
                continue
            if value in _KEY_TO_SCOPE:
                resolved.append(_KEY_TO_SCOPE[value])
            elif value in _VALID_SCOPES or value.startswith("https://www.googleapis.com/auth/"):
                resolved.append(value)
    identity = _KEY_TO_SCOPE["userinfo.email"]
    if identity not in resolved:
        resolved.append(identity)
    # Preserve order, drop duplicates.
    seen: set[str] = set()
    ordered: list[str] = []
    for scope in resolved:
        if scope not in seen:
            seen.add(scope)
            ordered.append(scope)
    return ordered


# ---------------------------------------------------------------------------
# Encryption
# ---------------------------------------------------------------------------


def _fernet() -> Any:
    from cryptography.fernet import Fernet

    key = os.getenv("GOOGLE_TOKEN_ENCRYPTION_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "GOOGLE_TOKEN_ENCRYPTION_KEY is not set. Generate one with "
            "`python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'`."
        )
    try:
        return Fernet(key.encode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("GOOGLE_TOKEN_ENCRYPTION_KEY is not a valid Fernet key.") from exc


def encrypt_secret(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_secret(ciphertext: str) -> str:
    return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")


# ---------------------------------------------------------------------------
# OAuth client config
# ---------------------------------------------------------------------------


def _client_id() -> str:
    value = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "").strip()
    if not value:
        raise RuntimeError("GOOGLE_OAUTH_CLIENT_ID is not set.")
    return value


def _client_secret() -> str:
    value = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", "").strip()
    if not value:
        raise RuntimeError("GOOGLE_OAUTH_CLIENT_SECRET is not set.")
    return value


# ---------------------------------------------------------------------------
# Token exchange / refresh / revoke
# ---------------------------------------------------------------------------


def exchange_authorization_code(code: str, redirect_uri: str = "postmessage") -> dict[str, Any]:
    """Exchange a GIS authorization code for tokens.

    Returns the raw token response. Raises RuntimeError on failure.
    """
    import requests

    response = requests.post(
        GOOGLE_TOKEN_URI,
        data={
            "code": code,
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Google token exchange failed: {response.status_code} {response.text}")
    return response.json()


def revoke_token(token: str) -> None:
    """Best-effort revocation of a refresh/access token at Google."""
    import requests

    try:
        requests.post(
            GOOGLE_REVOKE_URI,
            params={"token": token},
            headers={"content-type": "application/x-www-form-urlencoded"},
            timeout=30,
        )
    except Exception as exc:  # noqa: BLE001 - revocation is best-effort
        logger.warning("Google token revocation failed: %s", exc)


def build_credentials(refresh_token: str, scopes: list[str]) -> Any:
    """Build and refresh a google.oauth2 Credentials from a refresh token.

    Mints a fresh access token. Raises on refresh failure (e.g. revoked grant).
    """
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request

    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri=GOOGLE_TOKEN_URI,
        client_id=_client_id(),
        client_secret=_client_secret(),
        scopes=scopes,
    )
    creds.refresh(Request())
    return creds

