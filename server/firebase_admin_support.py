"""Firebase Admin SDK integration for the agent backend.

Provides lazy initialization of the Firebase Admin app, verification of
Firebase ID tokens sent as ``Authorization: Bearer <token>`` headers, and a
shared Firestore client used by the per-user Google credential store.

Configuration (env vars):
  FIREBASE_SERVICE_ACCOUNT_JSON   – inline service-account JSON (preferred for secrets)
  FIREBASE_SERVICE_ACCOUNT_FILE   – path to a service-account JSON file
  GOOGLE_APPLICATION_CREDENTIALS  – standard ADC path (fallback)
  FIREBASE_PROJECT_ID             – explicit project id (optional)
  FIREBASE_AUTH_DISABLED          – "true" to bypass verification for local dev
  DEV_FALLBACK_UID                – uid returned when auth is disabled (default: "dev-user")
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Optional

logger = logging.getLogger(__name__)

_INIT_LOCK = threading.Lock()
_app: Any = None
_firestore_client: Any = None


def auth_disabled() -> bool:
    """Return True when Firebase auth verification is bypassed (local dev)."""
    return os.getenv("FIREBASE_AUTH_DISABLED", "").strip().lower() == "true"


def _load_credential() -> Any:
    """Build a firebase_admin credential from configured env, or None for ADC."""
    from firebase_admin import credentials

    inline = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if inline:
        try:
            return credentials.Certificate(json.loads(inline))
        except (ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(
                "FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON."
            ) from exc

    file_path = (
        os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE")
        or os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    )
    if file_path and os.path.exists(file_path):
        return credentials.Certificate(file_path)

    # Fall back to application default credentials (e.g. GCP runtime).
    return None


def get_app() -> Any:
    """Return the initialized Firebase Admin app, creating it on first use."""
    global _app
    if _app is not None:
        return _app
    with _INIT_LOCK:
        if _app is not None:
            return _app
        import firebase_admin

        try:
            _app = firebase_admin.get_app()
            return _app
        except ValueError:
            pass

        cred = _load_credential()
        options: dict[str, Any] = {}
        project_id = os.getenv("FIREBASE_PROJECT_ID", "").strip()
        if project_id:
            options["projectId"] = project_id
        if cred is not None:
            _app = firebase_admin.initialize_app(cred, options or None)
        else:
            _app = firebase_admin.initialize_app(options=options or None)
        logger.info("Firebase Admin app initialized")
        return _app


def get_firestore_client() -> Any:
    """Return a cached Firestore client bound to the Admin app."""
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client
    with _INIT_LOCK:
        if _firestore_client is None:
            from firebase_admin import firestore

            _firestore_client = firestore.client(get_app())
    return _firestore_client


def verify_id_token(token: str) -> str:
    """Verify a Firebase ID token and return its uid.

    Raises ValueError when the token is missing or invalid.
    """
    if not token:
        raise ValueError("Missing bearer token")
    from firebase_admin import auth

    try:
        decoded = auth.verify_id_token(token, app=get_app())
    except Exception as exc:  # noqa: BLE001 - normalize to a single error type
        raise ValueError(f"Invalid Firebase ID token: {exc}") from exc
    uid = decoded.get("uid")
    if not uid:
        raise ValueError("Token did not contain a uid")
    return str(uid)


def _bearer_from_headers(headers: Any) -> Optional[str]:
    authorization = headers.get("authorization") or headers.get("Authorization")
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return authorization.strip()


def resolve_uid(request: Any) -> str:
    """Resolve the authenticated uid for a FastAPI/Starlette request.

    Honors ``FIREBASE_AUTH_DISABLED`` for local development. Raises
    ``fastapi.HTTPException`` (401) when authentication fails.
    """
    from fastapi import HTTPException

    if auth_disabled():
        dev_uid = (
            request.headers.get("x-dev-uid")
            or os.getenv("DEV_FALLBACK_UID", "dev-user")
        )
        return str(dev_uid)

    token = _bearer_from_headers(request.headers)
    if not token:
        raise HTTPException(status_code=401, detail="Missing Authorization bearer token")
    try:
        return verify_id_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
