from __future__ import annotations

import ast
import importlib.util
import inspect
import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_ROOT = REPO_ROOT / "tools"
OPENAPI_ROOT = TOOLS_ROOT / "open-api-specs"
MCP_ROOT = TOOLS_ROOT / "mcp"
RONBROWSER_STRANDS_ROOT = TOOLS_ROOT / "ronbrowser_agent_tools" / "src" / "strands_tools"
TOOLSET_STORE_PATH = TOOLS_ROOT / ".tool_catalog_toolsets.json"

from server.agent_tooling import BASELINE_TOOL_REGISTRY

BASELINE_TOOL_NAMES = frozenset(BASELINE_TOOL_REGISTRY)
PROTECTED_TOOL_NAMES = BASELINE_TOOL_NAMES
EXCLUDED_TOOL_ROOTS = {"__pycache__", "mcp", "ronbrowser_agent_tools"}
OPENAPI_EXTENSIONS = {".json", ".yaml", ".yml"}
MCP_MARKER_FILES = {
    "Dockerfile",
    "manifest.json",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "server.py",
    "smithery.yaml",
}
MAX_TOOLSET_SIZE = 10
TOOLSET_SCHEMA_VERSION = 1


@dataclass(slots=True)
class CatalogEntry:
    name: str
    description: str
    input_schema: dict[str, Any]
    input_summary: dict[str, str]
    origin: str
    category: str
    kind: str
    path: str | None = None
    module_path: str | None = None
    load_spec: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
            "input_summary": self.input_summary,
            "origin": self.origin,
            "category": self.category,
            "kind": self.kind,
            "path": self.path,
            "module_path": self.module_path,
            "load_pathway": f"load_catalog_tool(name={json.dumps(self.name)})"
            if self.kind == "tool"
            else None,
            "execute_pathway": (
                f"execute_catalog_tool(name={json.dumps(self.name)}, arguments={{...}})"
                if self.kind == "tool"
                else None
            ),
            "unload_pathway": f"unload_catalog_tool(name={json.dumps(self.name)})"
            if self.kind == "tool"
            else None,
        }


def _first_line(text: str | None) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()
    return ""


def _normalize_identifier(value: str | None, *, default: str = "misc") -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower()).strip("_")
    return normalized or default


def _category_label(category_id: str) -> str:
    return category_id.replace("_", " ").title()


def _inventory_relative_path(path: Path) -> Path:
    resolved_path = path.resolve()
    resolved_ronbrowser_root = RONBROWSER_STRANDS_ROOT.resolve()
    if resolved_path.is_relative_to(resolved_ronbrowser_root):
        return resolved_path.relative_to(resolved_ronbrowser_root)
    return resolved_path.relative_to(TOOLS_ROOT.resolve())


def _category_for_repo_path(path: Path) -> str:
    relative_path = _inventory_relative_path(path)
    if len(relative_path.parts) == 1:
        return "root"
    return _normalize_identifier(relative_path.parts[0])


def _module_path_for_file(path: Path) -> str | None:
    try:
        relative = path.resolve().relative_to(REPO_ROOT.resolve()).with_suffix("")
    except ValueError:
        return None
    return ".".join(relative.parts)


def _tool_method_name(name: str) -> str:
    return name.replace("-", "_")


def _tool_registry_names(name: str) -> list[str]:
    method_name = _tool_method_name(name)
    return [name] if method_name == name else [name, method_name]


def _input_summary(schema: dict[str, Any]) -> dict[str, str]:
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return {}
    summary: dict[str, str] = {}
    for key, value in properties.items():
        if isinstance(value, dict):
            raw_type = value.get("type", "any")
            if isinstance(raw_type, list):
                summary[key] = " | ".join(str(item) for item in raw_type)
            else:
                summary[key] = str(raw_type)
        else:
            summary[key] = "any"
    return summary


def _extract_runtime_path(tool_obj: Any) -> str | None:
    candidates: list[str | None] = []
    for target in (tool_obj, getattr(tool_obj, "__call__", None)):
        if target is None:
            continue
        try:
            candidates.append(inspect.getsourcefile(target))
        except Exception:
            continue
    try:
        module = inspect.getmodule(tool_obj)
        if module is not None:
            candidates.append(getattr(module, "__file__", None))
    except Exception:
        pass
    for candidate in candidates:
        if candidate:
            return str(Path(candidate).resolve())
    return None


