"""
Runtime environment variable management tool for Strands Agent.

This module provides comprehensive functionality for managing environment variables
at runtime, allowing you to list, get, set, delete, and validate environment variables
with appropriate security measures and clear formatting. It's designed to provide
both interactive usage with rich formatting and programmatic access with structured returns.

Key Features:

1. Variable Management:
   • Get all environment variables
   • Set/update variables with validation
   • Delete variables safely
   • Filter by prefix
   • Protect system variables

2. Security Features:
   • Protected variables list
   • Value masking for sensitive data
   • Change confirmation
   • Variable validation
   • Risk level indicators

3. Rich Output:
   • Colorized tables with clear formatting
   • Visual indicators for protected variables
   • Operation previews with risk assessment
   • Success/error status panels
   • Variable categorization

4. Smart Filtering:
   • Prefix-based filtering
   • Sensitive value detection
   • Protected variable identification
   • Value type recognition

Usage with Strands Agent:
```python
from strands import Agent
from strands_tools import environment

agent = Agent(tools=[environment])

# List all environment variables
agent.tool.environment(action="list")

# List variables with specific prefix
agent.tool.environment(action="list", prefix="AWS_")

# Get a specific variable value
agent.tool.environment(action="get", name="PATH")

# Set a variable (with confirmation prompt)
agent.tool.environment(action="set", name="MY_SETTING", value="new_value")

# Delete a variable (with confirmation prompt)
agent.tool.environment(action="delete", name="TEMP_VAR")
```

See the environment function docstring for more details on available actions and parameters.
"""

import os
from typing import Any, Dict, List, Optional

# Route ALL variable access through the multi-tenant, request-scoped store
# (server/tenant_environment.py). This tool operates on the *current tenant's*
# request overlay — NEVER on the process-global ``os.environ`` — so concurrent
# users can never read or clobber each other's variables (including their
# Google credentials). The project root is on sys.path when this tool is loaded
# by the agent; guard against standalone imports.
try:
    from server.tenant_environment import (
        MASKED_SENTINEL,
        is_process_protected as _is_process_protected,
        is_sensitive_name as _is_sensitive_name,
        process_protected_names as _process_protected_names,
        tenant_env_delete as _tenant_env_delete,
        tenant_env_list as _tenant_env_list,
        tenant_env_metadata as _tenant_env_metadata,
        tenant_env_set as _tenant_env_set,
    )

    _TENANT_ENV_AVAILABLE = True
except Exception:  # pragma: no cover - standalone import without server on path
    _TENANT_ENV_AVAILABLE = False
    MASKED_SENTINEL = "[set · hidden]"
    _is_process_protected = None  # type: ignore[assignment]
    _is_sensitive_name = None  # type: ignore[assignment]
    _process_protected_names = None  # type: ignore[assignment]
    _tenant_env_delete = None  # type: ignore[assignment]
    _tenant_env_list = None  # type: ignore[assignment]
    _tenant_env_metadata = None  # type: ignore[assignment]
    _tenant_env_set = None  # type: ignore[assignment]

from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from strands import ToolContext, tool
from strands.types.tools import ToolResult, ToolResultContent

from strands_tools.utils import console_util, user_input

TOOL_SPEC = {
    "name": "environment",
    "description": """Runtime environment variable management tool.
    
Key Features:
1. Variable Management:
   - Get all environment variables
   - Set/update variables
   - Delete variables
   - Filter by prefix
   - Validate values
   
2. Actions:
   - list: Show all or filtered variables
   - get: Get specific variable value
   - set: Set/update variable value
   - delete: Remove variable
   - validate: Check variable format/value
   
3. Security:
   - Protected variables list
   - Value validation
   - Change tracking
   - Variable masking
   
4. Usage Examples:
   # List all environment variables:
   environment(action="list")
   
   # List variables with prefix:
   environment(action="list", prefix="AWS_")
   
   # Get specific variable:
   environment(action="get", name="MIN_SCORE")
   
   # Set variable:
   environment(action="set", name="MIN_SCORE", value="0.7")
   
   # Delete variable:
   environment(action="delete", name="TEMP_VAR")""",
    "inputSchema": {
        "json": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "get", "set", "delete", "validate"],
                    "description": "Action to perform on environment variables",
                },
                "name": {
                    "type": "string",
                    "description": "Name of the environment variable",
                },
                "value": {
                    "type": "string",
                    "description": "Value to set for the environment variable",
                },
                "prefix": {
                    "type": "string",
                    "description": "Filter variables by prefix",
                },
                "masked": {
                    "type": "boolean",
                    "description": "Mask sensitive values in output",
                    "default": True,
                },
            },
            "required": ["action"],
        }
    },
}


