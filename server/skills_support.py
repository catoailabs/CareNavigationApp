from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_SKILL_SCAN_ROOTS: tuple[Path, ...] = (
    REPO_ROOT / ".agents" / "skills",
    REPO_ROOT / ".kilo",
    REPO_ROOT / "tools",
)

SKILL_FILE_NAME = "SKILL.md"


def _discover_skill_directories() -> list[Path]:
    """Yield directories that contain a SKILL.md file."""
    found: list[Path] = []
    seen: set[Path] = set()

    for root in DEFAULT_SKILL_SCAN_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob(SKILL_FILE_NAME):
            directory = path.parent
            resolved = directory.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            found.append(directory)

    return found


def _load_skill(directory: Path) -> dict[str, Any] | None:
    """Parse a single SKILL.md directory using strands Skill parser."""
    try:
        from strands.vended_plugins.skills import Skill
    except Exception as exc:  # pragma: no cover
        LOGGER.debug("strands Skill parser unavailable: %s", exc)
        return None

    try:
        skill = Skill.from_file(directory, strict=False)
    except Exception as exc:
        LOGGER.debug("Failed to parse skill at %s: %s", directory, exc)
        return None

    return {
        "name": getattr(skill, "name", directory.name),
        "description": getattr(skill, "description", "") or "",
        "path": str(directory.resolve()),
        "allowed_tools": list(getattr(skill, "allowed_tools", None) or []),
        "compatibility": getattr(skill, "compatibility", None) or {},
    }


def discover_skills() -> list[dict[str, Any]]:
    """Scan configured directories for SKILL.md files and return summaries."""
    skills: list[dict[str, Any]] = []
    for directory in _discover_skill_directories():
        record = _load_skill(directory)
        if record is not None:
            skills.append(record)
    return sorted(skills, key=lambda item: str(item.get("name", "")).lower())


def build_skills_catalog() -> dict[str, Any]:
    """Return a catalog-shaped summary of discovered skills."""
    skills = discover_skills()
    return {
        "schema_version": 1,
        "count": len(skills),
        "skills": skills,
    }
