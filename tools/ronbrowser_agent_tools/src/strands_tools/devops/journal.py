"""
Daily journal management tool for Strands Agent.

This module provides functionality to create and manage daily journal entries with
rich text formatting, including task lists and notes. Journal entries are saved as
Markdown files in the cwd()/journal/ directory, organized by date.

Journal entries support both regular text notes and task management with checkboxes.
The tool provides a beautiful rich text interface with panels, tables, and formatting
to enhance the user experience when working with journal entries.

Usage with Strands Agent:
```python
from strands import Agent
from strands_tools import journal

agent = Agent(tools=[journal])

# Write a new journal entry
agent.tool.journal(
    action="write",
    content="Today I worked on implementing the Strands SDK tools."
)

# Add a task to today's journal
agent.tool.journal(
    action="add_task",
    task="Complete the journal tool documentation"
)

# Read today's journal
result = agent.tool.journal(action="read")

# View a list of all journal entries
entries = agent.tool.journal(action="list")

# Read a specific date's journal
specific_entry = agent.tool.journal(
    action="read",
    date="2023-04-15"
)
```

See the journal function docstring for more details on available actions and parameters.
"""

from datetime import datetime
import os
import posixpath
from typing import Any, Dict, Optional

from rich import box
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from strands import tool

from strands_tools.devops import container_fs
from strands_tools.utils import console_util


def _sandbox_base() -> str:
    """Base directory inside the virtual desktop container for agent artifacts."""
    return os.environ.get("RON_AGENT_SANDBOX_ROOT") or "/workspace"


def ensure_journal_dir() -> str:
    """
    Ensure the journal directory exists inside the virtual desktop container.

    Returns:
        str: The container path to the journal directory
    """
    journal_dir = posixpath.join(_sandbox_base(), "journal")
    container_fs.makedirs(journal_dir)
    return journal_dir


def get_journal_path(date_str: Optional[str] = None) -> str:
    """
    Get journal file path (inside the container) for the given date.

    Args:
        date_str: Optional date string in YYYY-MM-DD format. If not provided,
                  current date is used.

    Returns:
        str: Container path to the journal file for the specified date
    """
    if date_str is None:
        date_str = datetime.now().strftime("%Y-%m-%d")
    return posixpath.join(ensure_journal_dir(), f"{date_str}.md")


def _stem(path: str) -> str:
    """Filename without directory or extension (e.g. .../2023-04-15.md -> 2023-04-15)."""
    return posixpath.splitext(posixpath.basename(path))[0]


def create_rich_response(console: Console, action: str, result: Dict[str, Any]) -> None:
    """
    Create rich interface output for journal actions.

    This function generates visually appealing formatted output for different
    journal actions, using tables, panels, and styled text.

    Args:
        action: The journal action that was performed (write/read/list/add_task)
        result: Dictionary containing the action result data
    """
    if action == "write":
        panel = Panel(
            Text.assemble(
                ("✍️ Journal Entry Added\n\n", "bold magenta"),
                ("Time: ", "dim"),
                (datetime.now().strftime("%H:%M:%S"), "cyan"),
                ("\nDate: ", "dim"),
                (result["date"], "green"),
                ("\nPath: ", "dim"),
                (str(result["path"]), "blue"),
                ("\n\nContent:\n", "yellow"),
                (result["content"], "bright_white"),
            ),
            title="📔 Journal Update",
            border_style="blue",
            box=box.ROUNDED,
            padding=(1, 2),
        )
        console.print(panel)

    elif action == "read":
        md = Markdown(result["content"])
        panel = Panel(
            md,
            title=f"📖 Journal Entry - {result['date']}",
            border_style="blue",
            box=box.ROUNDED,
            padding=(1, 2),
        )
        console.print(panel)

    elif action == "list":
        table = Table(
            title="📚 Journal Entries",
            show_header=True,
            header_style="bold magenta",
            border_style="blue",
            box=box.ROUNDED,
        )

        table.add_column("📅 Date", style="cyan", no_wrap=True)
        table.add_column("📝 Entries", style="green")
        table.add_column("✅ Tasks", style="yellow")

        for entry in result["entries"]:
            table.add_row(entry["date"], str(entry["entry_count"]), str(entry["task_count"]))

        console.print(table)

    elif action == "add_task":
        panel = Panel(
            Text.assemble(
                ("✅ Task Added\n\n", "bold green"),
                ("Time: ", "dim"),
                (datetime.now().strftime("%H:%M:%S"), "cyan"),
                ("\nDate: ", "dim"),
                (result["date"], "green"),
                ("\nTask: ", "dim"),
                (result["task"], "yellow"),
            ),
            title="📋 Task Management",
            border_style="blue",
            box=box.ROUNDED,
            padding=(1, 2),
        )
        console.print(panel)


