"""Category-aware tool catalog manager for Strands tools."""

from __future__ import annotations

import ast
import inspect
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Any

logger = logging.getLogger(__name__)

_CATEGORY_ORDER: tuple[tuple[str, str], ...] = (
    ("agent_orchestration", "Agent Orchestration"),
    ("browser", "Browser"),
    ("code_interpreter", "Code Interpreter"),
    ("devops", "Devops"),
    ("healthcare", "Healthcare"),
    ("multimodal", "Multimodal"),
    ("omni_channel_comms", "Omni Channel Comms"),
    ("research", "Research"),
    ("meta-tooling", "Meta Tooling"),
)
CATEGORY_IDS = tuple(item[0] for item in _CATEGORY_ORDER)
CATEGORY_ID_SET = set(CATEGORY_IDS)
CATEGORY_LABELS = {item[0]: item[1] for item in _CATEGORY_ORDER}
_OPENAPI_SUFFIXES = {".json", ".yml", ".yaml"}
_OPENAPI_SUFFIX_PRIORITY = {".json": 0, ".yaml": 1, ".yml": 2}
_MCP_MARKER_FILES = {
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Dockerfile",
    "manifest.json",
    "server.py",
    "smithery.yaml",
}
_MCP_MARKER_DIRS = {"src", "server", "dist", "bin"}
_INTERNAL_TOOL_PARAMS = {"self", "cls", "tool_context", "agent"}
_SCALAR_TYPE_MAP = {
    "str": "string",
    "LiteralString": "string",
    "Path": "string",
    "PurePath": "string",
    "int": "integer",
    "float": "number",
    "bool": "boolean",
    "dict": "object",
    "Dict": "object",
    "Mapping": "object",
    "MutableMapping": "object",
    "TypedDict": "object",
    "list": "array",
    "List": "array",
    "tuple": "array",
    "Tuple": "array",
    "set": "array",
    "Set": "array",
    "Sequence": "array",
    "Iterable": "array",
}
_OPENAPI_YAML_RE = re.compile(r"(?m)^\s*(openapi|swagger)\s*:\s*([^\n#]+)")


def _normalize_alias_key(value: str) -> str:
    normalized = value.strip().lower()
    for source, target in (("-", "_"), (" ", "_"), ("/", "_"), ("\\", "_"), (".", "_")):
        normalized = normalized.replace(source, target)
    while "__" in normalized:
        normalized = normalized.replace("__", "_")
    return normalized.strip("_")


def _build_category_aliases() -> dict[str, str]:
    aliases: dict[str, str] = {}
    for category_id, label in _CATEGORY_ORDER:
        variants = {
            category_id,
            category_id.replace("-", "_"),
            category_id.replace("_", "-"),
            label,
        }
        for variant in variants:
            aliases[_normalize_alias_key(variant)] = category_id
    aliases.update(
        {
            "agent_orchestration": "agent_orchestration",
            "agent_orchestration_tools": "agent_orchestration",
            "built_in": "agent_orchestration",
            "browser": "browser",
            "code_interpreter": "code_interpreter",
            "code_interpretation": "code_interpreter",
            "devops": "devops",
            "dynamically_loaded": "devops",
            "healthcare": "healthcare",
            "mcp_tools": "agent_orchestration",
            "meta_tooling": "meta-tooling",
            "multimodal": "multimodal",
            "omni_channel_comms": "omni_channel_comms",
            "omni_channel_comms_tools": "omni_channel_comms",
            "research": "research",
        }
    )
    return aliases


CATEGORY_ALIASES = _build_category_aliases()


@dataclass(slots=True)
class _CatalogEntry:
    name: str
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)
    input_summary: dict[str, str] = field(default_factory=dict)
    origin: str = "runtime"
    category: str = "agent_orchestration"
    path: str | None = None
    module_path: str | None = None
    load_pathway: str | None = None
    execute_pathway: str | None = None
    unload_pathway: str | None = None
    kind: str = "tool"

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
            "input_summary": self.input_summary,
            "origin": self.origin,
            "category": self.category,
            "path": self.path,
            "module_path": self.module_path,
            "load_pathway": self.load_pathway,
            "execute_pathway": self.execute_pathway,
            "unload_pathway": self.unload_pathway,
            "kind": self.kind,
        }


