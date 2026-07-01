"""Container-scoped filesystem primitives for the agent virtual desktop.

The agent's ``shell`` tool executes every command **inside** the
``ron-agent-desktop`` webtop container via ``docker exec`` (see
``shell.py::CommandExecutor.execute_with_pty``). Any tool that manipulates
files (``editor``, and eventually ``file_read`` / ``file_write`` /
``python_repl``) MUST operate on that *same* filesystem — otherwise a file
created by ``editor`` on the agent host is invisible to ``shell`` running in
the container, and the two tools silently disagree about the state of the
world.

This module provides thin filesystem primitives that run inside the virtual
desktop container. It mirrors the per-tenant environment forwarding the shell
tool uses: secret *names* are forwarded on the ``docker exec`` argv via
``-e NAME`` while their values travel through the docker client's own
environment, and the parent ``os.environ`` is never mutated so concurrently
served tenants stay isolated.

All file contents cross the boundary base64-encoded so binary-safe and
newline-safe round-trips work regardless of shell quoting.
"""

from __future__ import annotations

import base64
import json
import os
import shlex
import subprocess
from typing import Any, Dict, List, Optional, Tuple

# Execution-boundary env injection, matching shell.py. The tenant overlay lives
# in this app's server module; guard the import so the tool still works when
# imported standalone (without ``server`` on the path), degrading to a no-op.
try:
    from server.tenant_environment import (  # type: ignore[import-not-found]
        child_process_env as _child_process_env,
        tenant_env_all as _tenant_env_all,
    )

    _TENANT_ENV_AVAILABLE = True
except Exception:  # pragma: no cover - standalone import without server on path
    _child_process_env = None  # type: ignore[assignment]
    _tenant_env_all = None  # type: ignore[assignment]
    _TENANT_ENV_AVAILABLE = False


# Container the agent's virtual desktop runs in. Kept in sync with
# shell.py ("ron-agent-desktop") and desktop_browser.py (AGENT_DESKTOP_CONTAINER).
CONTAINER_NAME = os.getenv("AGENT_DESKTOP_CONTAINER", "ron-agent-desktop")


class ContainerFsError(RuntimeError):
    """Raised when a filesystem operation inside the virtual desktop fails."""


def _docker_exec(
    args: List[str],
    input_bytes: Optional[bytes] = None,
    workdir: Optional[str] = None,
) -> subprocess.CompletedProcess:
    """Run ``docker exec -i [-e NAME ...] [-w cwd] <container> <args>`` with the tenant env overlay.

    The child environment is built in the parent (where the tenant overlay
    contextvar is bound); only secret *names* appear on the argv.
    """
    tenant_vars = _tenant_env_all() if (_TENANT_ENV_AVAILABLE and _tenant_env_all) else {}
    child_env = (
        _child_process_env()
        if (_TENANT_ENV_AVAILABLE and _child_process_env)
        else dict(os.environ)
    )
    env_flags: List[str] = []
    for _tenant_name in sorted(tenant_vars):
        env_flags.extend(["-e", _tenant_name])

    wd_flags: List[str] = ["-w", workdir] if workdir else []
    cmd = ["docker", "exec", "-i", *env_flags, *wd_flags, CONTAINER_NAME, *args]
    try:
        return subprocess.run(cmd, input=input_bytes, capture_output=True, env=child_env)
    except FileNotFoundError as exc:  # docker CLI missing on the agent host
        raise ContainerFsError(
            "docker CLI not found - the agent cannot reach its virtual desktop "
            f"container '{CONTAINER_NAME}'."
        ) from exc


def _sh(script: str, input_bytes: Optional[bytes] = None) -> subprocess.CompletedProcess:
    """Run a ``/bin/sh -c`` script inside the virtual desktop container."""
    return _docker_exec(["/bin/sh", "-c", script], input_bytes=input_bytes)


def _stderr(proc: subprocess.CompletedProcess) -> str:
    return (proc.stderr or b"").decode("utf-8", "replace").strip()


# --- Predicates ------------------------------------------------------------


def exists(path: str) -> bool:
    return _sh(f"test -e {shlex.quote(path)}").returncode == 0


def is_file(path: str) -> bool:
    return _sh(f"test -f {shlex.quote(path)}").returncode == 0


def is_dir(path: str) -> bool:
    return _sh(f"test -d {shlex.quote(path)}").returncode == 0


# --- Reads / writes --------------------------------------------------------


def read_text(path: str) -> str:
    """Return the UTF-8 text contents of ``path`` inside the container."""
    proc = _sh(f"base64 {shlex.quote(path)}")
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot read {path} in virtual desktop")
    return base64.b64decode(proc.stdout).decode("utf-8")


def read_bytes(path: str) -> bytes:
    """Return the raw bytes of ``path`` inside the container (binary-safe)."""
    proc = _sh(f"base64 {shlex.quote(path)}")
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot read {path} in virtual desktop")
    return base64.b64decode(proc.stdout)


def write_text(path: str, content: str) -> None:
    """Write ``content`` to ``path`` inside the container (truncating)."""
    payload = base64.b64encode(content.encode("utf-8"))
    proc = _sh(f"base64 -d > {shlex.quote(path)}", input_bytes=payload)
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot write {path} in virtual desktop")


def write_bytes(path: str, content: bytes) -> None:
    """Write raw ``content`` bytes to ``path`` inside the container (binary-safe)."""
    payload = base64.b64encode(content)
    proc = _sh(f"base64 -d > {shlex.quote(path)}", input_bytes=payload)
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot write {path} in virtual desktop")


def append_text(path: str, content: str) -> None:
    """Append ``content`` to ``path`` inside the container (creating it if absent)."""
    payload = base64.b64encode(content.encode("utf-8"))
    proc = _sh(f"base64 -d >> {shlex.quote(path)}", input_bytes=payload)
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot append to {path} in virtual desktop")


