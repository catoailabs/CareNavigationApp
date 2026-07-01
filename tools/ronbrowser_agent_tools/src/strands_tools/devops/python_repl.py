"""
Execute Python code in a REPL environment inside the virtual desktop container,
with state persistence.

This module provides a tool for running Python code through a Strands Agent, with features like:
- Persistent state between executions (pickled inside the container)
- Output capturing and formatting
- Error handling and logging
- State reset capabilities
- User confirmation for code execution

The code is executed **inside** the ``ron-agent-desktop`` virtual desktop
container (via :mod:`strands_tools.devops.container_fs`), on the same filesystem
the ``shell`` tool uses. In-process ``exec()`` on the agent host would run on a
different filesystem than ``shell``/``file_write``/``editor``; routing execution
through the container keeps every tool consistent about the state of the world.
Persistent REPL state lives in ``<sandbox>/repl_state/repl_state.pkl`` inside the
container (stdlib ``pickle`` — ``dill`` is not assumed present in the container).

Usage with Strands Agent:
```python
from strands import Agent
from strands_tools import python_repl

# Register the python_repl tool with the agent
agent = Agent(tools=[python_repl])

# Execute Python code
result = agent.tool.python_repl(code="print('Hello, world!')")

# Execute with state persistence (variables remain available between calls)
agent.tool.python_repl(code="x = 10")
agent.tool.python_repl(code="print(x * 2)")  # Will print: 20

# Reset the REPL state if needed
agent.tool.python_repl(code="print('Fresh start')", reset_state=True)
```
"""

import base64
import json
import logging
import os
import posixpath
import traceback
from datetime import datetime
from typing import Any, Dict, Optional

from rich import box
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table
from strands import tool

from strands_tools.utils import console_util
from strands_tools.utils.user_input import get_user_input

from . import container_fs
from .container_fs import ContainerFsError

# Initialize logging and set paths
logger = logging.getLogger(__name__)


def _sandbox_base() -> str:
    """Root of the agent sandbox *inside the container*.

    Defaults to ``/workspace`` (the mount configured in the virtual desktop
    ``docker-compose.yml``); ``RON_AGENT_SANDBOX_ROOT`` is only set inside the
    container, so we cannot rely on the host process seeing it.
    """
    return os.environ.get("RON_AGENT_SANDBOX_ROOT") or "/workspace"


# Driver executed *inside the container* via ``python3 -``. It loads the pickled
# namespace, execs the user code with stdout/stderr captured, re-pickles the
# picklable non-underscore names, and prints a single JSON result document.
_REPL_DRIVER = r"""
import base64, json, os, pickle, sys, traceback
from io import StringIO

state_file = sys.argv[1]
code = base64.b64decode(sys.argv[2]).decode("utf-8")

namespace = {"__name__": "__main__"}
if os.path.exists(state_file):
    try:
        with open(state_file, "rb") as f:
            namespace.update(pickle.load(f))
    except Exception:
        try:
            os.remove(state_file)
        except Exception:
            pass

_out, _err = StringIO(), StringIO()
_so, _se = sys.stdout, sys.stderr
sys.stdout, sys.stderr = _out, _err
status = "success"
tb = ""
try:
    exec(code, namespace)
except BaseException:
    status = "error"
    tb = traceback.format_exc()
finally:
    sys.stdout, sys.stderr = _so, _se

save = {}
for name, value in namespace.items():
    if name.startswith("_"):
        continue
    try:
        pickle.dumps(value)
        save[name] = value
    except BaseException:
        continue
try:
    d = os.path.dirname(state_file)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(state_file, "wb") as f:
        pickle.dump(save, f)
except Exception:
    pass

user_objects = {}
for name, value in namespace.items():
    if name.startswith("_"):
        continue
    if isinstance(value, (int, float, str, bool)):
        user_objects[name] = repr(value)

print(json.dumps({
    "status": status,
    "stdout": _out.getvalue(),
    "stderr": _err.getvalue(),
    "traceback": tb,
    "user_objects": user_objects,
}))
"""


