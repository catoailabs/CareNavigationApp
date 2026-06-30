from __future__ import annotations

import ast
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from strands import Agent
from strands.tools.registry import ToolRegistry

LOGGER = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_ROOT = REPO_ROOT / "tools"
MCP_ROOT = TOOLS_ROOT / "mcp"
OPENAPI_ROOT = TOOLS_ROOT / "open-api-specs"
TOOLSET_STORE_PATH = TOOLS_ROOT / ".tool_catalog_toolsets.json"

CATALOG_SCAN_ROOTS: tuple[tuple[Path, bool], ...] = (
    (TOOLS_ROOT, True),
    (TOOLS_ROOT / "ronbrowser_agent_tools" / "src" / "strands_tools", False),
)

EXCLUDED_TOOL_ROOTS = {"__pycache__", "mcp", "ronbrowser_agent_tools", "open-api-specs"}
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
            "load_spec": self.load_spec,
            "load_pathway": (
                f"load_catalog_tool(name={json.dumps(self.name)})"
                if self.kind == "tool"
                else None
            ),
            "execute_pathway": (
                f"execute_catalog_tool(name={json.dumps(self.name)}, arguments={{...}})"
                if self.kind == "tool"
                else None
            ),
            "unload_pathway": (
                f"unload_catalog_tool(name={json.dumps(self.name)})"
                if self.kind == "tool"
                else None
            ),
        }


def _first_line(text: str | None) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()
    return ""


def _inventory_relative_path(path: Path) -> Path:
    resolved_path = path.resolve()
    ronbrowser_root = (TOOLS_ROOT / "ronbrowser_agent_tools" / "src" / "strands_tools").resolve()
    if resolved_path.is_relative_to(ronbrowser_root):
        return resolved_path.relative_to(ronbrowser_root)
    return resolved_path.relative_to(TOOLS_ROOT.resolve())


def _category_for_path(path: Path) -> str:
    relative = _inventory_relative_path(path)
    parts = relative.parts
    if len(parts) <= 1:
        return "root"
    return parts[0]


def _module_path_for_file(path: Path) -> str | None:
    try:
        relative = path.resolve().relative_to(REPO_ROOT.resolve()).with_suffix("")
    except ValueError:
        return None
    return ".".join(relative.parts)


