"""Unified tool catalog: discover, inspect, execute, and manage tools and toolsets."""

from __future__ import annotations

import importlib.util
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from strands import ToolContext, tool

from strands_tools.agent_orchestration.tool_catalog_manager import (
    _inventory_root,
    get_tool_catalog_manager,
)

logger = logging.getLogger(__name__)
_MAX_TOOLSET_SIZE = 10
_TOOLSET_SCHEMA_VERSION = 1
_TOOLSET_STORE_FILENAME = ".tool_catalog_toolsets.json"


def _tool_method_name(name: str) -> str:
    """Map a tool name to the direct-call attribute name used by Strands agents."""
    return name.replace("-", "_")


def _tool_registry_names(name: str) -> list[str]:
    method_name = _tool_method_name(name)
    if method_name == name:
        return [name]
    return [name, method_name]


def _toolset_store_path() -> Path:
    """Store persistent toolset definitions under vendored meta-tooling."""
    meta_tooling_dir = _inventory_root() / "meta-tooling"
    meta_tooling_dir.mkdir(parents=True, exist_ok=True)
    return meta_tooling_dir / _TOOLSET_STORE_FILENAME


def _empty_toolset_store() -> dict[str, Any]:
    return {"schema_version": _TOOLSET_SCHEMA_VERSION, "toolsets": {}}


def _read_toolset_store() -> dict[str, Any]:
    path = _toolset_store_path()
    if not path.exists():
        return _empty_toolset_store()

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Failed to read toolset store at {path}: {exc}") from exc

    if not isinstance(payload, dict):
        raise RuntimeError(f"Toolset store at {path} must contain a JSON object")

    raw_toolsets = payload.get("toolsets", {})
    if not isinstance(raw_toolsets, dict):
        raise RuntimeError(f"Toolset store at {path} has an invalid 'toolsets' section")

    toolsets: dict[str, dict[str, Any]] = {}
    for raw_name, raw_entry in raw_toolsets.items():
        if not isinstance(raw_name, str):
            continue
        name = raw_name.strip()
        if not name or not isinstance(raw_entry, dict):
            continue
        description = raw_entry.get("description", "")
        raw_tool_names = raw_entry.get("tool_names", [])
        if not isinstance(description, str) or not isinstance(raw_tool_names, list):
            continue
        toolsets[name] = {
            "description": description.strip(),
            "tool_names": [str(item).strip() for item in raw_tool_names if str(item).strip()],
        }

    return {
        "schema_version": int(payload.get("schema_version", _TOOLSET_SCHEMA_VERSION)),
        "toolsets": toolsets,
    }


def _write_toolset_store(store: dict[str, Any]) -> None:
    path = _toolset_store_path()
    temp_path = path.with_name(f"{path.name}.tmp")
    payload = json.dumps(store, indent=2, sort_keys=True)
    temp_path.write_text(f"{payload}\n", encoding="utf-8")
    temp_path.replace(path)


def _toolset_string(value: str) -> str:
    return json.dumps(value)


def _normalize_toolset_name(name: str | None) -> str:
    normalized = (name or "").strip()
    if not normalized:
        raise ValueError("name is required")
    return normalized


def _normalize_tool_names(tool_names: list[str] | None) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for item in tool_names or []:
        name = str(item).strip()
        if not name or name in seen:
            continue
        normalized.append(name)
        seen.add(name)
    return normalized


