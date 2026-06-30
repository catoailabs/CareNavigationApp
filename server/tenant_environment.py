"""Multi-tenant environment store with a request-scoped overlay.

Why this module exists
----------------------
``os.environ``) is a single process-global namespace shared by every
concurrently-served tenant. Writing tenant data into it (as a process-global
environment store would) leaks one tenant's secrets to every
in-flight request. This module replaces that unsafe path with three scopes:

* **Process env** (``os.environ``) – deploy config only (model keys, PATH,
  Fernet/OAuth-app/Firebase secrets, ``BYPASS_TOOL_CONSENT``). Read-only to
  tenants; never written with tenant data.
* **Tenant env** – per-uid variables (including the user's Google credentials)
  persisted in Firestore at ``tenant_environments/{uid}/vars/{NAME}`` (one doc
  per variable, so a tenant can store effectively unlimited vars without
  hitting the 1 MiB per-document cap). Sensitive values are Fernet-encrypted
  at rest.
* **Request overlay** – the active tenant's decrypted env for THIS request,
  held in a ``contextvars.ContextVar`` bound to the request's async task. The
  ``environment`` tool and ``use_google`` read it; concurrent users never share
  state because asyncio copies context per task.

Lookup order for a value: **request overlay (tenant) -> os.environ (read-only)
-> not found.**

Local dev: when ``FIREBASE_AUTH_DISABLED=true`` the store is backed by a local
JSON file instead of Firestore, but with **identical semantics** — variables are
keyed per-uid and Fernet-encrypted at rest exactly as in Firestore. Dev therefore
exercises the same multi-tenant isolation as production; there is no shared
single-tenant store. If ``GOOGLE_TOKEN_ENCRYPTION_KEY`` is unset locally, a dev
key is auto-generated and persisted beside the store file so encryption-at-rest
works with zero setup.

Configuration (env vars):
  GOOGLE_TOKEN_ENCRYPTION_KEY    – Fernet key (reused from server.google_credentials)
  TENANT_ENV_COLLECTION          – root collection (default: "tenant_environments")
  TENANT_PROTECTED_EXTRA         – comma-separated extra protected names
  FIREBASE_AUTH_DISABLED         – "true" routes the store to the local dev file
  DEV_FALLBACK_UID               – default uid for the dev fallback (default: "dev-user")
  TENANT_ENV_DEV_FILE            – path to the local dev store (default: "data/tenant_environments.dev.json")
"""

from __future__ import annotations

import base64
import contextvars
import json
import logging
import os
import re
import threading
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Names, sensitivity, and protection
# ---------------------------------------------------------------------------

# Same grammar the legacy store enforced.
ENV_VAR_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")

# Every tenant-supplied variable is treated as sensitive — encrypted at rest
# and masked to the model. The store cannot know what a value actually is: a
# credit-card number, a membership id, a policy number, a one-time code, or a
# plain note all look the same. Guessing from the NAME is unsafe, so we never
# guess. If a tenant put it here, it is private. Full stop.

# Process-level names a tenant may NEVER write or shadow: OS/runtime config plus
# the backend's own infra/app secrets.
# NOTE: ``GOOGLE_OAUTH_CREDENTIALS`` is intentionally NOT here — that is the
# per-tenant Google credential blob this store is designed to hold. The
# app-level OAuth client id/secret and the service-account path ARE protected.
_BASE_PROCESS_PROTECTED = {
    # OS / runtime
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "PYTHONPATH",
    "STRANDS_HOME",
    "BYPASS_TOOL_CONSENT",
    # Encryption / identity / OAuth-app secrets (backend-owned)
    "GOOGLE_TOKEN_ENCRYPTION_KEY",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_FIRESTORE_COLLECTION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "FIREBASE_SERVICE_ACCOUNT_FILE",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_AUTH_DISABLED",
    "DEV_FALLBACK_UID",
    "TENANT_ENV_COLLECTION",
    "TENANT_PROTECTED_EXTRA",
    # Model provider keys (process-global for now)
    "XAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "PERPLEXITY_API_KEY",
    # CORS / server config
    "CORS_ALLOWED_ORIGINS",
    "APP_ENV",
}

MASKED_SENTINEL = "[set · hidden]"

DEFAULT_COLLECTION = "tenant_environments"


def _extra_protected() -> set[str]:
    raw = os.getenv("TENANT_PROTECTED_EXTRA", "").strip()
    if not raw:
        return set()
    return {part.strip() for part in raw.split(",") if part.strip()}