def _extract_runtime_module_path(tool_obj: Any) -> str | None:
    tool_spec = getattr(tool_obj, "tool_spec", None)
    if isinstance(tool_spec, dict):
        module_path = tool_spec.get("module_path")
        if isinstance(module_path, str) and module_path.strip():
            return module_path.strip()
    module = inspect.getmodule(tool_obj)
    if module is None:
        return None
    module_name = getattr(module, "__name__", None)
    return module_name.strip() if isinstance(module_name, str) and module_name.strip() else None


def _extract_runtime_input_schema(tool_obj: Any) -> dict[str, Any]:
    for attr_name in ("tool_spec", "TOOL_SPEC"):
        tool_spec = getattr(tool_obj, attr_name, None)
        if not isinstance(tool_spec, dict):
            continue
        schema = tool_spec.get("inputSchema") or tool_spec.get("input_schema") or {}
        if isinstance(schema, dict) and isinstance(schema.get("json"), dict):
            return dict(schema["json"])
        if isinstance(schema, dict):
            return dict(schema)
    return {}


def _extract_runtime_description(tool_obj: Any) -> str:
    for attr_name in ("tool_spec", "TOOL_SPEC"):
        tool_spec = getattr(tool_obj, attr_name, None)
        if not isinstance(tool_spec, dict):
            continue
        description = tool_spec.get("description")
        if isinstance(description, str) and description.strip():
            return _first_line(description)
    doc = inspect.getdoc(tool_obj)
    if not doc and callable(tool_obj):
        doc = inspect.getdoc(tool_obj.__call__)
    return _first_line(doc)


def _safe_eval_ast(node: ast.AST) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Dict):
        return {
            _safe_eval_ast(key): _safe_eval_ast(value)
            for key, value in zip(node.keys, node.values, strict=False)
        }
    if isinstance(node, ast.List):
        return [_safe_eval_ast(item) for item in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_safe_eval_ast(item) for item in node.elts)
    if isinstance(node, ast.Set):
        return {_safe_eval_ast(item) for item in node.elts}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        value = _safe_eval_ast(node.operand)
        if isinstance(value, (int, float)):
            return -value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _safe_eval_ast(node.left)
        right = _safe_eval_ast(node.right)
        if isinstance(left, str) and isinstance(right, str):
            return left + right
        if isinstance(left, list) and isinstance(right, list):
            return left + right
    raise ValueError(f"Unsupported AST literal: {node.__class__.__name__}")


def _tool_spec_from_ast(tree: ast.Module) -> dict[str, Any] | None:
    for node in tree.body:
        value_node: ast.AST | None = None
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "TOOL_SPEC":
                    value_node = node.value
                    break
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "TOOL_SPEC":
            value_node = node.value
        if value_node is None:
            continue
        try:
            payload = _safe_eval_ast(value_node)
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None
    return None


def _tool_decorator_aliases(tree: ast.Module) -> set[str]:
    names = {"tool"}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or node.module != "strands":
            continue
        for alias in node.names:
            if alias.name == "tool":
                names.add(alias.asname or alias.name)
    return names


def _decorator_name(decorator: ast.expr) -> str | None:
    target = decorator.func if isinstance(decorator, ast.Call) else decorator
    if isinstance(target, ast.Name):
        return target.id
    if isinstance(target, ast.Attribute):
        return target.attr
    return None


def _decorated_tool_entries(path: Path, tree: ast.Module) -> list[CatalogEntry]:
    decorator_aliases = _tool_decorator_aliases(tree)
    module_path = _module_path_for_file(path)
    category = _category_for_repo_path(path)
    entries: list[CatalogEntry] = []
    seen: set[str] = set()

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        name_override: str | None = None
        description_override: str | None = None
        for decorator in node.decorator_list:
            if _decorator_name(decorator) not in decorator_aliases:
                continue
            if isinstance(decorator, ast.Call):
                for keyword in decorator.keywords:
                    try:
                        value = _safe_eval_ast(keyword.value)
                    except Exception:
                        continue
                    if keyword.arg == "name" and isinstance(value, str) and value.strip():
                        name_override = value.strip()
                    elif keyword.arg == "description" and isinstance(value, str) and value.strip():
                        description_override = _first_line(value)
            break
        else:
            continue

        tool_name = name_override or node.name
        if tool_name in seen:
            continue
        seen.add(tool_name)
        load_spec = f"{module_path}:{tool_name}" if module_path else str(path.resolve())
        description = description_override or _first_line(ast.get_docstring(node))
        entries.append(
            CatalogEntry(
                name=tool_name,
                description=description,
                input_schema={},
                input_summary={},
                origin="catalog",
                category=category,
                kind="tool",
                path=str(path.resolve()),
                module_path=module_path,
                load_spec=load_spec,
            )
        )
    return entries