@tool
def journal(
    action: str,
    content: Optional[str] = None,
    date: Optional[str] = None,
    task: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Create and manage daily journal entries with tasks and notes.

    This tool allows you to write and read journal entries, add tasks, and list all
    available journal entries. Each journal is stored as a Markdown file in the
    cwd()/journal/ directory, organized by date.

    Args:
        action: Action to perform (write/read/list/add_task)
        content: Content to write (required for write action)
        date: Date in YYYY-MM-DD format (defaults to today)
        task: Task to add (required for add_task action)

    Returns:
        Dictionary containing status and response content:
        Success case: Returns confirmation of the action performed
        Error case: Returns information about what went wrong

    Notes:
        - If no date is specified, the current date is used
        - Each journal entry is automatically timestamped
        - The tool creates the journal directory if it doesn't exist
        - A rich text interface is provided for better user experience
        - Task completion status is maintained between sessions
    """
    console = console_util.create()

    try:
        if action == "write":
            if not content:
                return {
                    "status": "error",
                    "content": [{"text": "Content is required for write action"}],
                }

            journal_path = get_journal_path(date)
            timestamp = datetime.now().strftime("%H:%M:%S")

            container_fs.append_text(journal_path, f"\n## {timestamp}\n{content}\n")

            result = {
                "date": _stem(journal_path),
                "path": str(journal_path),
                "content": content,
                "timestamp": timestamp,
            }

            create_rich_response(console, action, result)
            return {
                "status": "success",
                "content": [{"text": f"Added entry to journal: {journal_path}"}],
            }

        elif action == "read":
            journal_path = get_journal_path(date)
            if not container_fs.exists(journal_path):
                return {
                    "status": "error",
                    "content": [{"text": f"No journal found for date: {_stem(journal_path)}"}],
                }

            content = container_fs.read_text(journal_path)

            result = {"date": _stem(journal_path), "content": content}

            create_rich_response(console, action, result)
            return {
                "status": "success",
                "content": [{"text": content}],
            }

        elif action == "list":
            journal_dir = ensure_journal_dir()
            journals = sorted(container_fs.glob(posixpath.join(journal_dir, "*.md")))

            if not journals:
                return {
                    "status": "success",
                    "content": [{"text": "No journal entries found"}],
                }

            entries = []
            for journal in journals:
                content = container_fs.read_text(journal)
                entry_count = len([line for line in content.split("\n") if line.startswith("## ")])
                task_count = content.count("- [ ]")
                entries.append(
                    {
                        "date": _stem(journal),
                        "entry_count": entry_count,
                        "task_count": task_count,
                    }
                )

            result = {"entries": entries}
            create_rich_response(console, action, result)

            return {
                "status": "success",
                "content": [{"text": f"Listed {len(entries)} journal entries"}],
            }

        elif action == "add_task":
            if not task:
                return {
                    "status": "error",
                    "content": [{"text": "Task is required for add_task action"}],
                }

            journal_path = get_journal_path(date)
            timestamp = datetime.now().strftime("%H:%M:%S")

            container_fs.append_text(journal_path, f"\n## {timestamp} - Task\n- [ ] {task}\n")

            result = {"date": _stem(journal_path), "task": task, "timestamp": timestamp}

            create_rich_response(console, action, result)
            return {
                "status": "success",
                "content": [{"text": f"Added task to journal: {journal_path}"}],
            }

        return {
            "status": "error",
            "content": [{"text": f"Unknown action: {action}"}],
        }

    except Exception as e:
        return {
            "status": "error",
            "content": [{"text": f"Error: {str(e)}"}],
        }