class ReplState:
    """Manages persistent Python REPL state inside the virtual desktop container."""

    def __init__(self) -> None:
        # Resolve the persistence directory *inside the container*.
        override = os.environ.get("PYTHON_REPL_PERSISTENCE_DIR")
        base = override if override else _sandbox_base()
        self.persistence_dir = posixpath.join(base, "repl_state")
        self.state_file = posixpath.join(self.persistence_dir, "repl_state.pkl")
        # Snapshots from the most recent execution (populated by execute()).
        self._last_output = ""
        self._last_status = "success"
        self._last_traceback = ""
        self._last_user_objects: Dict[str, str] = {}
        try:
            container_fs.makedirs(self.persistence_dir)
        except ContainerFsError as exc:
            logger.warning(f"Could not create REPL persistence dir in container: {exc}")

    def execute(self, code: str) -> Dict[str, Any]:
        """Execute ``code`` inside the container against the persisted namespace.

        Returns the driver's JSON result dict (``status``/``stdout``/``stderr``/
        ``traceback``/``user_objects``) and caches it for display helpers.
        """
        code_b64 = base64.b64encode(code.encode("utf-8")).decode("ascii")
        rc, out, err = container_fs.run_python(
            _REPL_DRIVER,
            args=[self.state_file, code_b64],
        )
        if rc != 0:
            # Driver itself failed (not the user code) — surface stderr.
            raise ContainerFsError(err.strip() or "python_repl driver failed in virtual desktop")
        try:
            result = json.loads(out)
        except json.JSONDecodeError as exc:
            raise ContainerFsError(
                f"malformed python_repl output from virtual desktop: {out[:200]!r}"
            ) from exc

        stdout = result.get("stdout", "") or ""
        stderr = result.get("stderr", "") or ""
        combined = stdout
        if stderr:
            combined += f"\nErrors:\n{stderr}"
        self._last_output = combined
        self._last_status = result.get("status", "success")
        self._last_traceback = result.get("traceback", "") or ""
        self._last_user_objects = dict(result.get("user_objects", {}) or {})
        result["output"] = combined
        return result

    def clear_state(self) -> None:
        """Clear persisted state by removing the state file inside the container."""
        try:
            container_fs.remove(self.state_file)
            logger.info("REPL state cleared and file removed")
        except ContainerFsError as e:
            logger.error(f"Error clearing state: {e}")
        self._last_output = ""
        self._last_status = "success"
        self._last_traceback = ""
        self._last_user_objects = {}

    def get_user_objects(self) -> Dict[str, str]:
        """Get user-defined scalar objects from the most recent execution."""
        return dict(self._last_user_objects)


# Create global state instance
repl_state = ReplState()