def process_protected_names() -> set[str]:
    """Return the full set of names tenants cannot write or shadow."""
    return _BASE_PROCESS_PROTECTED | _extra_protected()


def is_process_protected(name: str) -> bool:
    return name.strip() in process_protected_names()


def is_sensitive_name(name: str) -> bool:
    # Policy: ALL tenant variables are sensitive. We do not classify by name.
    # Kept as a function (rather than inlining ``True``) so every call site keeps
    # a single, auditable source of truth for the masking/encryption decision.
    return True


def _validate_name(name: str) -> str:
    clean = (name or "").strip()
    if not clean:
        raise ValueError("name is required")
    if is_process_protected(clean):
        raise ValueError(
            f"Cannot modify protected process variable: {clean}. Protected names: "
            + ", ".join(sorted(process_protected_names()))
        )
    if not ENV_VAR_NAME_RE.match(clean):
        raise ValueError(
            f"Invalid variable name: {clean}. Names must match ^[A-Z_][A-Z0-9_]*$"
        )
    return clean


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Request-scoped overlay (task-local)
# ---------------------------------------------------------------------------

# The active tenant's uid for this request/task.
current_tenant_uid: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar(
    "current_tenant_uid", default=None
)

# The active tenant's decrypted env for this request/task. Shape:
#   { NAME: {"value": str | None, "sensitive": bool, "updated_at": str | None,
#            "decrypt_error": bool} }
# ``value`` is None only when a sensitive value failed to decrypt.
current_tenant_env: "contextvars.ContextVar[Optional[dict[str, dict[str, Any]]]]" = (
    contextvars.ContextVar("current_tenant_env", default=None)
)


class _ScopeToken:
    """Bundles the two contextvar reset tokens for one request scope."""

    __slots__ = ("_uid_token", "_env_token")

    def __init__(self, uid_token: Any, env_token: Any) -> None:
        self._uid_token = uid_token
        self._env_token = env_token

    def reset(self) -> None:
        current_tenant_env.reset(self._env_token)
        current_tenant_uid.reset(self._uid_token)


# ---------------------------------------------------------------------------
# Encryption (reuse the Fernet helper from server.google_credentials)
# ---------------------------------------------------------------------------


def _encrypt(plaintext: str) -> str:
    from server.google_credentials import encrypt_secret

    return encrypt_secret(plaintext)


def _decrypt(ciphertext: str) -> str:
    from server.google_credentials import decrypt_secret

    return decrypt_secret(ciphertext)


# ---------------------------------------------------------------------------
# Backend selection: local dev file vs Firestore (both per-uid + encrypted)
# ---------------------------------------------------------------------------


def _use_dev_fallback() -> bool:
    """True when Firebase auth is disabled (local dev): use the local file.

    This selects only *where the bytes live* (local JSON file vs Firestore).
    Both backends are per-uid and encrypted at rest with identical semantics,
    so tenant isolation is the same regardless of which one is active.
    """
    from server.firebase_admin_support import auth_disabled

    return auth_disabled()


def _dev_uid() -> str:
    return os.getenv("DEV_FALLBACK_UID", "dev-user")


def _collection_name() -> str:
    return os.getenv("TENANT_ENV_COLLECTION", DEFAULT_COLLECTION).strip() or DEFAULT_COLLECTION


def _vars_collection(uid: str) -> Any:
    from server.firebase_admin_support import get_firestore_client

    return (
        get_firestore_client()
        .collection(_collection_name())
        .document(uid)
        .collection("vars")
    )


# -- Firestore-backed primitives -------------------------------------------------