def _module_tool_entry(path: Path, tree: ast.Module) -> CatalogEntry | None:
    tool_spec = _tool_spec_from_ast(tree)
    if not isinstance(tool_spec, dict):
        return None
    tool_name = str(tool_spec.get("name") or path.stem).strip()
    if not tool_name:
        return None
    module_path = _module_path_for_file(path)
    raw_schema = tool_spec.get("inputSchema") or tool_spec.get("input_schema") or {}
    input_schema = dict(raw_schema.get("json", raw_schema)) if isinstance(raw_schema, dict) else {}
    return CatalogEntry(
        name=tool_name,
        description=_first_line(str(tool_spec.get("description") or "")),
        input_schema=input_schema,
        input_summary=_input_summary(input_schema),
        origin="catalog",
        category=_category_for_repo_path(path),
        kind="tool",
        path=str(path.resolve()),
        module_path=module_path,
        load_spec=module_path or str(path.resolve()),
    )


def _iter_python_tool_files(root: Path, *, apply_root_exclusions: bool) -> list[Path]:
    files: list[Path] = []
    resolved_tools_root = TOOLS_ROOT.resolve()
    for path in root.rglob("*.py"):
        if path.name == "__init__.py":
            continue
        if apply_root_exclusions:
            relative = path.resolve().relative_to(resolved_tools_root)
            if relative.parts and relative.parts[0] in EXCLUDED_TOOL_ROOTS:
                continue
        files.append(path)
    return files


def _scan_python_tool_entries() -> dict[str, CatalogEntry]:
    entries: dict[str, CatalogEntry] = {}
    scan_roots = (
        (TOOLS_ROOT, True),
        (RONBROWSER_STRANDS_ROOT, False),
    )
    for root, apply_root_exclusions in scan_roots:
        if not root.exists():
            continue
        for path in _iter_python_tool_files(root, apply_root_exclusions=apply_root_exclusions):
            try:
                tree = ast.parse(path.read_text(encoding="utf-8", errors="ignore"), filename=str(path))
            except Exception as exc:
                LOGGER.debug("Skipping tool scan for %s: %s", path, exc)
                continue
            module_entry = _module_tool_entry(path, tree)
            if module_entry is not None:
                entries.setdefault(module_entry.name, module_entry)
            for entry in _decorated_tool_entries(path, tree):
                entries.setdefault(entry.name, entry)
    return entries


def _scan_mcp_entries() -> dict[str, CatalogEntry]:
    entries: dict[str, CatalogEntry] = {}
    if not MCP_ROOT.exists():
        return entries
    for child in sorted(MCP_ROOT.iterdir(), key=lambda item: item.name.lower()):
        if not child.is_dir():
            continue
        if not any((child / marker).exists() for marker in MCP_MARKER_FILES):
            continue
        readme = child / "README.md"
        description = _first_line(readme.read_text(encoding="utf-8", errors="ignore")) if readme.exists() else ""
        entry = CatalogEntry(
            name=child.name,
            description=description,
            input_schema={},
            input_summary={},
            origin="catalog",
            category="mcp",
            kind="mcp_server",
            path=str(child.resolve()),
        )
        entries[entry.name] = entry
    return entries


def _scan_openapi_entries() -> dict[str, CatalogEntry]:
    entries: dict[str, CatalogEntry] = {}
    if not OPENAPI_ROOT.exists():
        return entries
    for path in OPENAPI_ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in OPENAPI_EXTENSIONS:
            continue
        # Preserve the inventory path under OPENAPI_ROOT instead of the resolved target path.
        # This keeps symlinked specs catalogable even when they point outside the repo.
        try:
            relative = path.relative_to(OPENAPI_ROOT).with_suffix("")
        except ValueError:
            LOGGER.debug("Skipping OpenAPI path outside inventory root: %s", path)
            continue
        category = _normalize_identifier(relative.parts[0] if len(relative.parts) > 1 else "open_api_specs")
        entry = CatalogEntry(
            name=relative.as_posix(),
            description="",
            input_schema={},
            input_summary={},
            origin="catalog",
            category=category,
            kind="openapi_spec",
            path=str(path.resolve()),
        )
        entries[entry.name] = entry
    return entries