def _input_summary(schema: dict[str, Any]) -> dict[str, str]:
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return {}
    summary: dict[str, str] = {}
    for key, value in properties.items():
        if isinstance(value, dict):
            raw_type = value.get("type", "any")
            summary[key] = " | ".join(str(item) for item in raw_type) if isinstance(raw_type, list) else str(raw_type)
        else:
            summary[key] = "any"
    return summary


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
    category = _category_for_path(path)
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
        entries.append(
            CatalogEntry(
                name=tool_name,
                description=description_override or _first_line(ast.get_docstring(node)),
                input_schema={},
                input_summary={},
                origin="catalog",
                category=category,
                kind="tool",
                path=str(path.resolve()),
                module_path=module_path,
                load_spec=module_path,
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
        category=_category_for_path(path),
        kind="tool",
        path=str(path.resolve()),
        module_path=module_path,
        load_spec=module_path,
    )


def _iter_python_tool_files(root: Path, *, apply_root_exclusions: bool) -> list[Path]:
    files: list[Path] = []
    if not root.exists():
        return files
    resolved_tools_root = TOOLS_ROOT.resolve()
    for path in root.rglob("*.py"):
        if path.name == "__init__.py":
            continue
        if apply_root_exclusions:
            try:
                relative = path.resolve().relative_to(resolved_tools_root)
                if relative.parts and relative.parts[0] in EXCLUDED_TOOL_ROOTS:
                    continue
            except ValueError:
                continue
        files.append(path)
    return files


def _scan_python_tool_entries() -> dict[str, CatalogEntry]:
    entries: dict[str, CatalogEntry] = {}
    for root, apply_root_exclusions in CATALOG_SCAN_ROOTS:
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
        description = ""
        if readme.exists():
            description = _first_line(readme.read_text(encoding="utf-8", errors="ignore"))
        entries[child.name] = CatalogEntry(
            name=child.name,
            description=description,
            input_schema={},
            input_summary={},
            origin="catalog",
            category="mcp",
            kind="mcp_server",
            path=str(child.resolve()),
        )
    return entries


def _scan_openapi_entries() -> dict[str, CatalogEntry]:
    entries: dict[str, CatalogEntry] = {}
    if not OPENAPI_ROOT.exists():
        return entries
    for path in OPENAPI_ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in OPENAPI_EXTENSIONS:
            continue
        try:
            relative = path.relative_to(OPENAPI_ROOT).with_suffix("")
        except ValueError:
            continue
        category = relative.parts[0] if len(relative.parts) > 1 else "open_api_specs"
        entries[relative.as_posix()] = CatalogEntry(
            name=relative.as_posix(),
            description="",
            input_schema={},
            input_summary={},
            origin="catalog",
            category=category,
            kind="openapi_spec",
            path=str(path.resolve()),
        )
    return entries


def _extract_schema(tool_obj: Any) -> dict[str, Any]:
    spec = getattr(tool_obj, "tool_spec", None)
    if isinstance(spec, dict):
        schema = spec.get("inputSchema") or spec.get("input_schema") or {}
        if isinstance(schema, dict):
            if isinstance(schema.get("json"), dict):
                return dict(schema["json"])
            return dict(schema)
    return {}


def _extract_description(tool_obj: Any) -> str:
    spec = getattr(tool_obj, "tool_spec", None)
    if isinstance(spec, dict):
        description = spec.get("description")
        if isinstance(description, str):
            return _first_line(description)
    doc = getattr(tool_obj, "__doc__", None)
    if isinstance(doc, str):
        return _first_line(doc)
    return ""


def _scan_runtime_entries(agent: Agent | None) -> dict[str, CatalogEntry]:
    if agent is None:
        return {}
    registry: ToolRegistry | None = getattr(agent, "tool_registry", None)
    if registry is None:
        return {}

    entries: dict[str, CatalogEntry] = {}
    for tool_name, tool_obj in registry.registry.items():
        module = getattr(tool_obj, "__module__", None)
        path: str | None = None
        module_path: str | None = None
        if isinstance(module, str):
            module_path = module
            try:
                mod = __import__(module, fromlist=["__file__"])
                file_path = getattr(mod, "__file__", None)
                if isinstance(file_path, str):
                    path = str(Path(file_path).resolve())
            except Exception:
                pass
        origin = "baseline"
        category = "baseline"
        if path:
            try:
                category = _category_for_path(Path(path))
            except Exception:
                pass
            resolved_path = Path(path).resolve()
            ronbrowser_root = (TOOLS_ROOT / "ronbrowser_agent_tools").resolve()
            try:
                if resolved_path.is_relative_to(ronbrowser_root):
                    origin = "vended"
            except Exception:
                pass
        entries[tool_name] = CatalogEntry(
            name=tool_name,
            description=_extract_description(tool_obj),
            input_schema=_extract_schema(tool_obj),
            input_summary=_input_summary(_extract_schema(tool_obj)),
            origin=origin,
            category=category,
            kind="tool",
            path=path,
            module_path=module_path,
            load_spec=module_path or path,
        )
    return entries


def _catalog_indices(
    agent: Agent | None,
) -> tuple[dict[str, CatalogEntry], dict[str, CatalogEntry], dict[str, CatalogEntry]]:
    tool_entries = _scan_python_tool_entries()
    tool_entries.update(_scan_runtime_entries(agent))
    return tool_entries, _scan_mcp_entries(), _scan_openapi_entries()


def build_catalog_overview(agent: Agent | None) -> dict[str, Any]:
    tool_entries, mcp_entries, openapi_entries = _catalog_indices(agent)
    categories: dict[str, dict[str, Any]] = {}

    def ensure_bucket(category_id: str) -> dict[str, Any]:
        bucket = categories.get(category_id)
        if bucket is None:
            bucket = {
                "id": category_id,
                "label": category_id.replace("_", " ").title(),
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

    ordered_categories = sorted(categories.values(), key=sort_key)
    for bucket in ordered_categories:
        tool_count = len(bucket["tools"])
        mcp_count = len(bucket["mcp_servers"])
        spec_count = len(bucket["openapi_specs"])
        bucket["count"] = {
            "tools": tool_count,
            "mcp_servers": mcp_count,
            "openapi_specs": spec_count,
            "total": tool_count + mcp_count + spec_count,
        }

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


def get_tool_details(agent: Agent | None, name: str | None) -> dict[str, Any] | None:
    if not name:
        return None
    tool_entries, mcp_entries, openapi_entries = _catalog_indices(agent)
    for entries in (tool_entries, mcp_entries, openapi_entries):
        entry = entries.get(name)
        if entry is not None:
            return entry.to_dict()
    return None


def _tool_entry(agent: Agent | None, name: str | None) -> CatalogEntry | None:
    if not name:
        return None
    tool_entries, _, _ = _catalog_indices(agent)
    return tool_entries.get(name)


def get_tools_by_category(agent: Agent | None, category_id: str) -> list[CatalogEntry]:
    normalized = category_id.strip().lower().replace(" ", "_")
    tool_entries, _, _ = _catalog_indices(agent)
    return sorted(
        [entry for entry in tool_entries.values() if entry.category.lower() == normalized],
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
    agent: Agent | None, tool_names: list[str]
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


def _validated_tool_names(agent: Agent | None, tool_names: list[str] | None) -> list[str]:
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


def _toolset_record(agent: Agent | None, name: str, definition: dict[str, Any]) -> dict[str, Any]:
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


def list_toolset_records(agent: Agent | None) -> list[dict[str, Any]]:
    store = _read_toolset_store()
    return [_toolset_record(agent, name, store["toolsets"][name]) for name in sorted(store["toolsets"])]


def get_toolset_record(agent: Agent | None, name: str | None) -> dict[str, Any] | None:
    normalized_name = _normalize_toolset_name(name)
    definition = _read_toolset_store()["toolsets"].get(normalized_name)
    if definition is None:
        return None
    return _toolset_record(agent, normalized_name, definition)


def save_toolset(
    agent: Agent | None,
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


def _is_tool_loaded(agent: Agent, tool_name: str) -> bool:
    registry: ToolRegistry | None = getattr(agent, "tool_registry", None)
    if registry is None:
        return False
    return tool_name in registry.registry


def _load_tool(agent: Agent, tool_name: str, load_spec: str | None) -> None:
    if os.environ.get("STRANDS_DISABLE_LOAD_TOOL", "").lower() == "true":
        raise RuntimeError("Dynamic tool loading is disabled via STRANDS_DISABLE_LOAD_TOOL=true")
    if not load_spec:
        raise ValueError(f"No load spec for tool: {tool_name}")
    registry: ToolRegistry | None = getattr(agent, "tool_registry", None)
    if registry is None:
        raise RuntimeError("Agent has no tool registry")
    registry.process_tools([{"name": tool_name, "path": load_spec}])
    if not _is_tool_loaded(agent, tool_name):
        raise RuntimeError(f"Tool loader completed but '{tool_name}' was not registered")


def unload_tool(agent: Agent, tool_name: str) -> None:
    registry: ToolRegistry | None = getattr(agent, "tool_registry", None)
    if registry is None:
        raise RuntimeError("Agent has no tool registry")
    if tool_name not in registry.registry:
        raise ValueError(f"Tool not loaded: {tool_name}")
    registry.registry.pop(tool_name, None)
    registry.dynamic_tools.pop(tool_name, None)


def _execute_loaded_tool(agent: Agent, tool_name: str, arguments: dict[str, Any]) -> Any:
    method_name = tool_name.replace("-", "_")
    caller = getattr(agent.tool, method_name)
    return caller(**arguments)


def _resolve_catalog_tool(agent: Agent | None, name: str | None) -> CatalogEntry:
    if not name:
        raise ValueError("name is required")
    if agent is not None and _is_tool_loaded(agent, name):
        for tool_obj in agent.tool_registry.registry.values():
            if getattr(tool_obj, "tool_name", None) == name:
                return CatalogEntry(
                    name=name,
                    description=_extract_description(tool_obj),
                    input_schema=_extract_schema(tool_obj),
                    input_summary=_input_summary(_extract_schema(tool_obj)),
                    origin="loaded",
                    category="loaded",
                    kind="tool",
                    path=None,
                    module_path=None,
                    load_spec=None,
                )
    entry = _tool_entry(agent, name)
    if entry is None:
        raise ValueError(f"Tool not found: {name}")
    if entry.kind != "tool":
        raise ValueError(f"Catalog entry is not a tool: {name}")
    return entry


def list_categories_result(agent: Agent | None) -> dict[str, Any]:
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


def get_tool_result(agent: Agent | None, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for get_tool"}]}
    details = get_tool_details(agent, name)
    if details is None:
        return {"status": "error", "content": [{"text": f"Tool not found: {name}"}]}
    return {"status": "success", "content": [{"json": details}]}


def execute_result(
    agent: Agent | None,
    *,
    name: str | None,
    arguments: dict[str, Any] | None,
    tools: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    if agent is None:
        return {"status": "error", "content": [{"text": "Agent is required to execute tools"}]}

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
                _load_tool(agent, entry.name, entry.load_spec)
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
    if len(results) == 1 and any_success and "result" in results[0]:
        payload: Any = results[0]["result"]
    else:
        payload = results
    return {"status": status, "content": [{"json": payload}]}


def load_tool_result(agent: Agent | None, name: str | None) -> dict[str, Any]:
    if agent is None:
        return {"status": "error", "content": [{"text": "Agent is required to load tools"}]}
    if not name:
        return {"status": "error", "content": [{"text": "name is required for load"}]}
    try:
        entry = _resolve_catalog_tool(agent, name)
        if _is_tool_loaded(agent, entry.name):
            return {"status": "success", "content": [{"text": f"Tool already loaded: {entry.name}"}]}
        _load_tool(agent, entry.name, entry.load_spec)
        return {"status": "success", "content": [{"text": f"Loaded tool: {entry.name}"}]}
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}


def unload_tool_result(agent: Agent | None, name: str | None) -> dict[str, Any]:
    if agent is None:
        return {"status": "error", "content": [{"text": "Agent is required to unload tools"}]}
    if not name:
        return {"status": "error", "content": [{"text": "name is required for unload"}]}
    try:
        unload_tool(agent, name)
        return {"status": "success", "content": [{"text": f"Unloaded tool: {name}"}]}
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}


def list_toolsets_result(agent: Agent | None) -> dict[str, Any]:
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


def get_toolset_result(agent: Agent | None, name: str | None) -> dict[str, Any]:
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
    agent: Agent | None,
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
    agent: Agent | None,
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


def load_toolset_result(agent: Agent | None, name: str | None) -> dict[str, Any]:
    if agent is None:
        return {"status": "error", "content": [{"text": "Agent is required to load toolsets"}]}
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
                _load_tool(agent, entry.name, entry.load_spec)
            loaded.append(entry.name)
        except Exception as exc:
            errors.append({"name": entry.name, "error": str(exc)})

    summary = f"Loaded {len(loaded)}/{len(entries)} tools from '{name}'"
    if errors:
        summary += f" ({len(errors)} failed)"
    return {
        "status": "success" if loaded else "error",
        "content": [{"json": {"summary": summary, "loaded": loaded, "errors": errors}}],
    }


def unload_toolset_result(agent: Agent | None, name: str | None) -> dict[str, Any]:
    if agent is None:
        return {"status": "error", "content": [{"text": "Agent is required to unload toolsets"}]}
    if not name:
        return {"status": "error", "content": [{"text": "name is required for unload_toolset"}]}

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

    summary = f"Unloaded {len(unloaded)}/{len(tool_names)} tools from '{name}'"
    if errors:
        summary += f" ({len(errors)} failed)"
    return {
        "status": "success" if unloaded else "error",
        "content": [{"json": {"summary": summary, "unloaded": unloaded, "errors": errors}}],
    }