def _resolve_toolset_members(
    catalog: Any,
    tool_names: list[str],
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    resolved: list[dict[str, Any]] = []
    missing: list[str] = []
    non_tools: list[str] = []

    for tool_name in tool_names:
        details = catalog.get_tool_details(tool_name)
        if details is None:
            missing.append(tool_name)
            continue
        if details.get("kind") != "tool":
            non_tools.append(tool_name)
            continue
        resolved.append(details)
    return resolved, missing, non_tools


def _validated_tool_names(catalog: Any, tool_names: list[str] | None) -> list[str]:
    normalized = _normalize_tool_names(tool_names)
    if not normalized:
        raise ValueError("tool_names must include at least one discoverable tool")
    if len(normalized) > _MAX_TOOLSET_SIZE:
        raise ValueError(f"toolsets support at most {_MAX_TOOLSET_SIZE} tools")

    _, missing, non_tools = _resolve_toolset_members(catalog, normalized)
    if missing:
        raise ValueError(f"unknown tools: {', '.join(missing)}")
    if non_tools:
        raise ValueError(f"only tools can be added to a toolset: {', '.join(non_tools)}")
    return normalized


def _toolset_record(catalog: Any, name: str, definition: dict[str, Any]) -> dict[str, Any]:
    tool_names = _normalize_tool_names(definition.get("tool_names", []))
    resolved_tools, missing_tools, non_tools = _resolve_toolset_members(catalog, tool_names)
    store_path = str(_toolset_store_path())
    return {
        "name": name,
        "description": definition.get("description", ""),
        "tool_names": tool_names,
        "tool_count": len(tool_names),
        "tools": resolved_tools,
        "missing_tools": missing_tools,
        "invalid_members": non_tools,
        "kind": "toolset",
        "origin": "persistent",
        "path": store_path,
        "load_pathway": f"tool_catalog(action='load_toolset', name={_toolset_string(name)})",
        "unload_pathway": f"tool_catalog(action='unload_toolset', name={_toolset_string(name)})",
        "update_pathway": (
            f"tool_catalog(action='update_toolset', name={_toolset_string(name)}, "
            "tool_names=[...], description='...')"
        ),
        "delete_pathway": f"tool_catalog(action='delete_toolset', name={_toolset_string(name)})",
    }


def _list_toolset_records(catalog: Any) -> list[dict[str, Any]]:
    store = _read_toolset_store()
    toolsets = store["toolsets"]
    return [_toolset_record(catalog, name, toolsets[name]) for name in sorted(toolsets)]


def _get_toolset_record(catalog: Any, name: str) -> dict[str, Any] | None:
    normalized_name = _normalize_toolset_name(name)
    toolsets = _read_toolset_store()["toolsets"]
    definition = toolsets.get(normalized_name)
    if definition is None:
        return None
    return _toolset_record(catalog, normalized_name, definition)


def _save_toolset(
    catalog: Any,
    *,
    name: str,
    description: str | None,
    tool_names: list[str] | None,
    require_existing: bool,
) -> dict[str, Any]:
    normalized_name = _normalize_toolset_name(name)
    normalized_description = (description or "").strip()
    normalized_tool_names = _validated_tool_names(catalog, tool_names)

    store = _read_toolset_store()
    exists = normalized_name in store["toolsets"]
    if require_existing and not exists:
        raise ValueError(f"toolset not found: {normalized_name}")
    if not require_existing and exists:
        raise ValueError(f"toolset already exists: {normalized_name}")

    store["toolsets"][normalized_name] = {
        "description": normalized_description,
        "tool_names": normalized_tool_names,
    }
    _write_toolset_store(store)
    return _toolset_record(catalog, normalized_name, store["toolsets"][normalized_name])


def _delete_toolset(name: str) -> dict[str, Any]:
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
        "path": str(_toolset_store_path()),
        "deleted": True,
    }


def _load_entries(agent: Any, entries: list[dict[str, Any]]) -> tuple[list[str], list[dict[str, str]]]:
    loaded: list[str] = []
    errors: list[dict[str, str]] = []
    for entry in entries:
        tool_name = entry.get("name", "")
        load_path = _resolve_load_path(entry)
        if not load_path or not tool_name:
            errors.append({"name": tool_name, "error": "no load path"})
            continue
        try:
            _load_tool(agent, tool_name, load_path)
            loaded.append(tool_name)
        except Exception as exc:
            errors.append({"name": tool_name, "error": str(exc)})
    return loaded, errors


