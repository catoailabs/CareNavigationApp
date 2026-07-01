"""Template engine for generating text from Jinja2 templates"""

from typing import Dict, Any, Optional, List
import os
import posixpath
from jinja2 import Environment
from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table
from strands import tool

from strands_tools.devops import container_fs

console = Console()

# Rendering only uses ``env.from_string`` on content fetched from the virtual
# desktop container, so no host-side FileSystemLoader is needed.
env = Environment(
    trim_blocks=True,
    lstrip_blocks=True,
    autoescape=True,
)


def _template_dir() -> str:
    """Templates directory inside the virtual desktop container (created on demand)."""
    base = os.environ.get("RON_AGENT_SANDBOX_ROOT") or "/workspace"
    template_dir = posixpath.join(base, "templates")
    container_fs.makedirs(template_dir)
    return template_dir


def get_template_path(name: str) -> str:
    """Get template file path inside the container"""
    return posixpath.join(_template_dir(), f"{name}.j2")


@tool
def template(
    action: str,
    template_name: Optional[str] = None,
    content: Optional[str] = None,
    variables: Optional[Dict] = None,
) -> Dict[str, Any]:
    """Template engine for generating text from Jinja2 templates

    Args:
        action: Action to perform (create, render, list)
        template_name: Template name
        content: Template content for create action
        variables: Variables for rendering

    Returns:
        Dict with status and content
    """
    try:
        if action == "create":
            if not template_name or not content:
                return {
                    "status": "error",
                    "content": [{"text": "❌ Template name and content required"}],
                }

            template_path = get_template_path(template_name)

            syntax = Syntax(content, "jinja", theme="monokai", line_numbers=True)
            console.print(Panel(syntax, title=f"[green]Creating: {template_name}"))

            container_fs.write_text(template_path, content)

            console.print("[green]✓[/green] Template saved!")

            return {
                "status": "success",
                "content": [
                    {"text": f"✅ Created template: {template_name}"},
                    {"text": f"Path: {template_path}"},
                ],
            }

        elif action == "render":
            if not template_name:
                return {
                    "status": "error",
                    "content": [{"text": "❌ Template name required"}],
                }

            template_path = get_template_path(template_name)
            if not container_fs.exists(template_path):
                return {
                    "status": "error",
                    "content": [{"text": f"❌ Template not found: {template_name}"}],
                }

            vars_dict = variables or {}

            # Show variables
            if vars_dict:
                table = Table(show_header=True, header_style="bold magenta")
                table.add_column("Variable", style="cyan")
                table.add_column("Value", style="green")
                for k, v in vars_dict.items():
                    table.add_row(str(k), str(v))
                console.print(Panel(table, title="[blue]Variables"))

            tmpl_content = container_fs.read_text(template_path)

            tmpl = env.from_string(tmpl_content)
            rendered = tmpl.render(**vars_dict)

            console.print(Panel(rendered, title="[cyan]Rendered"))

            return {
                "status": "success",
                "content": [
                    {"text": "✅ Template rendered"},
                    {"text": f"Output:\n{rendered}"},
                ],
            }

        elif action == "list":
            templates: List[Dict[str, Any]] = []

            for path in sorted(container_fs.glob(posixpath.join(_template_dir(), "*.j2"))):
                tmpl_content = container_fs.read_text(path)
                templates.append(
                    {"name": posixpath.splitext(posixpath.basename(path))[0], "path": str(path), "content": tmpl_content}
                )

            if templates:
                table = Table(show_header=True, header_style="bold magenta")
                table.add_column("Template", style="cyan")
                table.add_column("Path", style="green")

                for tmpl in sorted(templates, key=lambda x: x["name"]):
                    table.add_row(tmpl["name"], tmpl["path"])

                console.print(Panel(table, title="[yellow]Templates"))
            else:
                console.print("[yellow]No templates found")

            content_list = [{"text": f"✅ Found {len(templates)} templates"}]
            for tmpl in templates:
                content_list.append({"text": f"\n{tmpl['name']}: {tmpl['path']}"})

            return {"status": "success", "content": content_list}

        return {
            "status": "error",
            "content": [{"text": f"❌ Unknown action: {action}"}],
        }

    except Exception as e:
        return {"status": "error", "content": [{"text": f"❌ Error: {str(e)}"}]}