def getsize(path: str) -> int:
    """Return the size of ``path`` in bytes inside the container."""
    proc = _sh(f"wc -c < {shlex.quote(path)}")
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot stat {path} in virtual desktop")
    return int(proc.stdout.decode("utf-8", "replace").strip() or "0")



# --- Directory / file management ------------------------------------------


def makedirs(path: str) -> None:
    """``mkdir -p`` inside the container. No-op for an empty path."""
    if not path:
        return
    proc = _sh(f"mkdir -p {shlex.quote(path)}")
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot create {path} in virtual desktop")


def copy_file(src: str, dst: str) -> None:
    """``cp -p`` inside the container (used for .bak backups / undo)."""
    proc = _sh(f"cp -p {shlex.quote(src)} {shlex.quote(dst)}")
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot copy {src} -> {dst} in virtual desktop")


def remove(path: str) -> None:
    """``rm -f`` inside the container."""
    proc = _sh(f"rm -f {shlex.quote(path)}")
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot remove {path} in virtual desktop")


def list_entries(path: str) -> List[Tuple[str, bool]]:
    """List directory entries as ``(name, is_dir)`` in a single exec.

    Uses ``ls -1Ap`` so directories carry a trailing slash; hidden ``.``/``..``
    are excluded by ``-A``.
    """
    proc = _sh(f"ls -1Ap {shlex.quote(path)}")
    if proc.returncode != 0:
        raise ContainerFsError(_stderr(proc) or f"cannot list {path} in virtual desktop")
    entries: List[Tuple[str, bool]] = []
    for raw in proc.stdout.decode("utf-8", "replace").splitlines():
        name = raw.rstrip("\n")
        if not name:
            continue
        if name.endswith("/"):
            entries.append((name[:-1], True))
        else:
            entries.append((name, False))
    return entries


# --- Process execution -----------------------------------------------------


def run(
    args: List[str],
    cwd: Optional[str] = None,
    input_bytes: Optional[bytes] = None,
) -> Tuple[int, str, str]:
    """Run an arbitrary argv inside the virtual desktop container.

    Mirrors the ``shell`` tool's execution boundary (``docker exec`` with the
    tenant env overlay) for tools that shell out to ``node`` / ``git`` / ``diff``
    etc. Returns ``(returncode, stdout, stderr)`` as decoded text.
    """
    proc = _docker_exec(args, input_bytes=input_bytes, workdir=cwd)
    out = (proc.stdout or b"").decode("utf-8", "replace")
    err = (proc.stderr or b"").decode("utf-8", "replace")
    return proc.returncode, out, err


def run_python(script: str, args: Optional[List[str]] = None, cwd: Optional[str] = None) -> Tuple[int, str, str]:
    """Run a Python 3 ``script`` inside the container, returning ``(rc, stdout, stderr)``.

    The script is fed on stdin (``python3 -``) so arbitrary source crosses the
    boundary without shell quoting hazards. ``args`` become ``sys.argv[1:]``.
    """
    argv = ["python3", "-", *(args or [])]
    return run(argv, cwd=cwd, input_bytes=script.encode("utf-8"))


def _json_python(script: str, args: Optional[List[str]] = None) -> Any:
    """Run a Python driver in the container whose stdout is a single JSON doc."""
    rc, out, err = run_python(script, args=args)
    if rc != 0:
        raise ContainerFsError(err.strip() or "python helper failed in virtual desktop")
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise ContainerFsError(f"malformed helper output from virtual desktop: {out[:200]!r}") from exc


def glob(pattern: str, recursive: bool = True) -> List[str]:
    """``glob.glob`` evaluated inside the container. Returns sorted matches."""
    script = (
        "import glob, json, sys\n"
        "print(json.dumps(sorted(glob.glob(sys.argv[1], recursive=(sys.argv[2] == '1')))))\n"
    )
    result = _json_python(script, args=[pattern, "1" if recursive else "0"])
    return list(result)


def find_files(pattern: str, recursive: bool = True) -> List[str]:
    """Resolve ``pattern`` to a sorted file list inside the container.

    Mirrors file_read's host ``find_files``: a direct file returns itself, a
    directory is walked (respecting ``recursive`` and skipping dotfiles), and
    anything else is treated as a glob.
    """
    script = r"""
import glob, json, os, sys
pattern = sys.argv[1]
recursive = sys.argv[2] == '1'
out = []
if os.path.exists(pattern):
    if os.path.isfile(pattern):
        out = [pattern]
    elif os.path.isdir(pattern):
        matches = []
        for root, _dirs, files in os.walk(pattern):
            if not recursive and root != pattern:
                continue
            for f in sorted(files):
                if not f.startswith('.'):
                    matches.append(os.path.join(root, f))
        out = sorted(matches)
else:
    p = pattern
    if recursive and '**' not in p:
        base = os.path.dirname(p)
        fp = os.path.basename(p)
        p = os.path.join(base if base else '.', '**', fp)
    out = sorted(glob.glob(p, recursive=recursive))
print(json.dumps(out))
"""
    result = _json_python(script, args=[pattern, "1" if recursive else "0"])
    return list(result)


def stat(path: str) -> Dict[str, Any]:
    """Return ``os.stat`` fields for ``path`` inside the container as a dict."""
    script = (
        "import json, os, sys\n"
        "s = os.stat(sys.argv[1])\n"
        "print(json.dumps({'st_size': s.st_size, 'st_ctime': s.st_ctime, "
        "'st_mtime': s.st_mtime, 'st_atime': s.st_atime, 'st_uid': s.st_uid, "
        "'st_mode': s.st_mode}))\n"
    )
    return dict(_json_python(script, args=[path]))

