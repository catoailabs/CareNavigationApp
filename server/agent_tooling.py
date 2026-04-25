from __future__ import annotations

import importlib.util
from collections.abc import Sequence
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]

PROVIDER_TOOL_PATHS = {
    "npiLookup": PROJECT_ROOT / "tools/ronbrowser_agent_tools/src/strands_tools/healthcare/npiLookup.py",
    "perplexity_search_api": PROJECT_ROOT
    / "tools/ronbrowser_agent_tools/src/strands_tools/research/perplexity_search_api.py",
    "perplexity_deep_research": PROJECT_ROOT
    / "tools/ronbrowser_agent_tools/src/strands_tools/research/perplexity_deep_research.py",
}

# `server.tool_catalog_support` and the existing unit tests still import the
# baseline registry under this name.
BASELINE_TOOL_REGISTRY = PROVIDER_TOOL_PATHS

_LOADED_PROVIDER_TOOLS: dict[str, Any] = {}


def _load_provider_tool(tool_name: str) -> Any:
    cached = _LOADED_PROVIDER_TOOLS.get(tool_name)
    if cached is not None:
        return cached

    tool_path = PROVIDER_TOOL_PATHS[tool_name]
    if not tool_path.exists():
        raise RuntimeError(f"Provider tool '{tool_name}' is missing at {tool_path}.")

    spec = importlib.util.spec_from_file_location(f"_provider_tool_{tool_name}", tool_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load provider tool '{tool_name}' from {tool_path}.")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    tool = getattr(module, tool_name, None)
    if tool is None:
        raise RuntimeError(f"Provider tool '{tool_name}' was not found in {tool_path}.")

    _LOADED_PROVIDER_TOOLS[tool_name] = tool
    return tool


def validate_baseline_tooling() -> None:
    for tool_name in PROVIDER_TOOL_PATHS:
        _load_provider_tool(tool_name)


def build_baseline_tools() -> Sequence[Any]:
    validate_baseline_tooling()
    return [_load_provider_tool(tool_name) for tool_name in PROVIDER_TOOL_PATHS]