def _scan_runtime_entries(agent: Any) -> dict[str, CatalogEntry]:
    registry = getattr(agent, "tool_registry", None)
    if registry is None:
        return {}

    entries: dict[str, CatalogEntry] = {}
    for tool_name, tool_obj in getattr(registry, "registry", {}).items():
        path = _extract_runtime_path(tool_obj)
        category = "loaded"
        if tool_name in BASELINE_TOOL_NAMES:
            category = "baseline"
        elif path:
            path_obj = Path(path)
            try:
                if path_obj.resolve().is_relative_to(TOOLS_ROOT.resolve()):
                    category = _category_for_repo_path(path_obj)
            except Exception:
                pass

        input_schema = _extract_runtime_input_schema(tool_obj)
        entries[tool_name] = CatalogEntry(
            name=tool_name,
            description=_extract_runtime_description(tool_obj),
            input_schema=input_schema,
            input_summary=_input_summary(input_schema),
            origin="runtime" if tool_name not in BASELINE_TOOL_NAMES else "baseline",
            category=category,
            kind="tool",
            path=path,
            module_path=_extract_runtime_module_path(tool_obj),
        )
    return entries


def _catalog_indices(
    agent: Any,
) -> tuple[dict[str, CatalogEntry], dict[str, CatalogEntry], dict[str, CatalogEntry]]:
    tool_entries = _scan_python_tool_entries()
    tool_entries.update(_scan_runtime_entries(agent))
    return tool_entries, _scan_mcp_entries(), _scan_openapi_entries()


def build_catalog_overview(agent: Any) -> dict[str, Any]:
    tool_entries, mcp_entries, openapi_entries = _catalog_indices(agent)
    categories: dict[str, dict[str, Any]] = {}

    def ensure_bucket(category_id: str) -> dict[str, Any]:
        category_id = _normalize_identifier(category_id)
        bucket = categories.get(category_id)
        if bucket is None:
            bucket = {
                "id": category_id,
                "label": _category_label(category_id),
                "tools": [],
                "mcp_servers": [],
                "openapi_specs": [],
            }
            categories[category_id] = bucket
        return bucket

    for entry in sorted(tool_entries.values(), key=lambda item: item.name.lower()):
        ensure_bucket(entry.category)["tools"].append(entry.to_dict())
    for entry in sorted(mcp_entries.values(), key=lambda item: item.name.lower()):
        ensure_bucket(entry.category)["mcp_servers"].append(entry.to_dict())
    for entry in sorted(openapi_entries.values(), key=lambda item: item.name.lower()):
        ensure_bucket(entry.category)["openapi_specs"].append(entry.to_dict())

    def sort_key(item: dict[str, Any]) -> tuple[int, str]:
        category_id = item["id"]
        if category_id == "baseline":
            return (0, category_id)
        if category_id == "loaded":
            return (1, category_id)
        return (2, category_id)

    ordered_categories: list[dict[str, Any]] = []
    for bucket in sorted(categories.values(), key=sort_key):
        tool_count = len(bucket["tools"])
        mcp_count = len(bucket["mcp_servers"])
        spec_count = len(bucket["openapi_specs"])
        bucket["count"] = {
            "tools": tool_count,
            "mcp_servers": mcp_count,
            "openapi_specs": spec_count,
            "total": tool_count + mcp_count + spec_count,
        }
        ordered_categories.append(bucket)

    return {
        "schema_version": 1,
        "inventory_root": str(TOOLS_ROOT.resolve()),
        "categories": ordered_categories,
        "count": {
            "categories": len(ordered_categories),
            "tools": sum(category["count"]["tools"] for category in ordered_categories),
            "mcp_servers": sum(category["count"]["mcp_servers"] for category in ordered_categories),
            "openapi_specs": sum(category["count"]["openapi_specs"] for category in ordered_categories),
        },
    }