def _project_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "tools" / "ronbrowser_agent_tools" / "src" / "strands_tools").exists():
            return parent
        if (parent / "src" / "strands_tools").exists():
            return parent
    for parent in here.parents:
        if any((parent / marker).exists() for marker in (".git", "package.json", "pyproject.toml")):
            return parent
    return here.parents[-1]


def _inventory_root() -> Path:
    root = _project_root()
    for candidate in (
        root / "tools" / "ronbrowser_agent_tools" / "src" / "strands_tools",
        root / "src" / "strands_tools",
        root / "strands_tools",
    ):
        if candidate.exists():
            return candidate
    return root / "strands_tools"


def _canonical_category_id(value: str | None) -> str | None:
    if not value:
        return None
    return CATEGORY_ALIASES.get(_normalize_alias_key(value))


def _relative_to_inventory_root(path: str | Path | None) -> Path | None:
    if not path:
        return None
    try:
        return Path(path).resolve().relative_to(_inventory_root().resolve())
    except Exception:
        return None


def _category_from_path(path: str | None) -> str | None:
    relative_path = _relative_to_inventory_root(path)
    if relative_path is None or not relative_path.parts:
        return None
    return _canonical_category_id(relative_path.parts[0])


def _category_from_module_path(module_path: str | None) -> str | None:
    if not module_path:
        return None
    parts = module_path.split(".")
    try:
        index = parts.index("strands_tools")
    except ValueError:
        return None
    if index + 1 >= len(parts):
        return None
    return _canonical_category_id(parts[index + 1])


def _normalize_category(value: str | None, *, path: str | None = None, module_path: str | None = None) -> str:
    for resolved in (_category_from_path(path), _category_from_module_path(module_path), _canonical_category_id(value)):
        if resolved:
            return resolved

    for candidate in (value, module_path, path):
        if not candidate:
            continue
        for piece in re.split(r"[/\\.\s]+", str(candidate)):
            resolved = _canonical_category_id(piece)
            if resolved:
                return resolved
    return "agent_orchestration"


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()
    return ""