# Protected variables that can't be modified. Fallback set used only when the
# tenant store is unavailable (standalone import); normally the authoritative
# list comes from ``server.tenant_environment.process_protected_names()``.
PROTECTED_VARS = {"PATH", "PYTHONPATH", "STRANDS_HOME", "SHELL", "USER", "HOME", "BYPASS_TOOL_CONSENT"}


def _is_protected(name: str) -> bool:
    """True when ``name`` is a process-protected variable a tenant may not modify."""
    if _TENANT_ENV_AVAILABLE and _is_process_protected is not None:
        return _is_process_protected(name)
    return name in PROTECTED_VARS


def _is_sensitive(name: str) -> bool:
    """True when ``name`` looks like a credential (value must never be divulged)."""
    if _TENANT_ENV_AVAILABLE and _is_sensitive_name is not None:
        return _is_sensitive_name(name)
    return any(token in name.upper() for token in ("TOKEN", "SECRET", "PASSWORD", "KEY", "AUTH"))


def format_operation_preview(
    action: str,
    name: Optional[str] = None,
    value: Optional[str] = None,
    prefix: Optional[str] = None,
) -> Panel:
    """
    Format operation preview as a rich panel with enhanced details.

    Creates a visual preview of the requested operation with appropriate styling,
    risk level indicators, and relevant details about the operation being performed.

    Args:
        action: The action being performed (get, list, set, delete, validate)
        name: Optional name of the target environment variable
        value: Optional value for set operations
        prefix: Optional prefix filter for list operations

    Returns:
        Panel: A Rich library Panel object containing the formatted preview
    """
    table = Table(show_header=False, box=box.SIMPLE)
    table.add_column("Field", style="cyan")
    table.add_column("Value", style="white")

    # Format action with color based on type
    action_style = {
        "get": "green",
        "list": "blue",
        "set": "yellow",
        "delete": "red",
        "validate": "magenta",
    }.get(action.lower(), "white")

    table.add_row("Action", f"[{action_style}]{action.upper()}[/{action_style}]")

    if name:
        protected = _is_protected(name)
        name_style = "red" if protected else "white"
        table.add_row(
            "Variable",
            f"[{name_style}]{name}[/{name_style}] {'🔒' if protected else ''}",
        )
    if value:
        table.add_row("Value", str(value))
    if prefix:
        table.add_row("Prefix Filter", prefix)

    # Add warning for protected variables
    if name and _is_protected(name):
        table.add_row(
            "⚠️ Warning",
            "[red]This is a protected system variable that cannot be modified[/red]",
        )

    # Add operation risk level
    risk_level = {
        "get": ("🟢 Safe", "green"),
        "list": ("🟢 Safe", "green"),
        "set": ("🟡 Modifies Environment", "yellow"),
        "delete": ("🔴 Destructive", "red"),
        "validate": ("🟢 Safe", "green"),
    }.get(action.lower(), ("⚪ Unknown", "white"))

    table.add_row("Risk Level", f"[{risk_level[1]}]{risk_level[0]}[/{risk_level[1]}]")

    return Panel(
        table,
        title=f"[bold {risk_level[1]}]🔧 Environment Operation Preview[/bold {risk_level[1]}]",
        border_style=risk_level[1],
        box=box.ROUNDED,
        subtitle="[dim]Dev Mode: "
        + ("✓" if os.environ.get("BYPASS_TOOL_CONSENT", "").lower() == "true" else "✗")
        + "[/dim]",
    )


def format_success_message(message: str) -> Panel:
    """
    Format a success message in a visually distinct green panel.

    Args:
        message: The success message to format

    Returns:
        Panel: A Rich library Panel with appropriate styling
    """
    return Panel(
        Text(message, style="green"),
        title="[bold green]✅ Success",
        border_style="green",
        box=box.ROUNDED,
    )