def get_tool_details(agent: Any, name: str) -> dict[str, Any] | None:
    tool_entries, mcp_entries, openapi_entries = _catalog_indices(agent)
    for entries in (tool_entries, mcp_entries, openapi_entries):
        entry = entries.get(name)
        if entry is not None:
            return entry.to_dict()
    return None


def _tool_entry(agent: Any, name: str) -> CatalogEntry | None:
    tool_entries, _, _ = _catalog_indices(agent)
    return tool_entries.get(name)


def get_tools_by_category(agent: Any, category_id: str) -> list[CatalogEntry]:
    normalized = _normalize_identifier(category_id)
    tool_entries, _, _ = _catalog_indices(agent)
    return sorted(
        [entry for entry in tool_entries.values() if entry.category == normalized],
        key=lambda item: item.name.lower(),
    )


def _empty_toolset_store() -> dict[str, Any]:
    return {"schema_version": TOOLSET_SCHEMA_VERSION, "toolsets": {}}


def _read_toolset_store() -> dict[str, Any]:
    if not TOOLSET_STORE_PATH.exists():
        return _empty_toolset_store()
    payload = json.loads(TOOLSET_STORE_PATH.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"Toolset store at {TOOLSET_STORE_PATH} must contain a JSON object")
    toolsets = payload.get("toolsets", {})
    if not isinstance(toolsets, dict):
        raise RuntimeError(f"Toolset store at {TOOLSET_STORE_PATH} has an invalid 'toolsets' section")
    normalized: dict[str, dict[str, Any]] = {}
    for raw_name, raw_value in toolsets.items():
        if not isinstance(raw_name, str) or not isinstance(raw_value, dict):
            continue
        normalized[raw_name.strip()] = {
            "description": str(raw_value.get("description", "")).strip(),
            "tool_names": [
                str(item).strip()
                for item in raw_value.get("tool_names", [])
                if str(item).strip()
            ],
        }
    return {
        "schema_version": int(payload.get("schema_version", TOOLSET_SCHEMA_VERSION)),
        "toolsets": normalized,
    }