def _firestore_load(uid: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for snapshot in _vars_collection(uid).stream():
        name = snapshot.id
        data = snapshot.to_dict() or {}
        # Sensitivity is policy-driven on read, not just whatever was stored.
        # ``is_sensitive_name`` now returns True for every variable, so legacy
        # docs written under the old name-based heuristic (sensitive=False,
        # stored plaintext) are still masked to the model immediately, before
        # any at-rest backfill runs. The OR keeps this correct even if the
        # policy ever narrows again.
        sensitive = bool(data.get("sensitive")) or is_sensitive_name(name)
        encrypted = bool(data.get("encrypted"))
        raw = data.get("value", "")
        value: Optional[str]
        decrypt_error = False
        if encrypted:
            try:
                value = _decrypt(str(raw))
            except Exception as exc:  # noqa: BLE001 - rotated/invalid key
                logger.warning("Failed to decrypt %s for uid=%s: %s", name, uid, exc)
                value = None
                decrypt_error = True
        else:
            value = str(raw)
        out[name] = {
            "value": value,
            "sensitive": sensitive,
            "updated_at": data.get("updated_at"),
            "decrypt_error": decrypt_error,
        }
    return out


def _firestore_set(uid: str, name: str, value: str, sensitive: bool) -> None:
    payload: dict[str, Any] = {
        "sensitive": sensitive,
        "encrypted": sensitive,
        "value": _encrypt(value) if sensitive else value,
        "updated_at": _now_iso(),
    }
    doc = _vars_collection(uid).document(name)
    if not doc.get().exists:
        payload["created_at"] = payload["updated_at"]
    doc.set(payload, merge=True)


def _firestore_delete(uid: str, name: str) -> None:
    _vars_collection(uid).document(name).delete()


def migrate_encrypt_at_rest(uid: str) -> dict[str, int]:
    """Re-encrypt any legacy plaintext docs for one uid (operator backfill).

    Under the current policy every variable is sensitive and encrypted at rest.
    Documents written before that policy may still be stored as plaintext
    (``encrypted=False``). This walks the uid's ``vars`` collection and rewrites
    each plaintext doc as encrypted + sensitive. It is idempotent (already-
    encrypted docs are skipped) and only touches that uid's own records, so it is
    safe to re-run. NOT auto-invoked — call it explicitly per uid from a migration
    script or admin endpoint. The read path already masks legacy docs to the model
    (see ``_firestore_load``); this closes the at-rest gap.

    Returns ``{"scanned": N, "migrated": M}``.
    """
    scanned = 0
    migrated = 0
    for snapshot in _vars_collection(uid).stream():
        scanned += 1
        data = snapshot.to_dict() or {}
        if bool(data.get("encrypted")):
            continue
        plaintext = str(data.get("value", ""))
        snapshot.reference.set(
            {
                "sensitive": True,
                "encrypted": True,
                "value": _encrypt(plaintext),
                "updated_at": _now_iso(),
            },
            merge=True,
        )
        migrated += 1
    if migrated:
        logger.info("migrate_encrypt_at_rest uid=%s scanned=%d migrated=%d", uid, scanned, migrated)
    return {"scanned": scanned, "migrated": migrated}


# -- Local dev store (per-uid JSON file, encrypted at rest) ----------------------
#
# Mirrors the Firestore backend exactly: one record per (uid, name), values
# Fernet-encrypted at rest, sensitivity policy applied on read. The on-disk shape
# is ``{"tenants": {uid: {name: {value, sensitive, encrypted, created_at,
# updated_at}}}}`` so two dev users never share state. No os.environ writes.

_DEV_STORE_LOCK = threading.RLock()


def _dev_store_path() -> Path:
    return Path(os.getenv("TENANT_ENV_DEV_FILE", "data/tenant_environments.dev.json"))


def _dev_key_path() -> Path:
    p = _dev_store_path()
    return p.with_name(p.name + ".key")


def _dev_fernet() -> Any:
    """Fernet for the dev store.

    Uses ``GOOGLE_TOKEN_ENCRYPTION_KEY`` when set (parity with prod). Otherwise
    auto-generates and persists a local key beside the store file so dev gets
    real encryption-at-rest with zero setup.

    The key file is created atomically with ``O_CREAT | O_EXCL`` at mode 0o600,
    so it is never momentarily world-readable (``write_text`` would create it
    under the umask first) and concurrent first-time callers — including
    separate worker processes sharing the same path — cannot clobber each
    other's key: the loser of the race re-reads the winner's key rather than
    overwriting the key that already encrypted persisted data.
    """
    from cryptography.fernet import Fernet

    key = os.getenv("GOOGLE_TOKEN_ENCRYPTION_KEY", "").strip()
    if not key:
        key_path = _dev_key_path()
        key_path.parent.mkdir(parents=True, exist_ok=True)
        new_key = Fernet.generate_key().decode("utf-8")
        try:
            fd = os.open(str(key_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            key = key_path.read_text(encoding="utf-8").strip()
        else:
            try:
                os.write(fd, new_key.encode("utf-8"))
            finally:
                os.close(fd)
            key = new_key
    return Fernet(key.encode("utf-8"))


def _dev_encrypt(plaintext: str) -> str:
    return _dev_fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def _dev_decrypt(ciphertext: str) -> str:
    return _dev_fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")


def _dev_read_all() -> dict[str, dict[str, dict[str, Any]]]:
    path = _dev_store_path()
    if not path.exists():
        return {"tenants": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"tenants": {}}
    if not isinstance(data, dict) or not isinstance(data.get("tenants"), dict):
        return {"tenants": {}}
    return data


def _dev_write_all(data: dict[str, Any]) -> None:
    path = _dev_store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _dev_load(uid: str) -> dict[str, dict[str, Any]]:
    tenant = _dev_read_all()["tenants"].get(uid, {})
    out: dict[str, dict[str, Any]] = {}
    for name, rec in tenant.items():
        if not isinstance(rec, dict):
            continue
        sensitive = bool(rec.get("sensitive")) or is_sensitive_name(name)
        encrypted = bool(rec.get("encrypted"))
        raw = rec.get("value", "")
        value: Optional[str]
        decrypt_error = False
        if encrypted:
            try:
                value = _dev_decrypt(str(raw))
            except Exception as exc:  # noqa: BLE001 - rotated/invalid key
                logger.warning("Failed to decrypt %s for uid=%s: %s", name, uid, exc)
                value = None
                decrypt_error = True
        else:
            value = str(raw)
        out[name] = {
            "value": value,
            "sensitive": sensitive,
            "updated_at": rec.get("updated_at"),
            "decrypt_error": decrypt_error,
        }
    return out


def _dev_set(uid: str, name: str, value: str, sensitive: bool) -> None:
    """Persist to the per-uid dev file WITHOUT touching os.environ."""
    with _DEV_STORE_LOCK:
        data = _dev_read_all()
        tenant = data["tenants"].setdefault(uid, {})
        now = _now_iso()
        existing = tenant.get(name)
        record: dict[str, Any] = {
            "sensitive": sensitive,
            "encrypted": sensitive,
            "value": _dev_encrypt(value) if sensitive else value,
            "updated_at": now,
        }
        # Mirror Firestore's _firestore_set: set created_at only on first write.
        # On update, carry the prior value through only if it was present (do not
        # fabricate one), so the dev and Firestore backends stay identical.
        if isinstance(existing, dict):
            if "created_at" in existing:
                record["created_at"] = existing["created_at"]
        else:
            record["created_at"] = now
        tenant[name] = record
        _dev_write_all(data)


def _dev_delete(uid: str, name: str) -> None:
    with _DEV_STORE_LOCK:
        data = _dev_read_all()
        tenant = data["tenants"].get(uid)
        if isinstance(tenant, dict) and name in tenant:
            del tenant[name]
            _dev_write_all(data)


# -- Store dispatch --------------------------------------------------------------


def _store_load(uid: str) -> dict[str, dict[str, Any]]:
    if _use_dev_fallback():
        return _dev_load(uid)
    return _firestore_load(uid)


def _store_set(uid: str, name: str, value: str, sensitive: bool) -> None:
    if _use_dev_fallback():
        _dev_set(uid, name, value, sensitive)
    else:
        _firestore_set(uid, name, value, sensitive)


def _store_delete(uid: str, name: str) -> None:
    if _use_dev_fallback():
        _dev_delete(uid, name)
    else:
        _firestore_delete(uid, name)


# ---------------------------------------------------------------------------
# Overlay lifecycle
# ---------------------------------------------------------------------------


def load_tenant_env(uid: str) -> _ScopeToken:
    """Load a uid's tenant env from the store and bind it to this task.

    Returns a token; call ``token.reset()`` in a ``finally`` at request end so
    no overlay leaks into the next request served on the same task.
    """
    overlay = _store_load(uid)
    uid_token = current_tenant_uid.set(uid)
    env_token = current_tenant_env.set(overlay)
    return _ScopeToken(uid_token, env_token)


def reset_tenant_env(token: _ScopeToken) -> None:
    token.reset()


def _current_uid() -> Optional[str]:
    uid = current_tenant_uid.get()
    if uid:
        return uid
    # Standalone/CLI use under dev mode: default to the dev uid so the tool
    # still functions without an HTTP request having set the overlay.
    if _use_dev_fallback():
        return _dev_uid()
    return None


def _overlay() -> Optional[dict[str, dict[str, Any]]]:
    return current_tenant_env.get()


# ---------------------------------------------------------------------------
# Overlay accessors used by tools and endpoints
# ---------------------------------------------------------------------------


def tenant_env_get(name: str) -> Optional[str]:
    """Resolve a variable to PLAINTEXT for execution boundaries.

    Order: request overlay (tenant) -> os.environ (read-only) -> None. This
    returns real values and must NEVER be sent to the model for sensitive
    vars — the ``environment`` tool masks separately. Used by ``use_google``
    and the execution-boundary helpers.
    """
    clean = (name or "").strip()
    if not clean:
        return None
    overlay = _overlay()
    if overlay is not None and clean in overlay:
        return overlay[clean].get("value")
    return os.environ.get(clean)


def tenant_env_metadata(name: str) -> Optional[dict[str, Any]]:
    """Return display metadata for a tenant var, or None if absent.

    Shape: {name, sensitive, updated_at, present, decrypt_error, display}.
    ``display`` is the model-safe value: masked sentinel for sensitive vars,
    plaintext for non-sensitive ones.
    """
    clean = (name or "").strip()
    overlay = _overlay()
    if overlay is None or clean not in overlay:
        return None
    entry = overlay[clean]
    sensitive = bool(entry.get("sensitive"))
    value = entry.get("value")
    if sensitive or entry.get("decrypt_error"):
        display = MASKED_SENTINEL
    else:
        display = value if value is not None else ""
    return {
        "name": clean,
        "sensitive": sensitive,
        "updated_at": entry.get("updated_at"),
        "present": True,
        "decrypt_error": bool(entry.get("decrypt_error")),
        "display": display,
    }


def tenant_env_list() -> list[dict[str, Any]]:
    """Return model-safe metadata for every tenant var in the overlay."""
    overlay = _overlay()
    if not overlay:
        return []
    out: list[dict[str, Any]] = []
    for name in sorted(overlay):
        meta = tenant_env_metadata(name)
        if meta is not None:
            out.append(meta)
    return out


def tenant_env_all() -> dict[str, str]:
    """Return {NAME: plaintext} for every tenant var (decrypted).

    For execution-boundary injection into child processes. Excludes
    ``os.environ`` (process secrets stay in the process) and any var that
    failed to decrypt.
    """
    overlay = _overlay()
    if not overlay:
        return {}
    out: dict[str, str] = {}
    for name, entry in overlay.items():
        value = entry.get("value")
        if value is not None:
            out[name] = str(value)
    return out


def tenant_env_set(name: str, value: str) -> dict[str, Any]:
    """Validate, persist, and update the overlay for the current tenant.

    Returns the new metadata. Raises ValueError for protected/invalid names
    and RuntimeError when no tenant context is bound.
    """
    clean = _validate_name(name)
    if value is None:
        raise ValueError("value is required")
    uid = _current_uid()
    if not uid:
        raise RuntimeError("No tenant context: cannot set a variable outside a request.")
    sensitive = is_sensitive_name(clean)
    _store_set(uid, clean, str(value), sensitive)

    overlay = _overlay()
    if overlay is None:
        overlay = {}
        current_tenant_env.set(overlay)
    overlay[clean] = {
        "value": str(value),
        "sensitive": sensitive,
        "updated_at": _now_iso(),
        "decrypt_error": False,
    }
    meta = tenant_env_metadata(clean)
    assert meta is not None
    return meta


def tenant_env_delete(name: str) -> None:
    """Remove a variable from the store and the overlay for the current tenant."""
    clean = (name or "").strip()
    if not clean:
        raise ValueError("name is required")
    if is_process_protected(clean):
        raise ValueError(f"Cannot delete protected process variable: {clean}")
    uid = _current_uid()
    if not uid:
        raise RuntimeError("No tenant context: cannot delete a variable outside a request.")
    _store_delete(uid, clean)
    overlay = _overlay()
    if overlay is not None:
        overlay.pop(clean, None)


# ---------------------------------------------------------------------------
# Endpoint helpers (operate on a uid directly, no overlay required)
# ---------------------------------------------------------------------------


def tenant_env_list_for_uid(uid: str) -> list[dict[str, Any]]:
    """Masked listing for the settings UI (does not require an overlay)."""
    overlay = _store_load(uid)
    out: list[dict[str, Any]] = []
    for name in sorted(overlay):
        entry = overlay[name]
        sensitive = bool(entry.get("sensitive"))
        value = entry.get("value")
        display = MASKED_SENTINEL if (sensitive or entry.get("decrypt_error")) else (value or "")
        out.append(
            {
                "name": name,
                "value": display,
                "sensitive": sensitive,
                "protected": is_process_protected(name),
                "updated_at": entry.get("updated_at"),
            }
        )
    return out


def tenant_env_set_for_uid(uid: str, name: str, value: str) -> None:
    """Persist a variable for a uid (settings UI POST)."""
    clean = _validate_name(name)
    if value is None:
        raise ValueError("value is required")
    _store_set(uid, clean, str(value), is_sensitive_name(clean))


def tenant_env_delete_for_uid(uid: str, name: str) -> None:
    """Delete a variable for a uid (settings UI DELETE)."""
    clean = (name or "").strip()
    if not clean:
        raise ValueError("name is required")
    if is_process_protected(clean):
        raise ValueError(f"Cannot delete protected process variable: {clean}")
    _store_delete(uid, clean)


def tenant_env_metadata_for_uid(uid: str, name: str) -> Optional[dict[str, Any]]:
    """Return presence/metadata for one var for a uid (e.g. Google status)."""
    overlay = _store_load(uid)
    clean = (name or "").strip()
    if clean not in overlay:
        return None
    entry = overlay[clean]
    return {
        "name": clean,
        "sensitive": bool(entry.get("sensitive")),
        "updated_at": entry.get("updated_at"),
        "present": True,
        "decrypt_error": bool(entry.get("decrypt_error")),
    }


def tenant_env_get_for_uid(uid: str, name: str) -> Optional[str]:
    """Return the decrypted PLAINTEXT value of one var for a uid, or None.

    Loads the uid's store directly (no request overlay required). Returns None
    when the variable is absent or a sensitive value failed to decrypt. Used by
    backend endpoints that must act on the owner's own secret (e.g. revoking a
    Google grant or reading granted scopes for the status payload). MUST NOT be
    used to send a sensitive value to the model.
    """
    overlay = _store_load(uid)
    clean = (name or "").strip()
    if clean not in overlay:
        return None
    return overlay[clean].get("value")


# ---------------------------------------------------------------------------
# Execution-boundary helpers ("use without divulging")
# ---------------------------------------------------------------------------

_ENV_TOKEN_RE = re.compile(r"\$\{env:([A-Z_][A-Z0-9_]*)\}")


def resolve_env_tokens(text: str) -> str:
    """Expand ``${env:NAME}`` tokens from the tenant overlay / os.environ.

    Used by the tool-arg substitution interceptor just before a tool runs.
    Unknown names are left intact so the failure is visible rather than silent.
    """
    if not isinstance(text, str) or "${env:" not in text:
        return text

    def _sub(match: "re.Match[str]") -> str:
        name = match.group(1)
        value = tenant_env_get(name)
        return value if value is not None else match.group(0)

    return _ENV_TOKEN_RE.sub(_sub, text)


def _transformed_forms(value: str) -> list[str]:
    """Return encoded forms of a secret value that redaction should also catch."""
    forms: list[str] = []
    raw = value.encode("utf-8")
    try:
        forms.append(base64.b64encode(raw).decode("ascii"))
        forms.append(base64.b64encode(raw).decode("ascii").rstrip("="))
        forms.append(base64.urlsafe_b64encode(raw).decode("ascii"))
        forms.append(base64.urlsafe_b64encode(raw).decode("ascii").rstrip("="))
    except Exception:  # noqa: BLE001
        pass
    try:
        forms.append(raw.hex())
    except Exception:  # noqa: BLE001
        pass
    try:
        forms.append(urllib.parse.quote(value, safe=""))
    except Exception:  # noqa: BLE001
        pass
    return [f for f in forms if f and f != value]


def redact_secrets(text: str) -> str:
    """Replace any known sensitive tenant value (and common encoded forms) with
    ``[redacted]``. A backstop, not a guarantee (see plan's honest limitation).
    """
    if not isinstance(text, str) or not text:
        return text
    overlay = _overlay()
    if not overlay:
        return text
    redacted = text
    # Longest values first so substrings of larger secrets are handled first.
    secrets: list[str] = []
    for entry in overlay.values():
        if not entry.get("sensitive"):
            continue
        value = entry.get("value")
        if value and isinstance(value, str) and len(value) >= 4:
            secrets.append(value)
    for value in sorted(secrets, key=len, reverse=True):
        if value in redacted:
            redacted = redacted.replace(value, "[redacted]")
        for form in _transformed_forms(value):
            if len(form) >= 4 and form in redacted:
                redacted = redacted.replace(form, "[redacted]")
    return redacted


def child_process_env(base: Optional[dict[str, str]] = None) -> dict[str, str]:
    """Build an env dict for a spawned child: base (or os.environ) + tenant vars.

    The parent ``os.environ`` is never mutated — tenant values live only in the
    returned dict, which is handed to the child process.
    """
    env = dict(base if base is not None else os.environ)
    env.update(tenant_env_all())
    return env
