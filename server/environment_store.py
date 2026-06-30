from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
ENVIRONMENT_STORE_PATH = DATA_DIR / "agent_environment.json"

ENV_VAR_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")

PROTECTED_VARS = {
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "PYTHONPATH",
    "STRANDS_HOME",
    "BYPASS_TOOL_CONSENT",
}

_STORE_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _empty_store() -> dict[str, Any]:
    return {"schema_version": 1, "variables": []}


def load_environment_store() -> dict[str, Any]:
    """Load the persisted environment store from disk.

    Returns the parsed JSON object. If the file does not exist or is invalid,
    an empty store is returned.
    """
    if not ENVIRONMENT_STORE_PATH.exists():
        return _empty_store()
    try:
        payload = json.loads(ENVIRONMENT_STORE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _empty_store()

    if not isinstance(payload, dict):
        return _empty_store()

    variables = payload.get("variables", [])
    if not isinstance(variables, list):
        variables = []

    normalized: list[dict[str, Any]] = []
    for item in variables:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        if not name or is_protected_name(name):
            continue
        normalized.append(
            {
                "name": name,
                "value": str(item.get("value", "")),
                "createdAt": str(item.get("createdAt", _now_iso())),
                "updatedAt": str(item.get("updatedAt", _now_iso())),
            }
        )

    return {"schema_version": int(payload.get("schema_version", 1)), "variables": normalized}


def save_environment_store(store: dict[str, Any]) -> None:
    """Atomically write the environment store to disk."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = ENVIRONMENT_STORE_PATH.with_suffix(".tmp")
    with _STORE_LOCK:
        temp_path.write_text(json.dumps(store, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temp_path.replace(ENVIRONMENT_STORE_PATH)


def get_environment_variables() -> dict[str, str]:
    """Return a mapping of persisted environment variable names to values."""
    store = load_environment_store()
    return {
        str(item["name"]): str(item["value"])
        for item in store.get("variables", [])
        if isinstance(item, dict) and "name" in item
    }


def is_protected_name(name: str) -> bool:
    """Return True if the variable name is protected and cannot be modified."""
    return name.strip() in PROTECTED_VARS


def _validate_name(name: str) -> None:
    clean = name.strip()
    if not clean:
        raise ValueError("name is required")
    if is_protected_name(clean):
        raise ValueError(f"Cannot modify protected variable: {clean}")
    if not ENV_VAR_NAME_RE.match(clean):
        raise ValueError(
            f"Invalid variable name: {clean}. Names must match ^[A-Z_][A-Z0-9_]*$"
        )


def set_environment_variable(name: str, value: str) -> None:
    """Persist an environment variable and apply it to ``os.environ``."""
    _validate_name(name)
    if value is None:
        raise ValueError("value is required")

    clean_name = name.strip()
    clean_value = str(value)
    now = _now_iso()

    store = load_environment_store()
    variables: list[dict[str, Any]] = list(store.get("variables", []))

    existing = next(
        (item for item in variables if str(item.get("name", "")).strip() == clean_name),
        None,
    )
    if existing is not None:
        existing["value"] = clean_value
        existing["updatedAt"] = now
    else:
        variables.append(
            {
                "name": clean_name,
                "value": clean_value,
                "createdAt": now,
                "updatedAt": now,
            }
        )

    store["variables"] = variables
    save_environment_store(store)
    os.environ[clean_name] = clean_value


def delete_environment_variable(name: str) -> None:
    """Remove a persisted environment variable from disk and ``os.environ``."""
    clean = name.strip()
    if not clean:
        raise ValueError("name is required")
    if is_protected_name(clean):
        raise ValueError(f"Cannot delete protected variable: {clean}")

    store = load_environment_store()
    variables: list[dict[str, Any]] = list(store.get("variables", []))
    store["variables"] = [item for item in variables if str(item.get("name", "")).strip() != clean]
    save_environment_store(store)
    os.environ.pop(clean, None)


def apply_persisted_environment() -> None:
    """Load persisted variables and apply them to ``os.environ``.

    Existing process environment values take precedence so that command-line
    overrides are respected.
    """
    for name, value in get_environment_variables().items():
        if name not in os.environ:
            os.environ[name] = value