def _write_toolset_store(store: dict[str, Any]) -> None:
    TOOLSET_STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = TOOLSET_STORE_PATH.with_suffix(".tmp")
    temp_path.write_text(json.dumps(store, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp_path.replace(TOOLSET_STORE_PATH)


def _normalize_toolset_name(name: str | None) -> str:
    normalized = (name or "").strip()
    if not normalized:
        raise ValueError("name is required")
    return normalized


def _normalize_tool_names(tool_names: list[str] | None) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for item in tool_names or []:
        tool_name = str(item).strip()
        if not tool_name or tool_name in seen:
            continue
        seen.add(tool_name)
        normalized.append(tool_name)
    return normalized


def _resolve_tool_names(
    agent: Any, tool_names: list[str]
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    resolved: list[dict[str, Any]] = []
    missing: list[str] = []
    invalid: list[str] = []
    for tool_name in tool_names:
        details = get_tool_details(agent, tool_name)
        if details is None:
            missing.append(tool_name)
            continue
        if details.get("kind") != "tool":
            invalid.append(tool_name)
            continue
        resolved.append(details)
    return resolved, missing, invalid


def _validated_tool_names(agent: Any, tool_names: list[str] | None) -> list[str]:
    normalized = _normalize_tool_names(tool_names)
    if not normalized:
        raise ValueError("tool_names must include at least one cataloged tool")
    if len(normalized) > MAX_TOOLSET_SIZE:
        raise ValueError(f"toolsets support at most {MAX_TOOLSET_SIZE} tools")
    _, missing, invalid = _resolve_tool_names(agent, normalized)
    if missing:
        raise ValueError(f"unknown tools: {', '.join(missing)}")
    if invalid:
        raise ValueError(f"only tools can be added to a toolset: {', '.join(invalid)}")
    return normalized


def _toolset_record(agent: Any, name: str, definition: dict[str, Any]) -> dict[str, Any]:
    tool_names = _normalize_tool_names(definition.get("tool_names", []))
    resolved_tools, missing_tools, invalid_members = _resolve_tool_names(agent, tool_names)
    return {
        "name": name,
        "description": definition.get("description", ""),
        "tool_names": tool_names,
        "tool_count": len(tool_names),
        "tools": resolved_tools,
        "missing_tools": missing_tools,
        "invalid_members": invalid_members,
        "kind": "toolset",
        "origin": "persistent",
        "path": str(TOOLSET_STORE_PATH.resolve()),
        "load_pathway": f"load_toolset(name={json.dumps(name)})",
        "unload_pathway": f"unload_toolset(name={json.dumps(name)})",
        "update_pathway": (
            f"update_toolset(name={json.dumps(name)}, tool_names=[...], description='...')"
        ),
        "delete_pathway": f"delete_toolset(name={json.dumps(name)})",
    }


def list_toolset_records(agent: Any) -> list[dict[str, Any]]:
    store = _read_toolset_store()
    return [_toolset_record(agent, name, store["toolsets"][name]) for name in sorted(store["toolsets"])]


def get_toolset_record(agent: Any, name: str) -> dict[str, Any] | None:
    normalized_name = _normalize_toolset_name(name)
    definition = _read_toolset_store()["toolsets"].get(normalized_name)
    if definition is None:
        return None
    return _toolset_record(agent, normalized_name, definition)


def save_toolset(
    agent: Any,
    *,
    name: str | None,
    description: str | None,
    tool_names: list[str] | None,
    require_existing: bool,
) -> dict[str, Any]:
    normalized_name = _normalize_toolset_name(name)
    normalized_tool_names = _validated_tool_names(agent, tool_names)
    store = _read_toolset_store()
    exists = normalized_name in store["toolsets"]
    if require_existing and not exists:
        raise ValueError(f"toolset not found: {normalized_name}")
    if not require_existing and exists:
        raise ValueError(f"toolset already exists: {normalized_name}")
    store["toolsets"][normalized_name] = {
        "description": (description or "").strip(),
        "tool_names": normalized_tool_names,
    }
    _write_toolset_store(store)
    return _toolset_record(agent, normalized_name, store["toolsets"][normalized_name])


def delete_toolset(name: str | None) -> dict[str, Any]:
    normalized_name = _normalize_toolset_name(name)
    store = _read_toolset_store()
    removed = store["toolsets"].pop(normalized_name, None)
    if removed is None:
        raise ValueError(f"toolset not found: {normalized_name}")
    _write_toolset_store(store)
    return {
        "name": normalized_name,
        "kind": "toolset",
        "origin": "persistent",
        "path": str(TOOLSET_STORE_PATH.resolve()),
        "deleted": True,
    }


def _loaded_toolsets_map(agent: Any) -> dict[str, list[str]]:
    registry = getattr(agent, "tool_registry", None)
    if registry is None:
        return {}
    loaded_toolsets = getattr(registry, "_tool_catalog_loaded_toolsets", None)
    if not isinstance(loaded_toolsets, dict):
        loaded_toolsets = {}
        registry._tool_catalog_loaded_toolsets = loaded_toolsets
    return loaded_toolsets


def _is_tool_loaded(agent: Any, tool_name: str) -> bool:
    registry = getattr(agent, "tool_registry", None)
    if registry is None:
        return False
    return any(candidate in registry.registry for candidate in _tool_registry_names(tool_name))


def _validate_load_spec(load_spec: str) -> str:
    expanded = os.path.expanduser(load_spec)
    if os.path.exists(expanded):
        return str(Path(expanded).resolve())
    module_name = load_spec.split(":", 1)[0]
    if not module_name:
        raise ValueError(f"Invalid load spec: {load_spec}")
    if importlib.util.find_spec(module_name) is None:
        raise FileNotFoundError(f"Unable to resolve module path: {module_name}")
    return load_spec


def _load_tool(agent: Any, tool_name: str, load_spec: str) -> None:
    if os.environ.get("STRANDS_DISABLE_LOAD_TOOL", "").lower() == "true":
        raise RuntimeError("Dynamic tool loading is disabled via STRANDS_DISABLE_LOAD_TOOL=true")
    validated_spec = _validate_load_spec(load_spec)
    if os.path.exists(validated_spec):
        agent.tool_registry.load_tool_from_filepath(tool_name=tool_name, tool_path=validated_spec)
    else:
        agent.tool_registry.process_tools([validated_spec])
    if not _is_tool_loaded(agent, tool_name):
        raise RuntimeError(f"Tool loader completed but '{tool_name}' was not registered")


def unload_tool(agent: Any, tool_name: str) -> None:
    if tool_name in PROTECTED_TOOL_NAMES:
        raise ValueError(f"Cannot unload baseline tool: {tool_name}")

    registry = getattr(agent, "tool_registry", None)
    if registry is None:
        raise ValueError("Agent has no tool registry")

    removed = False
    if hasattr(registry, "unregister_tool") and callable(registry.unregister_tool):
        for candidate in _tool_registry_names(tool_name):
            if candidate in registry.registry:
                registry.unregister_tool(candidate)
                removed = True
    else:
        for candidate in _tool_registry_names(tool_name):
            if candidate in registry.registry:
                registry.registry.pop(candidate, None)
                removed = True
            registry.dynamic_tools.pop(candidate, None)

    if not removed:
        raise ValueError(f"Tool not loaded: {tool_name}")

    if hasattr(registry, "tool_config"):
        registry.tool_config = None

    loaded_toolsets = _loaded_toolsets_map(agent)
    for toolset_name, loaded_names in list(loaded_toolsets.items()):
        remaining = [name for name in loaded_names if name != tool_name]
        if remaining:
            loaded_toolsets[toolset_name] = remaining
        else:
            loaded_toolsets.pop(toolset_name, None)


def _execute_loaded_tool(agent: Any, tool_name: str, arguments: dict[str, Any]) -> Any:
    return getattr(agent.tool, _tool_method_name(tool_name))(**arguments)


def _resolve_catalog_tool(agent: Any, name: str | None) -> CatalogEntry:
    if not name:
        raise ValueError("name is required")
    entry = _tool_entry(agent, name)
    if entry is None:
        raise ValueError(f"Tool not found: {name}")
    if entry.kind != "tool":
        raise ValueError(f"Catalog entry is not a tool: {name}")
    if not _is_tool_loaded(agent, entry.name) and not entry.load_spec:
        raise ValueError(f"No load path found for tool: {name}")
    return entry


def list_categories_result(agent: Any) -> dict[str, Any]:
    overview = build_catalog_overview(agent)
    try:
        toolsets = list_toolset_records(agent)
        overview["toolsets"] = toolsets
        overview["toolsets_store"] = str(TOOLSET_STORE_PATH.resolve())
        overview["count"]["toolsets"] = len(toolsets)
    except Exception as exc:
        overview["toolsets"] = []
        overview["toolsets_store"] = str(TOOLSET_STORE_PATH.resolve())
        overview["toolsets_error"] = str(exc)
        overview["count"]["toolsets"] = 0
    return {"status": "success", "content": [{"json": overview}]}


def get_tool_result(agent: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for get_tool"}]}
    details = get_tool_details(agent, name)
    if details is None:
        return {"status": "error", "content": [{"text": f"Tool not found: {name}"}]}
    return {"status": "success", "content": [{"json": details}]}


def execute_result(
    agent: Any,
    *,
    name: str | None,
    arguments: dict[str, Any] | None,
    tools: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    invocations = tools if isinstance(tools, list) and tools else None
    if invocations is None:
        if not name:
            return {"status": "error", "content": [{"text": "execute requires name or tools list"}]}
        invocations = [{"name": name, "arguments": arguments or {}}]

    results: list[dict[str, Any]] = []
    any_success = False

    for invocation in invocations:
        tool_name = invocation.get("name")
        tool_arguments = invocation.get("arguments") or {}
        try:
            entry = _resolve_catalog_tool(agent, tool_name)
            loaded_here = False
            if not _is_tool_loaded(agent, entry.name):
                _load_tool(agent, entry.name, entry.load_spec or "")
                loaded_here = True
            try:
                result = _execute_loaded_tool(agent, entry.name, tool_arguments)
                any_success = True
                results.append({"name": entry.name, "result": result})
            finally:
                if loaded_here:
                    unload_tool(agent, entry.name)
        except Exception as exc:
            results.append({"name": tool_name, "error": str(exc)})

    status = "success" if any_success else "error"
    payload: Any = results[0]["result"] if len(results) == 1 and any_success and "result" in results[0] else results
    return {"status": status, "content": [{"json": payload}]}


def load_tool_result(agent: Any, name: str | None) -> dict[str, Any]:
    try:
        entry = _resolve_catalog_tool(agent, name)
        if _is_tool_loaded(agent, entry.name):
            return {"status": "success", "content": [{"text": f"Tool already loaded: {entry.name}"}]}
        _load_tool(agent, entry.name, entry.load_spec or "")
        return {"status": "success", "content": [{"text": f"Loaded tool: {entry.name}"}]}
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}


def unload_tool_result(agent: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for unload"}]}
    try:
        unload_tool(agent, name)
        return {"status": "success", "content": [{"text": f"Unloaded tool: {name}"}]}
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}


def list_toolsets_result(agent: Any) -> dict[str, Any]:
    try:
        toolsets = list_toolset_records(agent)
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    return {
        "status": "success",
        "content": [
            {
                "json": {
                    "toolsets": toolsets,
                    "count": len(toolsets),
                    "path": str(TOOLSET_STORE_PATH.resolve()),
                }
            }
        ],
    }


def get_toolset_result(agent: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for get_toolset"}]}
    try:
        record = get_toolset_record(agent, name)
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    if record is None:
        return {"status": "error", "content": [{"text": f"Toolset not found: {name}"}]}
    return {"status": "success", "content": [{"json": record}]}


def create_toolset_result(
    agent: Any,
    *,
    name: str | None,
    description: str | None,
    tool_names: list[str] | None,
) -> dict[str, Any]:
    try:
        record = save_toolset(
            agent,
            name=name,
            description=description,
            tool_names=tool_names,
            require_existing=False,
        )
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    return {"status": "success", "content": [{"json": record}]}


def update_toolset_result(
    agent: Any,
    *,
    name: str | None,
    description: str | None,
    tool_names: list[str] | None,
) -> dict[str, Any]:
    try:
        record = save_toolset(
            agent,
            name=name,
            description=description,
            tool_names=tool_names,
            require_existing=True,
        )
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    return {"status": "success", "content": [{"json": record}]}


def delete_toolset_result(name: str | None) -> dict[str, Any]:
    try:
        record = delete_toolset(name)
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    return {"status": "success", "content": [{"json": record}]}


def load_toolset_result(agent: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for load_toolset"}]}

    try:
        toolset = get_toolset_record(agent, name)
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}

    entries: list[CatalogEntry] = []
    if toolset is not None:
        entries = [_resolve_catalog_tool(agent, tool_name) for tool_name in toolset["tool_names"]]
    else:
        entries = get_tools_by_category(agent, name)
        if not entries:
            return {"status": "error", "content": [{"text": f"No toolset or category found: {name}"}]}

    loaded: list[str] = []
    errors: list[dict[str, str]] = []
    for entry in entries:
        try:
            if not _is_tool_loaded(agent, entry.name):
                _load_tool(agent, entry.name, entry.load_spec or "")
            loaded.append(entry.name)
        except Exception as exc:
            errors.append({"name": entry.name, "error": str(exc)})

    _loaded_toolsets_map(agent)[name] = loaded
    summary = f"Loaded {len(loaded)}/{len(entries)} tools from '{name}'"
    if errors:
        summary += f" ({len(errors)} failed)"
    return {
        "status": "success" if loaded else "error",
        "content": [{"json": {"summary": summary, "loaded": loaded, "errors": errors}}],
    }


def unload_toolset_result(agent: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for unload_toolset"}]}

    loaded_toolsets = _loaded_toolsets_map(agent)
    tool_names = loaded_toolsets.get(name)
    if tool_names is None:
        toolset = get_toolset_record(agent, name)
        if toolset is not None:
            tool_names = list(toolset["tool_names"])
        else:
            tool_names = [entry.name for entry in get_tools_by_category(agent, name)]
        if not tool_names:
            return {"status": "error", "content": [{"text": f"No toolset or category found: {name}"}]}

    unloaded: list[str] = []
    errors: list[dict[str, str]] = []
    for tool_name in tool_names:
        try:
            unload_tool(agent, tool_name)
            unloaded.append(tool_name)
        except Exception as exc:
            errors.append({"name": tool_name, "error": str(exc)})

    remaining = [tool_name for tool_name in tool_names if tool_name not in unloaded]
    if remaining:
        loaded_toolsets[name] = remaining
    else:
        loaded_toolsets.pop(name, None)

    summary = f"Unloaded {len(unloaded)}/{len(tool_names)} tools from '{name}'"
    if errors:
        summary += f" ({len(errors)} failed)"
    return {
        "status": "success" if unloaded else "error",
        "content": [{"json": {"summary": summary, "unloaded": unloaded, "errors": errors}}],
    }