@tool
def python_repl(
    code: str,
    interactive: Optional[bool] = None,
    reset_state: Optional[bool] = None,
    **kwargs: Any
) -> Dict:
    """Execute Python code in a REPL environment with interactive PTY support and state persistence.

    This tool provides a powerful Python REPL environment with features like persistent state between executions,
    interactive PTY support for real-time feedback, output capturing and formatting, error handling and logging,
    and state reset capabilities.

    IMPORTANT SAFETY FEATURES:
    1. User Confirmation: Requires explicit approval before executing code
    2. Code Preview: Shows syntax-highlighted code before execution
    3. State Management: Maintains variables between executions
    4. Error Handling: Captures and formats errors with suggestions
    5. Development Mode: Can bypass confirmation in BYPASS_TOOL_CONSENT environments

    Args:
        code: The Python code to execute
        interactive: Whether to enable interactive PTY mode (default controlled by PYTHON_REPL_INTERACTIVE env var, defaults to True)
        reset_state: Whether to reset the REPL state before execution (default controlled by PYTHON_REPL_RESET_STATE env var, defaults to False)
        **kwargs: Additional keyword arguments

    Returns:
        Dictionary containing execution status and output
    """
    console = console_util.create()

    # Handle environment variable defaults
    if interactive is None:
        interactive = os.environ.get("PYTHON_REPL_INTERACTIVE", "true").lower() == "true"
    if reset_state is None:
        reset_state = os.environ.get("PYTHON_REPL_RESET_STATE", "false").lower() == "true"

    # Check for development mode
    strands_dev = os.environ.get("BYPASS_TOOL_CONSENT", "").lower() == "true"

    # Check for non_interactive_mode parameter
    non_interactive_mode = kwargs.get("non_interactive_mode", False)

    try:
        # Handle state reset if requested
        if reset_state:
            console.print("[yellow]Resetting REPL state...[/]")
            repl_state.clear_state()
            console.print("[green]REPL state reset complete[/]")

        # Show code preview
        console.print(
            Panel(
                Syntax(code, "python", theme="monokai"),
                title="[bold blue]Executing Python Code[/]",
            )
        )

        # Add permissions check - only show confirmation dialog if not
        # in BYPASS_TOOL_CONSENT mode and not in non_interactive mode
        if not strands_dev and not non_interactive_mode:
            # Create a table with code details for better visualization
            details_table = Table(show_header=False, box=box.SIMPLE)
            details_table.add_column("Property", style="cyan", justify="right")
            details_table.add_column("Value", style="green")

            # Add code details
            details_table.add_row("Code Length", f"{len(code)} characters")
            details_table.add_row("Line Count", f"{len(code.splitlines())} lines")
            details_table.add_row("Mode", "Interactive" if interactive else "Standard")
            details_table.add_row("Reset State", "Yes" if reset_state else "No")

            # Show confirmation panel
            console.print(
                Panel(
                    details_table,
                    title="[bold blue]🐍 Python Code Execution Preview",
                    border_style="blue",
                    box=box.ROUNDED,
                )
            )
            # Get user confirmation
            user_input = get_user_input(
                "<yellow><bold>Do you want to proceed with Python code execution?</bold> [y/*]</yellow>"
            )
            if user_input.lower().strip() != "y":
                cancellation_reason = (
                    user_input
                    if user_input.strip() != "n"
                    else get_user_input("Please provide a reason for cancellation:")
                )
                error_message = f"Python code execution cancelled by the user. Reason: {cancellation_reason}"
                error_panel = Panel(
                    f"[bold blue]{error_message}[/bold blue]",
                    title="[bold blue]❌ Cancelled",
                    border_style="blue",
                    box=box.ROUNDED,
                )
                console.print(error_panel)
                return {
                    "status": "error",
                    "content": [{"text": error_message}],
                }

        # Track execution time and capture output
        start_time = datetime.now()

        if interactive:
            console.print("[green]Running in interactive mode...[/]")
        else:
            console.print("[blue]Running in standard mode...[/]")

        # Execute the code inside the virtual desktop container against the
        # persisted namespace. User-code errors are captured by the driver and
        # reported via result["status"], not raised here.
        result = repl_state.execute(code)
        output = result.get("output", "")

        # Surface a user-code error the same way an in-process exception used to be.
        if result.get("status") == "error":
            error_tb = result.get("traceback", "") or output
            error_time = datetime.now()

            console.print(
                Panel(
                    Syntax(error_tb, "python", theme="monokai"),
                    title="[bold red]Python Error[/]",
                    border_style="red",
                )
            )

            error_msg = f"\n[{error_time.isoformat()}] Python REPL Error:\nCode:\n{code}\nError:\n{error_tb}\n"
            try:
                errors_dir = posixpath.join(_sandbox_base(), "errors")
                container_fs.makedirs(errors_dir)
                container_fs.append_text(posixpath.join(errors_dir, "errors.txt"), error_msg)
            except ContainerFsError as log_err:
                logger.warning(f"Could not persist REPL error log to container: {log_err}")
            logger.debug(error_msg)

            suggestion = ""
            if "RecursionError" in error_tb:
                console.print("[yellow]Recursion error detected - resetting state...[/]")
                repl_state.clear_state()
                suggestion = "\nTo fix this, try running with reset_state=True"

            return {
                "status": "error",
                "content": [{"text": f"{error_msg}{suggestion}"}],
            }

        if not interactive and output:
            console.print("[cyan]Output:[/]")
            console.print(output)

        # Show execution stats
        duration = (datetime.now() - start_time).total_seconds()
        user_objects = repl_state.get_user_objects()

        status = f"✓ Code executed successfully ({duration:.2f}s)"
        if user_objects:
            status += f"\nUser objects in namespace: {len(user_objects)} items"
            for name, value in user_objects.items():
                status += f"\n - {name} = {value}"
        console.print(f"[bold green]{status}[/]")

        # Return result with output
        return {
            "status": "success",
            "content": [{"text": output if output else "Code executed successfully"}],
        }

    except Exception:
        # Infrastructure failure (e.g. the agent cannot reach its virtual
        # desktop container). User-code errors are handled above.
        error_tb = traceback.format_exc()
        error_time = datetime.now()

        console.print(
            Panel(
                Syntax(error_tb, "python", theme="monokai"),
                title="[bold red]Python Error[/]",
                border_style="red",
            )
        )

        error_msg = f"\n[{error_time.isoformat()}] Python REPL Error:\nCode:\n{code}\nError:\n{error_tb}\n"
        try:
            errors_dir = posixpath.join(_sandbox_base(), "errors")
            container_fs.makedirs(errors_dir)
            container_fs.append_text(posixpath.join(errors_dir, "errors.txt"), error_msg)
        except Exception as log_err:
            logger.warning(f"Could not persist REPL error log to container: {log_err}")
        logger.debug(error_msg)

        return {
            "status": "error",
            "content": [{"text": error_msg}],
        }