def _unload_names(agent: Any, tool_names: list[str]) -> tuple[list[str], list[dict[str, str]]]:
    unloaded: list[str] = []
    errors: list[dict[str, str]] = []
    for tool_name in tool_names:
        if not tool_name:
            continue
        try:
            _unload_tool(agent, tool_name)
            unloaded.append(tool_name)
        except Exception as exc:
            errors.append({"name": tool_name, "error": str(exc)})
    return unloaded, errors


def _loaded_toolsets_map(agent: Any) -> dict[str, list[str]]:
    registry = getattr(agent, "tool_registry", None)
    if registry is None:
        return {}
    loaded_toolsets = getattr(registry, "_catalog_loaded_toolsets", None)
    if not isinstance(loaded_toolsets, dict):
        loaded_toolsets = {}
        registry._catalog_loaded_toolsets = loaded_toolsets
    return loaded_toolsets


def _list_toolsets_result(catalog: Any) -> dict[str, Any]:
    try:
        toolsets = _list_toolset_records(catalog)
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    return {
        "status": "success",
        "content": [
            {
                "json": {
                    "toolsets": toolsets,
                    "count": len(toolsets),
                    "path": str(_toolset_store_path()),
                }
            }
        ],
    }


def _get_toolset_result(catalog: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for get_toolset"}]}
    try:
        record = _get_toolset_record(catalog, name)
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    if record is None:
        return {"status": "error", "content": [{"text": f"Toolset not found: {name}"}]}
    return {"status": "success", "content": [{"json": record}]}


def _create_toolset_result(
    catalog: Any,
    *,
    name: str | None,
    description: str | None,
    tool_names: list[str] | None,
) -> dict[str, Any]:
    try:
        record = _save_toolset(
            catalog,
            name=name,
            description=description,
            tool_names=tool_names,
            require_existing=False,
        )
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    return {"status": "success", "content": [{"json": record}]}


def _update_toolset_result(
    catalog: Any,
    *,
    name: str | None,
    description: str | None,
    tool_names: list[str] | None,
) -> dict[str, Any]:
    try:
        record = _save_toolset(
            catalog,
            name=name,
            description=description,
            tool_names=tool_names,
            require_existing=True,
        )
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    return {"status": "success", "content": [{"json": record}]}


def _delete_toolset_result(name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for delete_toolset"}]}
    try:
        deleted = _delete_toolset(name)
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}
    return {"status": "success", "content": [{"json": deleted}]}


def _load_toolset_result(catalog: Any, agent: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for load_toolset"}]}

    try:
        toolset = _get_toolset_record(catalog, name)
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}

    if toolset is not None:
        member_count = len(toolset["tool_names"])
        if member_count > _MAX_TOOLSET_SIZE:
            return {
                "status": "error",
                "content": [{"text": f"Toolset '{name}' exceeds the {_MAX_TOOLSET_SIZE}-tool limit"}],
            }
        loaded, errors = _load_entries(agent, list(toolset["tools"]))
        for missing_name in toolset["missing_tools"]:
            errors.append({"name": missing_name, "error": "tool not found in catalog"})
        for invalid_name in toolset["invalid_members"]:
            errors.append({"name": invalid_name, "error": "catalog entry is not a tool"})
        summary = f"Loaded {len(loaded)}/{member_count} tools from toolset '{name}'"
        if errors:
            summary += f" ({len(errors)} failed)"
        _loaded_toolsets_map(agent)[name] = list(loaded)
        return {
            "status": "success" if loaded else "error",
            "content": [
                {
                    "json": {
                        "summary": summary,
                        "loaded": loaded,
                        "errors": errors,
                        "toolset": toolset,
                    }
                }
            ],
        }

    category_tools = catalog.get_tools_by_functional_category(name)
    if not category_tools:
        return {"status": "error", "content": [{"text": f"No toolset or category found: {name}"}]}
    loaded, errors = _load_entries(agent, category_tools)
    summary = f"Loaded {len(loaded)}/{len(category_tools)} tools from category '{name}'"
    if errors:
        summary += f" ({len(errors)} failed)"
    _loaded_toolsets_map(agent)[name] = list(loaded)
    return {
        "status": "success" if loaded else "error",
        "content": [{"json": {"summary": summary, "loaded": loaded, "errors": errors}}],
    }


def _unload_toolset_result(catalog: Any, agent: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for unload_toolset"}]}

    loaded_toolsets = _loaded_toolsets_map(agent)
    stored_tool_names = loaded_toolsets.get(name)

    try:
        toolset = _get_toolset_record(catalog, name)
    except Exception as exc:
        return {"status": "error", "content": [{"text": str(exc)}]}

    if stored_tool_names is not None:
        unloaded, errors = _unload_names(agent, list(stored_tool_names))
        remaining = [tool_name for tool_name in stored_tool_names if tool_name not in unloaded]
        if remaining:
            loaded_toolsets[name] = remaining
        else:
            loaded_toolsets.pop(name, None)
        summary = f"Unloaded {len(unloaded)}/{len(stored_tool_names)} tools from loaded toolset '{name}'"
        if errors:
            summary += f" ({len(errors)} failed)"
        return {
            "status": "success" if unloaded else "error",
            "content": [
                {
                    "json": {
                        "summary": summary,
                        "unloaded": unloaded,
                        "errors": errors,
                        "toolset": toolset,
                    }
                }
            ],
        }

    if toolset is not None:
        member_count = len(toolset["tool_names"])
        if member_count > _MAX_TOOLSET_SIZE:
            return {
                "status": "error",
                "content": [{"text": f"Toolset '{name}' exceeds the {_MAX_TOOLSET_SIZE}-tool limit"}],
            }
        unloaded, errors = _unload_names(agent, list(toolset["tool_names"]))
        summary = f"Unloaded {len(unloaded)}/{member_count} tools from toolset '{name}'"
        if errors:
            summary += f" ({len(errors)} failed)"
        remaining = [tool_name for tool_name in toolset["tool_names"] if tool_name not in unloaded]
        if remaining:
            loaded_toolsets[name] = remaining
        else:
            loaded_toolsets.pop(name, None)
        return {
            "status": "success" if unloaded else "error",
            "content": [
                {
                    "json": {
                        "summary": summary,
                        "unloaded": unloaded,
                        "errors": errors,
                        "toolset": toolset,
                    }
                }
            ],
        }

    category_tools = catalog.get_tools_by_functional_category(name)
    if not category_tools:
        return {"status": "error", "content": [{"text": f"No toolset or category found: {name}"}]}
    unloaded, errors = _unload_names(agent, [entry.get("name", "") for entry in category_tools])
    summary = f"Unloaded {len(unloaded)}/{len(category_tools)} tools from category '{name}'"
    if errors:
        summary += f" ({len(errors)} failed)"
    remaining = [entry.get("name", "") for entry in category_tools if entry.get("name", "") not in unloaded]
    if remaining:
        loaded_toolsets[name] = remaining
    else:
        loaded_toolsets.pop(name, None)
    return {
        "status": "success" if unloaded else "error",
        "content": [{"json": {"summary": summary, "unloaded": unloaded, "errors": errors}}],
    }


@tool
def list_toolsets() -> dict[str, Any]:
    """
    List all persistent named toolsets known to the catalog.

    Use this when you need to discover reusable cross-category tool bundles that
    can be assigned to future tasks or subagents.

    Returns:
        ToolResult-style response containing toolset records and the persistent store path.
    """
    return _list_toolsets_result(get_tool_catalog_manager())


@tool
def get_toolset(name: str) -> dict[str, Any]:
    """
    Inspect one persistent named toolset.

    Args:
        name: Toolset name to retrieve.

    Returns:
        ToolResult-style response containing the toolset definition and resolved tools.
    """
    return _get_toolset_result(get_tool_catalog_manager(), name)


@tool
def create_toolset(name: str, tool_names: list[str], description: str = "") -> dict[str, Any]:
    """
    Create a persistent named toolset from discoverable catalog tools.

    Use this to define a reusable tool bundle for a specific workflow or subagent.
    Toolsets may include tools from any category and support up to 10 tools.

    Args:
        name: Stable toolset name.
        tool_names: Discoverable tool names to include.
        description: Optional human-readable description of the toolset's purpose.

    Returns:
        ToolResult-style response containing the saved toolset record.
    """
    return _create_toolset_result(
        get_tool_catalog_manager(),
        name=name,
        description=description,
        tool_names=tool_names,
    )


@tool
def update_toolset(name: str, tool_names: list[str], description: str = "") -> dict[str, Any]:
    """
    Replace the members and description of an existing persistent toolset.

    Args:
        name: Existing toolset name.
        tool_names: Replacement set of discoverable tool names.
        description: Optional updated description.

    Returns:
        ToolResult-style response containing the updated toolset record.
    """
    return _update_toolset_result(
        get_tool_catalog_manager(),
        name=name,
        description=description,
        tool_names=tool_names,
    )


@tool
def delete_toolset(name: str) -> dict[str, Any]:
    """
    Delete a persistent named toolset.

    Args:
        name: Toolset name to delete.

    Returns:
        ToolResult-style response describing the deleted toolset.
    """
    return _delete_toolset_result(name)


@tool(context=True)
def load_toolset(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """
    Load a named toolset into the current agent registry.

    If no named toolset exists with the provided name, this falls back to loading
    every discoverable tool in the matching catalog category for backward compatibility.

    Args:
        tool_context: Strands tool context for the active agent.
        name: Toolset name or category id.

    Returns:
        ToolResult-style response containing loaded tool names and any errors.
    """
    return _load_toolset_result(get_tool_catalog_manager(), tool_context.agent, name)


@tool(context=True)
def unload_toolset(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """
    Unload a named toolset from the current agent registry.

    If no named toolset exists with the provided name, this falls back to unloading
    every discoverable tool in the matching catalog category for backward compatibility.

    Args:
        tool_context: Strands tool context for the active agent.
        name: Toolset name or category id.

    Returns:
        ToolResult-style response containing unloaded tool names and any errors.
    """
    return _unload_toolset_result(get_tool_catalog_manager(), tool_context.agent, name)


def _resolve_load_path(details: dict[str, Any]) -> str | None:
    """Determine the best load path for a tool from its catalog entry.

    Prefers module_path (e.g. 'strands_tools.perplexity_search_api') because
    it handles sub-packages with relative imports correctly.  Falls back to
    the file-system path for standalone tool files.
    """
    module_path = details.get("module_path")
    if module_path and _is_importable_module_path(module_path):
        return module_path
    return details.get("path") or module_path


def _is_importable_module_path(module_path: str) -> bool:
    try:
        return importlib.util.find_spec(module_path) is not None
    except (AttributeError, ImportError, ModuleNotFoundError, ValueError):
        return False


def _load_tool(agent: Any, name: str, load_path: str) -> None:
    """Load a tool into the agent using process_tools (non-deprecated SDK pattern).

    *load_path* can be either a filesystem path or a dotted module path;
    ``process_tools`` handles both transparently.
    """
    if _is_tool_loaded(agent, name):
        return
    agent.tool_registry.process_tools([load_path])


def _is_tool_loaded(agent: Any, name: str) -> bool:
    registry = getattr(getattr(agent, "tool_registry", None), "registry", {})
    if not isinstance(registry, dict):
        return False
    return any(registry_name in registry for registry_name in _tool_registry_names(name))


def _unload_tool(agent: Any, name: str) -> None:
    """Remove a tool from the agent's registry."""
    registry = agent.tool_registry
    for registry_name in _tool_registry_names(name):
        registry.registry.pop(registry_name, None)
    if hasattr(registry, "dynamic_tools") and isinstance(registry.dynamic_tools, dict):
        for registry_name in _tool_registry_names(name):
            registry.dynamic_tools.pop(registry_name, None)
    # Invalidate cached tool config so next call rebuilds it
    if hasattr(registry, "tool_config"):
        registry.tool_config = None


def _execute_loaded_tool(agent: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Invoke a tool that is already present in the registry."""
    try:
        caller = getattr(agent.tool, _tool_method_name(name))
        result = caller(record_direct_tool_call=False, **arguments)
        return {"name": name, "result": result}
    except Exception as exc:
        return {"name": name, "error": str(exc)}


def _execute_one(agent: Any, name: str, arguments: dict[str, Any], load_path: str) -> dict[str, Any]:
    """Load a tool if needed, invoke it, then unload it if this call loaded it."""
    loaded_here = False
    try:
        loaded_here = not _is_tool_loaded(agent, name)
        if loaded_here:
            _load_tool(agent, name, load_path)
        return _execute_loaded_tool(agent, name, arguments)
    finally:
        if loaded_here:
            _unload_tool(agent, name)


def _list_categories_result(catalog: Any) -> dict[str, Any]:
    base_overview = catalog.build_catalog_overview()
    overview = dict(base_overview)
    count = dict(base_overview.get("count", {}))
    try:
        toolsets = _list_toolset_records(catalog)
        overview["toolsets"] = toolsets
        overview["toolsets_store"] = str(_toolset_store_path())
        count["toolsets"] = len(toolsets)
    except Exception as exc:
        overview["toolsets"] = []
        overview["toolsets_store"] = str(_toolset_store_path())
        overview["toolsets_error"] = str(exc)
        count["toolsets"] = 0
    overview["count"] = count
    return {"status": "success", "content": [{"json": overview}]}


def _get_tool_result(catalog: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for get_tool"}]}
    details = catalog.get_tool_details(name)
    if not details:
        return {"status": "error", "content": [{"text": f"Tool not found: {name}"}]}
    return {"status": "success", "content": [{"json": details}]}


def _execute_result(
    catalog: Any,
    agent: Any,
    *,
    name: str | None,
    arguments: dict[str, Any] | None,
    tools: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    invocations: list[dict[str, Any]] = []
    if tools and isinstance(tools, list):
        invocations = tools
    elif name:
        invocations = [{"name": name, "arguments": arguments or {}}]
    else:
        return {"status": "error", "content": [{"text": "execute requires name or tools list"}]}

    resolved: list[dict[str, Any]] = []
    for inv in invocations:
        tool_name = inv.get("name", "")
        details = catalog.get_tool_details(tool_name)
        load_path = _resolve_load_path(details) if details else None
        if not load_path:
            return {"status": "error", "content": [{"text": f"No path found for tool: {tool_name}"}]}
        resolved.append({
            "name": tool_name,
            "arguments": inv.get("arguments") or {},
            "load_path": load_path,
        })

    if len(resolved) == 1:
        resolved_item = resolved[0]
        result = _execute_one(agent, resolved_item["name"], resolved_item["arguments"], resolved_item["load_path"])
        if "error" in result:
            return {"status": "error", "content": [{"text": f"{resolved_item['name']}: {result['error']}"}]}
        return {"status": "success", "content": [{"json": result["result"]}]}

    newly_loaded: list[str] = []
    load_errors: dict[str, str] = {}
    seen_names: set[str] = set()

    try:
        for invocation in resolved:
            tool_name = invocation["name"]
            if tool_name in seen_names:
                continue
            seen_names.add(tool_name)
            if _is_tool_loaded(agent, tool_name):
                continue
            try:
                _load_tool(agent, tool_name, invocation["load_path"])
                newly_loaded.append(tool_name)
            except Exception as exc:
                load_errors[tool_name] = str(exc)

        results: list[dict[str, Any]] = [None] * len(resolved)  # type: ignore[list-item]
        max_workers = min(len(resolved), _MAX_TOOLSET_SIZE)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {}
            for index, invocation in enumerate(resolved):
                tool_name = invocation["name"]
                if tool_name in load_errors:
                    results[index] = {"name": tool_name, "error": load_errors[tool_name]}
                    continue
                future = executor.submit(
                    _execute_loaded_tool,
                    agent,
                    tool_name,
                    invocation["arguments"],
                )
                future_map[future] = index

            for future, index in future_map.items():
                results[index] = future.result()

        status = "success" if any("result" in item for item in results if item) else "error"
        return {"status": status, "content": [{"json": results}]}
    finally:
        for tool_name in reversed(newly_loaded):
            _unload_tool(agent, tool_name)


def _load_tool_result(catalog: Any, agent: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for load"}]}
    details = catalog.get_tool_details(name)
    load_path = _resolve_load_path(details) if details else None
    if not load_path:
        return {"status": "error", "content": [{"text": f"No path found for tool: {name}"}]}
    try:
        already_loaded = _is_tool_loaded(agent, name)
        _load_tool(agent, name, load_path)
        if already_loaded:
            return {"status": "success", "content": [{"text": f"Tool already loaded: {name}"}]}
        return {"status": "success", "content": [{"text": f"Loaded tool: {name}"}]}
    except Exception as exc:
        return {"status": "error", "content": [{"text": f"Failed to load {name}: {exc}"}]}


def _unload_tool_result(agent: Any, name: str | None) -> dict[str, Any]:
    if not name:
        return {"status": "error", "content": [{"text": "name is required for unload"}]}
    try:
        _unload_tool(agent, name)
        return {"status": "success", "content": [{"text": f"Unloaded tool: {name}"}]}
    except Exception as exc:
        return {"status": "error", "content": [{"text": f"Failed to unload {name}: {exc}"}]}


@tool
def list_catalog_categories() -> dict[str, Any]:
    """
    List the full tool catalog grouped by vendored Strands category.

    This returns category inventory split into tools, MCP servers, and OpenAPI specs,
    plus persistent named toolsets stored by the catalog.

    Returns:
        ToolResult-style response containing the current catalog overview.
    """
    return _list_categories_result(get_tool_catalog_manager())


@tool
def get_catalog_tool(name: str) -> dict[str, Any]:
    """
    Inspect one cataloged tool, MCP server, or OpenAPI spec by name.

    Args:
        name: Catalog entry name to inspect.

    Returns:
        ToolResult-style response containing the matching catalog entry details.
    """
    return _get_tool_result(get_tool_catalog_manager(), name)


@tool(context=True)
def execute_catalog_tool(
    tool_context: ToolContext,
    name: str | None = None,
    arguments: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Execute one or more cataloged tools by loading them from their real catalog paths.

    Use `name` plus `arguments` for a single tool call, or `tools` for a concurrent
    batch of `{name, arguments}` requests.

    Args:
        tool_context: Strands tool context for the active agent.
        name: Tool name for a single execution request.
        arguments: Keyword arguments for the single-tool request.
        tools: Optional list of tool execution requests.

    Returns:
        ToolResult-style response containing the tool result or batch results.
    """
    return _execute_result(
        get_tool_catalog_manager(),
        tool_context.agent,
        name=name,
        arguments=arguments,
        tools=tools,
    )


@tool(context=True)
def load_catalog_tool(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """
    Load one cataloged tool into the current agent for repeated use.

    Args:
        tool_context: Strands tool context for the active agent.
        name: Cataloged tool name to load.

    Returns:
        ToolResult-style response describing the load outcome.
    """
    return _load_tool_result(get_tool_catalog_manager(), tool_context.agent, name)


@tool(context=True)
def unload_catalog_tool(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """
    Unload one cataloged tool from the current agent registry.

    Args:
        tool_context: Strands tool context for the active agent.
        name: Cataloged tool name to unload.

    Returns:
        ToolResult-style response describing the unload outcome.
    """
    return _unload_tool_result(tool_context.agent, name)


@tool(context=True)
def tool_catalog(
    tool_context: ToolContext,
    action: str,
    name: str | None = None,
    arguments: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    description: str | None = None,
    tool_names: list[str] | None = None,
) -> dict[str, Any]:
    """
    Unified tool lifecycle interface for tools and persistent toolsets.

    Use this tool to discover cataloged tools, inspect tool metadata, execute tools,
    load or unload tools into the current agent, and manage persistent named toolsets
    that can later be assigned to subagents.

    Actions:
      - list_categories: returns the vendored category inventory plus persistent toolsets.
      - get_tool: returns full details for a tool by name.
      - list_toolsets: returns all persistent toolsets. Prefer the dedicated list_toolsets tool.
      - get_toolset: returns one persistent toolset by name. Prefer the dedicated get_toolset tool.
      - create_toolset: create a persistent toolset. Prefer the dedicated create_toolset tool.
      - update_toolset: replace an existing persistent toolset. Prefer the dedicated update_toolset tool.
      - delete_toolset: delete a persistent toolset. Prefer the dedicated delete_toolset tool.
      - execute: fire-and-forget execution. For a single tool provide name and arguments.
        For multiple tools provide tools as a list of {name, arguments}; the catalog
        loads any missing tools, executes the calls concurrently, and unloads only the
        tools it loaded for the batch.
      - load: load one tool into the agent for repeated use. Provide name.
      - unload: remove one loaded tool from the agent. Provide name.
      - load_toolset: load a persistent toolset by name. Prefer the dedicated load_toolset
        tool. If no toolset exists with that name, it falls back to loading every tool in
        the matching category id.
      - unload_toolset: unload a persistent toolset by name. Prefer the dedicated
        unload_toolset tool. If no toolset exists with that name, it falls back to
        unloading every tool in the matching category id.

    Args:
        tool_context: Strands tool execution context for the current agent.
        action: Catalog action to perform.
        name: Tool name, toolset name, or category id depending on action.
        arguments: Tool arguments for single-tool execute.
        tools: Multi-tool execute payload as a list of {name, arguments}.
        description: Optional description for create_toolset or update_toolset.
        tool_names: Tool names for create_toolset or update_toolset. Supports up to 10 tools.

    Returns:
        A ToolResult-style dictionary containing status plus JSON or text content.
    """
    catalog = get_tool_catalog_manager()
    agent = tool_context.agent

    # --- discover ---
    if action == "list_categories":
        return _list_categories_result(catalog)

    if action == "get_tool":
        return _get_tool_result(catalog, name)

    if action == "list_toolsets":
        return _list_toolsets_result(catalog)

    if action == "get_toolset":
        return _get_toolset_result(catalog, name)

    if action == "create_toolset":
        return _create_toolset_result(
            catalog,
            name=name,
            description=description,
            tool_names=tool_names,
        )

    if action == "update_toolset":
        return _update_toolset_result(
            catalog,
            name=name,
            description=description,
            tool_names=tool_names,
        )

    if action == "delete_toolset":
        return _delete_toolset_result(name)

    # --- execute (fire-and-forget, single or parallel) ---
    if action == "execute":
        return _execute_result(catalog, agent, name=name, arguments=arguments, tools=tools)

    # --- load (for repeated use) ---
    if action == "load":
        return _load_tool_result(catalog, agent, name)

    # --- unload ---
    if action == "unload":
        return _unload_tool_result(agent, name)

    # --- load_toolset (batch load entire category) ---
    if action == "load_toolset":
        return _load_toolset_result(catalog, agent, name)

    # --- unload_toolset (batch unload entire category) ---
    if action == "unload_toolset":
        return _unload_toolset_result(catalog, agent, name)

    return {"status": "error", "content": [{"text": f"Unsupported action: {action}"}]}
