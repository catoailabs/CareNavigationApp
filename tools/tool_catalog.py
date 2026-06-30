from __future__ import annotations

from typing import Any

from strands import Agent, ToolContext, tool

import server.tool_catalog_support as catalog_support


@tool(context=True)
def list_catalog_categories(tool_context: ToolContext) -> dict[str, Any]:
    """List the catalog inventory grouped into tool, MCP, and OpenAPI categories."""
    return catalog_support.list_categories_result(tool_context.agent)


@tool(context=True)
def get_catalog_tool(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """Inspect one cataloged tool, MCP server, or OpenAPI spec by name."""
    return catalog_support.get_tool_result(tool_context.agent, name)


@tool(context=True)
def list_toolsets(tool_context: ToolContext) -> dict[str, Any]:
    """List persistent catalog toolsets stored on disk."""
    return catalog_support.list_toolsets_result(tool_context.agent)


@tool(context=True)
def get_toolset(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """Inspect one persistent toolset by name."""
    return catalog_support.get_toolset_result(tool_context.agent, name)


@tool(context=True)
def create_toolset(
    tool_context: ToolContext,
    name: str,
    tool_names: list[str],
    description: str = "",
) -> dict[str, Any]:
    """Create a persistent toolset from cataloged tool names."""
    return catalog_support.create_toolset_result(
        tool_context.agent,
        name=name,
        description=description,
        tool_names=tool_names,
    )


@tool(context=True)
def update_toolset(
    tool_context: ToolContext,
    name: str,
    tool_names: list[str],
    description: str = "",
) -> dict[str, Any]:
    """Replace the members and description of an existing persistent toolset."""
    return catalog_support.update_toolset_result(
        tool_context.agent,
        name=name,
        description=description,
        tool_names=tool_names,
    )


@tool
def delete_toolset(name: str) -> dict[str, Any]:
    """Delete a persistent toolset."""
    return catalog_support.delete_toolset_result(name)


@tool(context=True)
def execute_catalog_tool(
    tool_context: ToolContext,
    name: str | None = None,
    arguments: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Execute one or more cataloged tools, loading them from their real catalog paths as needed."""
    return catalog_support.execute_result(
        tool_context.agent,
        name=name,
        arguments=arguments,
        tools=tools,
    )


@tool(context=True)
def load_catalog_tool(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """Load one cataloged tool into the current agent for repeated use."""
    return catalog_support.load_tool_result(tool_context.agent, name)


@tool(context=True)
def unload_catalog_tool(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """Unload one cataloged tool from the current agent registry."""
    return catalog_support.unload_tool_result(tool_context.agent, name)


@tool(context=True)
def load_toolset(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """Load a named toolset, or all tools in a matching category, into the current agent registry."""
    return catalog_support.load_toolset_result(tool_context.agent, name)


@tool(context=True)
def unload_toolset(tool_context: ToolContext, name: str) -> dict[str, Any]:
    """Unload a named toolset, or all tools in a matching category, from the current agent registry."""
    return catalog_support.unload_toolset_result(tool_context.agent, name)


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
    """Unified compatibility entry point for discovery, execution, loading, unloading, and toolset management."""
    agent = tool_context.agent

    if action == "list_categories":
        return catalog_support.list_categories_result(agent)
    if action == "get_tool":
        return catalog_support.get_tool_result(agent, name)
    if action == "list_toolsets":
        return catalog_support.list_toolsets_result(agent)
    if action == "get_toolset":
        return catalog_support.get_toolset_result(agent, name)
    if action == "create_toolset":
        return catalog_support.create_toolset_result(
            agent,
            name=name,
            description=description,
            tool_names=tool_names,
        )
    if action == "update_toolset":
        return catalog_support.update_toolset_result(
            agent,
            name=name,
            description=description,
            tool_names=tool_names,
        )
    if action == "delete_toolset":
        return catalog_support.delete_toolset_result(name)
    if action == "execute":
        return catalog_support.execute_result(
            agent,
            name=name,
            arguments=arguments,
            tools=tools,
        )
    if action == "load":
        return catalog_support.load_tool_result(agent, name)
    if action == "unload":
        return catalog_support.unload_tool_result(agent, name)
    if action == "load_toolset":
        return catalog_support.load_toolset_result(agent, name)
    if action == "unload_toolset":
        return catalog_support.unload_toolset_result(agent, name)

    return {"status": "error", "content": [{"text": f"Unsupported action: {action}"}]}