def _extract_tool_name(tool_obj: Any) -> str:
    tool_spec_attr = getattr(tool_obj, "TOOL_SPEC", None)
    if isinstance(tool_spec_attr, dict):
        spec_name = tool_spec_attr.get("name")
        if isinstance(spec_name, str) and spec_name.strip():
            return spec_name.strip()
    for attr in ("tool_name", "_tool_name", "__name__"):
        value = getattr(tool_obj, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    tool_spec = getattr(tool_obj, "tool_spec", None)
    if isinstance(tool_spec, dict):
        spec_name = tool_spec.get("name")
        if isinstance(spec_name, str) and spec_name.strip():
            return spec_name.strip()
    return ""


def _extract_tool_description(tool_obj: Any) -> str:
    tool_spec_attr = getattr(tool_obj, "TOOL_SPEC", None)
    if isinstance(tool_spec_attr, dict):
        description = tool_spec_attr.get("description")
        if isinstance(description, str) and description.strip():
            return _first_line(description)
    tool_spec = getattr(tool_obj, "tool_spec", None)
    if isinstance(tool_spec, dict):
        description = tool_spec.get("description")
        if isinstance(description, str) and description.strip():
            return _first_line(description)
    doc = inspect.getdoc(tool_obj)
    if not doc and callable(tool_obj):
        doc = inspect.getdoc(tool_obj.__call__)
    return _first_line(doc or "")


def _extract_tool_path(tool_obj: Any) -> str | None:
    candidates: list[str | None] = []
    callable_target = tool_obj.__call__ if callable(tool_obj) else None
    for target in (tool_obj, callable_target):
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
            try:
                return str(Path(candidate).resolve())
            except Exception:
                return candidate
    return None


def _extract_module_path(tool_obj: Any) -> str | None:
    tool_spec = getattr(tool_obj, "tool_spec", None)
    if isinstance(tool_spec, dict):
        module_path = tool_spec.get("module_path")
        if isinstance(module_path, str) and module_path.strip():
            return module_path.strip()
    module = inspect.getmodule(tool_obj)
    if module is not None:
        module_name = getattr(module, "__name__", None)
        if isinstance(module_name, str) and module_name.strip():
            return module_name.strip()
    return None


def _extract_input_schema(tool_obj: Any) -> dict[str, Any]:
    tool_spec_attr = getattr(tool_obj, "TOOL_SPEC", None)
    schema = None
    if isinstance(tool_spec_attr, dict):
        schema = tool_spec_attr.get("inputSchema") or tool_spec_attr.get("input_schema")
    if schema is None:
        tool_spec = getattr(tool_obj, "tool_spec", None)
        if isinstance(tool_spec, dict):
            schema = tool_spec.get("inputSchema") or tool_spec.get("input_schema")
    if isinstance(schema, dict) and isinstance(schema.get("json"), dict):
        schema = schema["json"]
    return schema if isinstance(schema, dict) else {}


def _extract_input_summary(input_schema: dict[str, Any]) -> dict[str, str]:
    properties = input_schema.get("properties")
    if not isinstance(properties, dict):
        return {}
    summary: dict[str, str] = {}
    for key, value in properties.items():
        if not isinstance(value, dict):
            summary[key] = "any"
            continue
        raw_type = value.get("type")
        if isinstance(raw_type, list):
            summary[key] = " | ".join(_safe_str(item) for item in raw_type if item)
        else:
            summary[key] = _safe_str(raw_type or "any")
    return summary


def _default_load_path(module_path: str | None, path: str | None) -> str | None:
    if module_path:
        return module_path
    return path


def _default_execute_pathway(name: str) -> str:
    return f"tool_catalog(action='execute', name='{name}', arguments={{...}})"


def _default_unload_pathway(name: str) -> str:
    return f"tool_catalog(action='unload', name='{name}')"


def _merge_catalog_records(preferred: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    merged = dict(fallback)
    for key, value in preferred.items():
        if key in {"name", "origin", "category", "kind"}:
            merged[key] = value
            continue
        if value not in (None, "", {}, []):
            merged[key] = value
        elif key not in merged:
            merged[key] = value
    return merged


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
        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            return left + right
        if isinstance(left, list) and isinstance(right, list):
            return left + right
    raise ValueError(f"Unsupported AST literal: {node.__class__.__name__}")


def _module_ast(path: Path) -> ast.Module | None:
    try:
        return ast.parse(path.read_text(encoding="utf-8", errors="ignore"), filename=str(path))
    except Exception as exc:
        logger.debug("Skipping static tool parse for %s: %s", path, exc)
        return None


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
            value = _safe_eval_ast(value_node)
        except Exception as exc:
            logger.debug("Unable to statically evaluate TOOL_SPEC in %s: %s", tree, exc)
            return None
        return value if isinstance(value, dict) else None
    return None


def _tool_decorator_names(tree: ast.Module) -> set[str]:
    names = {"tool"}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or node.module != "strands":
            continue
        for alias in node.names:
            if alias.name == "tool":
                names.add(alias.asname or alias.name)
    return names


def _decorator_target_name(decorator: ast.expr) -> str | None:
    target = decorator.func if isinstance(decorator, ast.Call) else decorator
    if isinstance(target, ast.Name):
        return target.id
    if isinstance(target, ast.Attribute):
        return target.attr
    return None


def _decorated_tool_metadata(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    decorator_names: set[str],
) -> dict[str, Any] | None:
    for decorator in node.decorator_list:
        target_name = _decorator_target_name(decorator)
        if target_name not in decorator_names:
            continue
        metadata = {"name": None, "description": "", "context": False}
        if isinstance(decorator, ast.Call):
            for keyword in decorator.keywords:
                try:
                    value = _safe_eval_ast(keyword.value)
                except Exception:
                    continue
                if keyword.arg == "name" and isinstance(value, str) and value.strip():
                    metadata["name"] = value.strip()
                elif keyword.arg == "description" and isinstance(value, str) and value.strip():
                    metadata["description"] = _first_line(value)
                elif keyword.arg == "context":
                    metadata["context"] = bool(value)
        return metadata
    return None


def _annotation_base_name(annotation: ast.AST | None) -> str | None:
    if annotation is None:
        return None
    if isinstance(annotation, ast.Name):
        return annotation.id
    if isinstance(annotation, ast.Attribute):
        return annotation.attr
    if isinstance(annotation, ast.Subscript):
        return _annotation_base_name(annotation.value)
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        return annotation.value
    return None


def _annotation_subscript_elements(annotation: ast.Subscript) -> list[ast.AST]:
    if isinstance(annotation.slice, ast.Tuple):
        return list(annotation.slice.elts)
    return [annotation.slice]


def _schema_from_literal(values: list[Any]) -> dict[str, Any]:
    if not values:
        return {}
    value_types = {type(value).__name__ for value in values if value is not None}
    scalar_type = None
    if value_types == {"str"}:
        scalar_type = "string"
    elif value_types == {"int"}:
        scalar_type = "integer"
    elif value_types == {"float"}:
        scalar_type = "number"
    elif value_types == {"bool"}:
        scalar_type = "boolean"
    schema: dict[str, Any] = {"enum": values}
    if scalar_type:
        schema["type"] = scalar_type
    return schema


def _schema_from_union(elements: list[ast.AST]) -> dict[str, Any]:
    resolved_types: list[str] = []
    for element in elements:
        schema = _annotation_to_schema(element)
        raw_type = schema.get("type")
        if isinstance(raw_type, list):
            resolved_types.extend(_safe_str(item) for item in raw_type if item and item != "null")
        elif isinstance(raw_type, str) and raw_type and raw_type != "null":
            resolved_types.append(raw_type)
    unique_types = list(dict.fromkeys(resolved_types))
    if not unique_types:
        return {}
    if len(unique_types) == 1:
        return {"type": unique_types[0]}
    return {"type": unique_types}


def _annotation_to_schema(annotation: ast.AST | None) -> dict[str, Any]:
    if annotation is None:
        return {}
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        return _schema_from_union([annotation.left, annotation.right])
    if isinstance(annotation, ast.Subscript):
        base_name = _annotation_base_name(annotation)
        elements = _annotation_subscript_elements(annotation)
        if base_name == "Optional" and elements:
            return _annotation_to_schema(elements[0])
        if base_name == "Union":
            return _schema_from_union(elements)
        if base_name == "Literal":
            values: list[Any] = []
            for element in elements:
                try:
                    values.append(_safe_eval_ast(element))
                except Exception:
                    continue
            return _schema_from_literal(values)
        if base_name == "Annotated" and elements:
            return _annotation_to_schema(elements[0])
        scalar_type = _SCALAR_TYPE_MAP.get(base_name or "")
        if scalar_type:
            return {"type": scalar_type}
        return {}
    base_name = _annotation_base_name(annotation)
    scalar_type = _SCALAR_TYPE_MAP.get(base_name or "")
    if scalar_type:
        return {"type": scalar_type}
    return {}


def _is_internal_param(argument: ast.arg) -> bool:
    if argument.arg in _INTERNAL_TOOL_PARAMS:
        return True
    return _annotation_base_name(argument.annotation) == "ToolContext"


def _input_schema_from_function(node: ast.FunctionDef | ast.AsyncFunctionDef) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []

    positional_args = [*node.args.posonlyargs, *node.args.args]
    default_offset = len(positional_args) - len(node.args.defaults)
    for index, argument in enumerate(positional_args):
        if _is_internal_param(argument):
            continue
        properties[argument.arg] = _annotation_to_schema(argument.annotation)
        if index < default_offset:
            required.append(argument.arg)

    for argument, default in zip(node.args.kwonlyargs, node.args.kw_defaults, strict=False):
        if _is_internal_param(argument):
            continue
        properties[argument.arg] = _annotation_to_schema(argument.annotation)
        if default is None:
            required.append(argument.arg)

    input_schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        input_schema["required"] = required
    if node.args.kwarg is not None:
        input_schema["additionalProperties"] = True
    return input_schema


def _module_path_from_file(path: Path) -> str | None:
    relative_path = _relative_to_inventory_root(path)
    if relative_path is None:
        return None
    parts = relative_path.with_suffix("").parts
    if not all(part.isidentifier() for part in parts):
        return None
    return ".".join((_inventory_root().name, *parts))


def _tool_entry_priority(entry: dict[str, Any]) -> tuple[int, int, int, str]:
    path_value = entry.get("path") or ""
    path_obj = Path(path_value) if path_value else None
    path_name = path_obj.stem if path_obj is not None else ""
    return (
        0 if path_name == entry.get("name") else 1,
        0 if entry.get("module_path") else 1,
        0 if entry.get("input_schema") else 1,
        path_value,
    )


def _prefer_tool_entry(current: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    if _tool_entry_priority(candidate) < _tool_entry_priority(current):
        return _merge_catalog_records(candidate, current)
    return _merge_catalog_records(current, candidate)


def _static_tool_entries_from_module(path: Path, category_id: str) -> list[dict[str, Any]]:
    tree = _module_ast(path)
    if tree is None:
        return []

    module_path = _module_path_from_file(path)
    resolved_path = str(path.resolve())
    module_doc = _first_line(ast.get_docstring(tree) or "")
    decorator_names = _tool_decorator_names(tree)
    tool_entries: dict[str, dict[str, Any]] = {}

    tool_spec = _tool_spec_from_ast(tree)
    if isinstance(tool_spec, dict):
        spec_name = tool_spec.get("name")
        if isinstance(spec_name, str) and spec_name.strip():
            input_schema = tool_spec.get("inputSchema") or tool_spec.get("input_schema") or {}
            if isinstance(input_schema, dict) and isinstance(input_schema.get("json"), dict):
                input_schema = input_schema["json"]
            input_schema = input_schema if isinstance(input_schema, dict) else {}
            entry = {
                "name": spec_name.strip(),
                "description": _first_line(_safe_str(tool_spec.get("description"))) or module_doc,
                "input_schema": input_schema,
                "input_summary": _extract_input_summary(input_schema),
                "origin": "static",
                "category": category_id,
                "path": resolved_path,
                "module_path": module_path,
                "load_pathway": _default_load_path(module_path, resolved_path),
                "execute_pathway": _default_execute_pathway(spec_name.strip()),
                "unload_pathway": _default_unload_pathway(spec_name.strip()),
                "kind": "tool",
            }
            tool_entries[entry["name"]] = entry

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        decorator_metadata = _decorated_tool_metadata(node, decorator_names)
        if decorator_metadata is None:
            continue
        tool_name = _safe_str(decorator_metadata.get("name") or node.name).strip()
        if not tool_name:
            continue
        input_schema = _input_schema_from_function(node)
        description = _safe_str(decorator_metadata.get("description")) or _first_line(
            ast.get_docstring(node) or module_doc
        )
        entry = {
            "name": tool_name,
            "description": description,
            "input_schema": input_schema,
            "input_summary": _extract_input_summary(input_schema),
            "origin": "static",
            "category": category_id,
            "path": resolved_path,
            "module_path": module_path,
            "load_pathway": _default_load_path(module_path, resolved_path),
            "execute_pathway": _default_execute_pathway(tool_name),
            "unload_pathway": _default_unload_pathway(tool_name),
            "kind": "tool",
        }
        existing = tool_entries.get(tool_name)
        tool_entries[tool_name] = _prefer_tool_entry(existing, entry) if existing else entry

    return sorted(tool_entries.values(), key=lambda item: item["name"])


def _mcp_server_entry(path: Path, category_id: str) -> dict[str, Any]:
    return {
        "name": path.name,
        "origin": "static",
        "category": category_id,
        "path": str(path.resolve()),
        "kind": "mcp_server",
    }


def _is_mcp_server_dir(path: Path) -> bool:
    if not path.is_dir() or path.name == "__pycache__":
        return False
    if "mcp" not in path.name.lower():
        return False
    child_names = {child.name for child in path.iterdir()}
    return bool(child_names & _MCP_MARKER_FILES or child_names & _MCP_MARKER_DIRS)


def _openapi_metadata(path: Path) -> dict[str, Any] | None:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception as exc:
        logger.debug("Unable to read candidate OpenAPI spec %s: %s", path, exc)
        return None

    if path.suffix.lower() == ".json":
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, dict):
            return None
        version = payload.get("openapi") or payload.get("swagger")
        if not version:
            return None
        info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
        description = _first_line(_safe_str(info.get("title") or info.get("description")))
        return {"description": description, "spec_version": _safe_str(version)}

    match = _OPENAPI_YAML_RE.search(text)
    if not match:
        return None
    return {"description": "", "spec_version": match.group(2).strip().strip("'\"")}


def _openapi_spec_entry(path: Path, category_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": path.stem,
        "description": _safe_str(metadata.get("description")),
        "origin": "static",
        "category": category_id,
        "path": str(path.resolve()),
        "kind": "openapi_spec",
        "spec_version": _safe_str(metadata.get("spec_version")),
    }


def _dedupe_tool_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[str, dict[str, Any]] = {}
    for entry in entries:
        existing = deduped.get(entry["name"])
        deduped[entry["name"]] = _prefer_tool_entry(existing, entry) if existing else entry
    return sorted(deduped.values(), key=lambda item: item["name"])


def _dedupe_named_entries(
    entries: list[dict[str, Any]],
    *,
    priority: callable[[dict[str, Any]], tuple[Any, ...]],
) -> list[dict[str, Any]]:
    deduped: dict[str, dict[str, Any]] = {}
    for entry in entries:
        existing = deduped.get(entry["name"])
        if existing is None or priority(entry) < priority(existing):
            deduped[entry["name"]] = entry
    return sorted(deduped.values(), key=lambda item: item["name"])


def _openapi_priority(entry: dict[str, Any]) -> tuple[int, str]:
    suffix = Path(entry.get("path") or "").suffix.lower()
    return (_OPENAPI_SUFFIX_PRIORITY.get(suffix, 99), entry.get("path") or "")


def _mcp_priority(entry: dict[str, Any]) -> tuple[str]:
    return (entry.get("path") or "",)


def _inventory_signature(root: Path) -> tuple[tuple[str, tuple[tuple[str, str, int], ...]], ...]:
    signature: list[tuple[str, tuple[tuple[str, str, int], ...]]] = []
    for category_id in CATEGORY_IDS:
        category_dir = root / category_id
        children: list[tuple[str, str, int]] = []
        if category_dir.is_dir():
            for child in sorted(category_dir.iterdir(), key=lambda item: item.name.lower()):
                if child.name == "__pycache__":
                    continue
                try:
                    stat_result = child.stat()
                    mtime_ns = int(stat_result.st_mtime_ns)
                except OSError:
                    mtime_ns = -1
                child_kind = "dir" if child.is_dir() else "file"
                children.append((child.name, child_kind, mtime_ns))
        signature.append((category_id, tuple(children)))
    return tuple(signature)


class ToolCatalogManager:
    """In-memory tool inventory grouped by category and asset type."""

    def __init__(self) -> None:
        self._entries: dict[str, _CatalogEntry] = {}
        self._lock = Lock()
        self._overview_cache: dict[str, Any] | None = None
        self._overview_inventory_signature: tuple[tuple[str, tuple[tuple[str, str, int], ...]], ...] | None = None
        self._static_inventory_cache: dict[str, dict[str, list[dict[str, Any]]]] | None = None
        self._static_inventory_signature: tuple[tuple[str, tuple[tuple[str, str, int], ...]], ...] | None = None

    def invalidate_cache(self) -> None:
        with self._lock:
            self._overview_cache = None
            self._overview_inventory_signature = None
            self._static_inventory_cache = None
            self._static_inventory_signature = None

    def register_tool(
        self,
        tool_obj: Any,
        origin: str,
        sandbox_status: str | None = None,
        category: str | None = None,
        load_pathway: str | None = None,
        execute_pathway: str | None = None,
        unload_pathway: str | None = None,
    ) -> None:
        name = _extract_tool_name(tool_obj)
        if not name:
            return
        path = _extract_tool_path(tool_obj)
        module_path = _extract_module_path(tool_obj)
        input_schema = _extract_input_schema(tool_obj)
        normalized_category = _normalize_category(category, path=path, module_path=module_path)
        entry = _CatalogEntry(
            name=name,
            description=_extract_tool_description(tool_obj),
            input_schema=input_schema,
            input_summary=_extract_input_summary(input_schema),
            origin=origin,
            category=normalized_category,
            path=path,
            module_path=module_path,
            load_pathway=load_pathway or _default_load_path(module_path, path),
            execute_pathway=execute_pathway or _default_execute_pathway(name),
            unload_pathway=unload_pathway or _default_unload_pathway(name),
            kind="tool",
        )
        with self._lock:
            self._entries[name] = entry
            self._overview_cache = None

    def register_tools(self, tools: list[Any], origin: str, category: str | None = None) -> None:
        for tool_obj in tools:
            self.register_tool(tool_obj, origin=origin, category=category)

    def register_entry(
        self,
        *,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        origin: str,
        category: str | None = None,
        path: str | None = None,
        module_path: str | None = None,
        load_pathway: str | None = None,
        execute_pathway: str | None = None,
        unload_pathway: str | None = None,
        kind: str = "tool",
        sandbox_status: str | None = None,
    ) -> None:
        normalized_category = _normalize_category(category, path=path, module_path=module_path)
        entry = _CatalogEntry(
            name=name,
            description=description,
            input_schema=input_schema or {},
            input_summary=_extract_input_summary(input_schema or {}),
            origin=origin,
            category=normalized_category,
            path=path,
            module_path=module_path,
            load_pathway=load_pathway or (_default_load_path(module_path, path) if kind == "tool" else None),
            execute_pathway=execute_pathway or (_default_execute_pathway(name) if kind == "tool" else None),
            unload_pathway=unload_pathway or (_default_unload_pathway(name) if kind == "tool" else None),
            kind=kind,
        )
        with self._lock:
            self._entries[name] = entry
            self._overview_cache = None

    def remove_tools(self, tool_names: list[str]) -> None:
        with self._lock:
            for name in tool_names:
                self._entries.pop(name, None)
            self._overview_cache = None

    def _discover_static_inventory(self) -> dict[str, dict[str, list[dict[str, Any]]]]:
        root = _inventory_root()
        current_signature = _inventory_signature(root)
        cached_inventory = self._static_inventory_cache
        if cached_inventory is not None and self._static_inventory_signature == current_signature:
            return cached_inventory

        inventory: dict[str, dict[str, list[dict[str, Any]]]] = {
            category_id: {"tools": [], "mcp_servers": [], "openapi_specs": []}
            for category_id in CATEGORY_IDS
        }

        for category_id in CATEGORY_IDS:
            category_dir = root / category_id
            if not category_dir.is_dir():
                continue

            tool_entries: list[dict[str, Any]] = []
            mcp_entries: list[dict[str, Any]] = []
            openapi_entries: list[dict[str, Any]] = []

            for child in sorted(category_dir.iterdir(), key=lambda item: item.name.lower()):
                if child.name == "__pycache__":
                    continue
                if child.is_file():
                    if child.suffix == ".py" and child.name != "__init__.py":
                        tool_entries.extend(_static_tool_entries_from_module(child, category_id))
                        continue
                    if child.suffix.lower() in _OPENAPI_SUFFIXES:
                        metadata = _openapi_metadata(child)
                        if metadata is not None:
                            openapi_entries.append(_openapi_spec_entry(child, category_id, metadata))
                        continue
                if child.is_dir() and _is_mcp_server_dir(child):
                    mcp_entries.append(_mcp_server_entry(child, category_id))

            inventory[category_id]["tools"] = _dedupe_tool_entries(tool_entries)
            inventory[category_id]["mcp_servers"] = _dedupe_named_entries(mcp_entries, priority=_mcp_priority)
            inventory[category_id]["openapi_specs"] = _dedupe_named_entries(openapi_entries, priority=_openapi_priority)

        self._static_inventory_cache = inventory
        self._static_inventory_signature = current_signature
        return inventory

    def build_catalog_overview(self) -> dict[str, Any]:
        current_signature = _inventory_signature(_inventory_root())
        with self._lock:
            if (
                self._overview_cache is not None
                and self._overview_inventory_signature == current_signature
            ):
                return self._overview_cache
            runtime_tool_entries = [entry.to_dict() for entry in self._entries.values() if entry.kind == "tool"]

        static_inventory = self._discover_static_inventory()
        categories: list[dict[str, Any]] = []
        for category_id, label in _CATEGORY_ORDER:
            static_tools = list(static_inventory.get(category_id, {}).get("tools", []))
            merged_tools = {entry["name"]: dict(entry) for entry in static_tools}
            for runtime_entry in runtime_tool_entries:
                if runtime_entry.get("category") != category_id:
                    continue
                existing = merged_tools.get(runtime_entry["name"])
                merged_tools[runtime_entry["name"]] = (
                    _merge_catalog_records(runtime_entry, existing) if existing else dict(runtime_entry)
                )

            category_tools = sorted(merged_tools.values(), key=lambda item: item.get("name", ""))
            category_mcp = list(static_inventory.get(category_id, {}).get("mcp_servers", []))
            category_specs = list(static_inventory.get(category_id, {}).get("openapi_specs", []))
            categories.append(
                {
                    "id": category_id,
                    "label": label,
                    "tools": category_tools,
                    "mcp_servers": category_mcp,
                    "openapi_specs": category_specs,
                    "count": {
                        "tools": len(category_tools),
                        "mcp_servers": len(category_mcp),
                        "openapi_specs": len(category_specs),
                        "total": len(category_tools) + len(category_mcp) + len(category_specs),
                    },
                }
            )

        overview = {
            "schema_version": 4,
            "inventory_root": str(_inventory_root()),
            "categories": categories,
            "count": {
                "categories": len(categories),
                "tools": sum(item["count"]["tools"] for item in categories),
                "mcp_servers": sum(item["count"]["mcp_servers"] for item in categories),
                "openapi_specs": sum(item["count"]["openapi_specs"] for item in categories),
            },
        }
        with self._lock:
            self._overview_cache = overview
            self._overview_inventory_signature = current_signature
        return overview

    def get_tools_by_functional_category(self, category_id: str) -> list[dict[str, Any]]:
        normalized = _normalize_category(category_id)
        for category in self.build_catalog_overview()["categories"]:
            if category["id"] == normalized:
                return list(category["tools"])
        return []

    def get_tool_details(self, tool_name: str) -> dict[str, Any] | None:
        with self._lock:
            runtime_entry = self._entries.get(tool_name)
            runtime_payload = runtime_entry.to_dict() if runtime_entry is not None else None

        static_inventory = self._discover_static_inventory()
        static_tool_payload = None
        for category_id in CATEGORY_IDS:
            for item in static_inventory.get(category_id, {}).get("tools", []):
                if item["name"] == tool_name:
                    static_tool_payload = item
                    break
            if static_tool_payload is not None:
                break

        if runtime_payload is not None and static_tool_payload is not None:
            return _merge_catalog_records(runtime_payload, static_tool_payload)
        if runtime_payload is not None:
            return runtime_payload
        if static_tool_payload is not None:
            return dict(static_tool_payload)

        for bucket in ("mcp_servers", "openapi_specs"):
            for category_id in CATEGORY_IDS:
                for item in static_inventory.get(category_id, {}).get(bucket, []):
                    if item["name"] == tool_name:
                        return dict(item)
        return None


_MANAGER: ToolCatalogManager | None = None


def get_tool_catalog_manager() -> ToolCatalogManager:
    global _MANAGER
    if _MANAGER is None:
        _MANAGER = ToolCatalogManager()
    return _MANAGER