def format_error_message(message: str) -> Panel:
    """
    Format an error message in a visually distinct red panel.

    Args:
        message: The error message to format

    Returns:
        Panel: A Rich library Panel with appropriate styling
    """
    return Panel(
        Text(message, style="red"),
        title="[bold red]❌ Error",
        border_style="red",
        box=box.ROUNDED,
    )


def show_operation_result(console: Console, success: bool, message: str) -> None:
    """
    Display operation result with appropriate formatting based on success status.

    Args:
        success: Whether the operation was successful
        message: The message to display
    """
    if success:
        console.print(format_success_message(message))
    else:
        console.print(format_error_message(message))


@tool(name="environment", description=TOOL_SPEC["description"], inputSchema=TOOL_SPEC["inputSchema"], context=True)
def environment(
    action: str,
    name: Optional[str] = None,
    value: Optional[str] = None,
    prefix: Optional[str] = None,
    masked: Optional[bool] = None,
    tool_context: Optional[ToolContext] = None,
) -> ToolResult:
    """
    Environment variable management tool for listing, getting, setting, and deleting environment variables.

    This function provides a comprehensive interface for managing runtime environment variables
    with rich output formatting, security features, and proper error handling. It supports
    multiple actions for different environment variable operations, each with appropriate
    validation and confirmation steps.

    How It Works:
    ------------
    1. The function processes the requested action (list, get, set, delete, validate)
    2. For destructive actions, it requires user confirmation unless in BYPASS_TOOL_CONSENT mode
    3. Protected system variables are identified and cannot be modified
    4. Sensitive values (tokens, passwords, etc.) are automatically masked
    5. Rich output formatting provides clear visual feedback on operations
    6. All operations return structured results for both human and programmatic use

    Available Actions:
    ---------------
    - list: Display all environment variables or filter by prefix
    - get: Retrieve and display a specific variable value
    - set: Create or update a variable value (with confirmation)
    - delete: Remove a variable from the environment (with confirmation)
    - validate: Check if a variable exists and validate its format

    Security Features:
    ---------------
    - Protected system variables cannot be modified
    - Sensitive values are masked in output by default
    - Destructive actions require explicit confirmation
    - Clear risk level indicators for all operations
    - BYPASS_TOOL_CONSENT mode controls for testing and automation

    Args:
        action: The action to perform (list, get, set, delete, validate)
        name: Environment variable name (for get/set/delete/validate)
        value: Value to set (for set action)
        prefix: Filter prefix for list action
        masked: Whether to mask sensitive values in output (defaults from ENV_VARS_MASKED_DEFAULT)
        tool_context: Strands tool context containing tool invocation metadata

    Returns:
        ToolResult: Dictionary containing:
            - toolUseId: The ID of the tool usage
            - status: "success" or "error"
            - content: List of content objects with results or error messages

    Notes:
        - The ENV var "BYPASS_TOOL_CONSENT" can be set to "true" to bypass confirmation prompts
        - Protected variables include PATH, PYTHONPATH, STRANDS_HOME, SHELL, USER, HOME, BYPASS_TOOL_CONSENT
        - Sensitive variables are detected by keywords in their names (TOKEN, SECRET, etc.)
        - For security reasons, values of sensitive variables are masked in output
        - Set/delete actions are persisted to the agent environment store
    """
    console = console_util.create()

    # Default return in case of unexpected code path
    tool_use_id = (
        tool_context.tool_use["toolUseId"]
        if tool_context and "toolUseId" in tool_context.tool_use
        else "environment-local"
    )
    default_content: List[ToolResultContent] = [{"text": "Unknown error in environment tool"}]
    default_result = {
        "toolUseId": tool_use_id,
        "status": "error",
        "content": default_content,
    }
    tool_input: Dict[str, Any] = {
        "action": action,
        "name": name,
        "value": value,
        "prefix": prefix,
        "masked": masked,
    }

    # Check for BYPASS_TOOL_CONSENT mode
    strands_dev = os.environ.get("BYPASS_TOOL_CONSENT", "").lower() == "true"

    # Actions that need confirmation
    dangerous_actions = {"set", "delete"}
    requested_action = str(tool_input["action"]).strip().lower()
    needs_confirmation = requested_action in dangerous_actions and not strands_dev

    # Print BYPASS_TOOL_CONSENT mode status for debugging
    if strands_dev:
        console.print("[bold green]Running in BYPASS_TOOL_CONSENT mode - confirmation bypassed[/bold green]")

    try:
        action = requested_action

        if not _TENANT_ENV_AVAILABLE:
            msg = (
                "Environment tool is not connected to the tenant store "
                "(server.tenant_environment unavailable). Variables cannot be "
                "managed in this context."
            )
            console.print(format_error_message(msg))
            return {"toolUseId": tool_use_id, "status": "error", "content": [{"text": msg}]}

        # Action processing starts here

        if action == "list":
            prefix = tool_input.get("prefix")

            # Source of truth: the CURRENT tenant's request overlay. Each entry
            # is already model-safe (``display`` is the masked sentinel for
            # sensitive vars, plaintext for the rest). Process-global os.environ
            # is intentionally NOT listed — it holds backend deploy secrets.
            entries = _tenant_env_list() if _tenant_env_list is not None else []
            if prefix:
                entries = [e for e in entries if e["name"].startswith(str(prefix))]

            # Rich table for the operator console
            table = Table(title="Environment Variables", show_header=True, box=box.ROUNDED)
            table.add_column("Sensitive", style="yellow")
            table.add_column("Name", style="cyan")
            table.add_column("Value", style="green")
            for e in entries:
                flag = "🔒" if e.get("sensitive") else ""
                table.add_row(flag, e["name"], str(e.get("display", "")))

            if prefix:
                title = f"[bold blue]Environment Variables[/bold blue] (prefix=[yellow]{prefix}[/yellow])"
            else:
                title = "[bold blue]Environment Variables[/bold blue]"

            console.print("")
            console.print(Panel(table, title=title, border_style="blue", box=box.ROUNDED))

            # Model-safe plain text for return
            lines = []
            for e in entries:
                flag = "🔒" if e.get("sensitive") else "  "
                lines.append(f"{flag} {e['name']} = {e.get('display', '')}")

            list_content: List[ToolResultContent] = [
                {"text": "\n".join(lines) if lines else "(no tenant variables set)"}
            ]

            # Build environment UI data for specialized rendering
            env_data = {
                "variables": [
                    {
                        "name": e["name"],
                        "value": e.get("display", ""),
                        "protected": False,
                        "sensitive": bool(e.get("sensitive")),
                        "updated_at": e.get("updated_at"),
                    }
                    for e in entries
                ],
                "count": len(entries),
                "action": "list",
            }

            return {
                "toolUseId": tool_use_id,
                "status": "success",
                "content": list_content,
                "__ui_data__": {"type": "environment", "data": env_data},
            }

        elif action == "get":
            if not name:
                console.print(format_error_message("name parameter is required"))
                raise ValueError("name parameter is required for get action")

            meta = _tenant_env_metadata(name) if _tenant_env_metadata is not None else None

            if meta is None:
                error_msg = f"Environment variable {name} not found for this user"
                console.print(format_error_message(error_msg))
                return {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": error_msg}],
                }

            sensitive = bool(meta.get("sensitive"))
            # ``display`` is model-safe: the masked sentinel for sensitive vars,
            # plaintext for non-sensitive ones. The tool NEVER surfaces a
            # sensitive plaintext to the model.
            display_value = str(meta.get("display", ""))

            # Show operation preview
            console.print(format_operation_preview(action="get", name=name, value=display_value))

            # Create rich display with proper formatting
            table = Table(show_header=False, box=box.SIMPLE)
            table.add_column("Field", style="cyan")
            table.add_column("Value", style="green")

            # Add variable details
            table.add_row("Name", name)
            table.add_row("Type", "Sensitive" if sensitive else "Standard")
            table.add_row("Value", display_value)
            if meta.get("updated_at"):
                table.add_row("Updated", str(meta.get("updated_at")))
            if meta.get("decrypt_error"):
                table.add_row("Status", "[red]⚠️ stored value failed to decrypt[/red]")

            # Value properties only for non-sensitive values; for sensitive vars
            # even the length leaks entropy, so we never compute it here.
            if not sensitive:
                table.add_row("Length", str(len(display_value)))
                table.add_row("Contains Spaces", "Yes" if " " in display_value else "No")
                table.add_row("Multiline", "Yes" if "\n" in display_value else "No")

            # Create info panel
            panel = Panel(
                table,
                title=(
                    f"[bold {'yellow' if sensitive else 'blue'}]🔍 "
                    f"Environment Variable Details[/bold {'yellow' if sensitive else 'blue'}]"
                ),
                border_style="yellow" if sensitive else "blue",
                box=box.ROUNDED,
            )
            console.print(panel)

            # Show success message
            show_operation_result(console, True, f"Successfully retrieved {name}")
            get_content: List[ToolResultContent] = [{"text": f"{name} = {display_value}"}]

            # Build environment UI data for specialized rendering
            env_data = {
                "variables": [
                    {
                        "name": name,
                        "value": display_value,
                        "protected": False,
                        "sensitive": sensitive,
                        "updated_at": meta.get("updated_at"),
                    }
                ],
                "count": 1,
                "action": "get",
            }

            return {
                "toolUseId": tool_use_id,
                "status": "success",
                "content": get_content,
                "__ui_data__": {"type": "environment", "data": env_data},
            }

        elif action == "set":
            if not name or value is None:
                error_msg = "name and value parameters are required"
                console.print(format_error_message(error_msg))
                raise ValueError(error_msg)

            # Check protected status first, regardless of confirmation mode.
            # Uses the full tenant-protected set (infra/app secrets, model keys).
            if _is_protected(name):
                error_msg = f"⚠️ Cannot modify protected variable: {name}"
                error_details = "\nProtected variables ensure system stability and security."
                console.print(format_error_message(f"{error_msg}{error_details}"))
                return {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": f"Cannot modify protected variable: {name}"}],
                }

            sensitive = _is_sensitive(name)
            # Never echo a sensitive plaintext to the console/model, even on the
            # way IN. The operator already knows the value they typed.
            preview_value = MASKED_SENTINEL if sensitive else str(value)

            # Show operation preview (always)
            console.print(format_operation_preview(action="set", name=name, value=preview_value))

            # Show current vs new value comparison if the var already exists,
            # sourced from the tenant overlay (current value masked if sensitive).
            current_meta = _tenant_env_metadata(name) if _tenant_env_metadata is not None else None
            if current_meta is not None:
                table = Table(show_header=True)
                table.add_column("State", style="cyan")
                table.add_column("Value", style="white")
                table.add_row("Current", str(current_meta.get("display", "")))
                table.add_row("New", preview_value)
                console.print(
                    Panel(
                        table,
                        title="[bold yellow]Value Comparison",
                        border_style="yellow",
                    )
                )

            # Ask for confirmation
            if needs_confirmation:
                confirm = user_input.get_user_input(
                    "\n<yellow><bold>Do you want to proceed with setting this environment variable?</bold> "
                    "[y/*]</yellow>"
                )
                # For tests, 'y' should be recognized even with extra spaces or newlines
                if confirm.strip().lower() != "y":
                    console.print(format_error_message("Operation cancelled by user"))
                    return {
                        "toolUseId": tool_use_id,
                        "status": "error",
                        "content": [{"text": f"Operation cancelled by user, reason: {confirm}"}],
                    }

            # Persist to the CURRENT tenant's store + request overlay. The store
            # validates the name, encrypts sensitive values at rest, and requires
            # an active tenant context.
            try:
                meta = _tenant_env_set(name, str(value))
            except (ValueError, RuntimeError) as exc:
                console.print(format_error_message(str(exc)))
                return {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": str(exc)}],
                }

            safe_display = str(meta.get("display", preview_value))

            # Show success message
            show_operation_result(console, True, f"Successfully set {name}")
            success_table = Table(show_header=False)
            success_table.add_column("Field", style="cyan")
            success_table.add_column("Value", style="green")
            success_table.add_row("Variable", name)
            success_table.add_row("New Value", safe_display)
            success_table.add_row("Sensitive", "Yes" if sensitive else "No")
            success_table.add_row("Operation", "Set")
            success_table.add_row("Status", "✅ Complete")

            console.print(
                Panel(
                    success_table,
                    title="[bold green]✅ Variable Set Successfully",
                    border_style="green",
                    box=box.ROUNDED,
                )
            )

            # Format content for return (model-safe: sentinel for sensitive)
            set_content: List[ToolResultContent] = [{"text": f"Set {name} = {safe_display}"}]
            return {
                "toolUseId": tool_use_id,
                "status": "success",
                "content": set_content,
            }
        elif action == "validate":
            if not name:
                raise ValueError("name parameter is required for validate action")

            meta = _tenant_env_metadata(name) if _tenant_env_metadata is not None else None

            if meta is None:
                error_content: List[ToolResultContent] = [
                    {"text": f"Environment variable {name} not found for this user"}
                ]
                return {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": error_content,
                }

            if meta.get("decrypt_error"):
                return {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [
                        {"text": f"Environment variable {name} is set but its stored value failed to decrypt"}
                    ],
                }

            # Format content for return
            validate_content: List[ToolResultContent] = [{"text": f"Environment variable {name} is valid"}]
            return {
                "toolUseId": tool_use_id,
                "status": "success",
                "content": validate_content,
            }

        elif action == "delete":
            if not name:
                error_msg = "name parameter is required for delete action"
                console.print(format_error_message(error_msg))
                raise ValueError(error_msg)

            # Check protected status first
            if _is_protected(name):
                error_msg = (
                    f"⚠️ Cannot delete protected variable: {name}\n"
                    "Protected variables ensure system stability and security."
                )
                console.print(format_error_message(error_msg))
                return {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": f"Cannot delete protected variable: {name}"}],
                }

            # Check if variable exists for THIS tenant
            existing_meta = _tenant_env_metadata(name) if _tenant_env_metadata is not None else None
            if existing_meta is None:
                error_msg = f"Environment variable not found: {name}"
                console.print(format_error_message(error_msg))
                return {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": error_msg}],
                }

            # Model-/log-safe rendering of the current value (sentinel if sensitive)
            current_display = str(existing_meta.get("display", ""))

            # Show detailed preview for confirmation
            if needs_confirmation:
                # Show operation preview
                console.print(format_operation_preview(action="delete", name=name, value=current_display))

                # Show warning message
                warning_table = Table(show_header=False, box=box.SIMPLE)
                warning_table.add_column("Item", style="yellow")
                warning_table.add_column("Details", style="white")
                warning_table.add_row("Action", "🗑️ Delete Environment Variable")
                warning_table.add_row("Variable", name)
                warning_table.add_row("Current Value", current_display)
                warning_table.add_row("Warning", "This action cannot be undone")

                console.print(
                    Panel(
                        warning_table,
                        title="[bold red]⚠️ Warning: Destructive Action",
                        border_style="red",
                        box=box.ROUNDED,
                    )
                )

                # Ask for confirmation
                confirm = user_input.get_user_input(
                    "\n<red><bold>Do you want to proceed with deleting this environment variable?</bold> [y/*]</red>"
                )
                # For tests, 'y' should be recognized even with extra spaces or newlines
                if confirm.strip().lower() != "y":
                    console.print(format_error_message("Operation cancelled by user"))
                    return {
                        "toolUseId": tool_use_id,
                        "status": "error",
                        "content": [{"text": f"Operation cancelled by user, reason: {confirm}"}],
                    }

            # Delete from the CURRENT tenant's store + request overlay.
            try:
                _tenant_env_delete(name)
            except (ValueError, RuntimeError) as exc:
                console.print(format_error_message(str(exc)))
                return {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": str(exc)}],
                }

            # Show success message
            show_operation_result(console, True, f"Successfully deleted {name}")
            success_table = Table(show_header=False)
            success_table.add_column("Field", style="cyan")
            success_table.add_column("Value", style="green")
            success_table.add_row("Variable", name)
            success_table.add_row("Previous Value", current_display)
            success_table.add_row("Operation", "Delete")
            success_table.add_row("Status", "✅ Complete")

            console.print(
                Panel(
                    success_table,
                    title="[bold green]✅ Variable Deleted Successfully",
                    border_style="green",
                    box=box.ROUNDED,
                )
            )

            # Format content for return
            delete_content: List[ToolResultContent] = [{"text": f"Deleted environment variable: {name}"}]
            return {
                "toolUseId": tool_use_id,
                "status": "success",
                "content": delete_content,
            }

        unsupported_action_content: List[ToolResultContent] = [
            {"text": f"Unsupported action: {action}. Use one of list|get|set|delete|validate."}
        ]
        return {
            "toolUseId": tool_use_id,
            "status": "error",
            "content": unsupported_action_content,
        }

    except Exception as e:
        exception_content: List[ToolResultContent] = [{"text": f"Environment tool error: {str(e)}"}]
        return {
            "toolUseId": tool_use_id,
            "status": "error",
            "content": exception_content,
        }

    # Fallback return in case no action matched
    return default_result  # type: ignore
