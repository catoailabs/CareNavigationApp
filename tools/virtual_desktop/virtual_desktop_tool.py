import subprocess
import json
import os
from typing import Any
from strands import tool

CONTAINER_NAME = "ron-agent-desktop"


def _exec_python(script: str) -> dict[str, Any]:
    cmd = ["docker", "exec", CONTAINER_NAME, "python3", "-c", script]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return {"ok": True, "stdout": res.stdout, "stderr": res.stderr}
    except subprocess.CalledProcessError as e:
        return {"ok": False, "stdout": e.stdout, "stderr": e.stderr}


@tool
def start_virtual_desktop_environment() -> str:
    """Start the virtual desktop environment (including OpenEMR and Orthanc) using docker compose. This will start the ron-agent-desktop container."""
    compose_dir = os.path.dirname(__file__)
    try:
        # Check if docker-compose is available or docker compose
        subprocess.run(
            ["docker", "compose", "up", "-d"],
            cwd=compose_dir,
            check=True,
            capture_output=True,
            text=True,
        )
        return "Virtual desktop environment started successfully. It may take a minute or two for OpenEMR to become fully ready."
    except subprocess.CalledProcessError as e:
        return f"Failed to start environment: {e.stderr}"


@tool
def stop_virtual_desktop_environment() -> str:
    """Stop the virtual desktop environment."""
    compose_dir = os.path.dirname(__file__)
    try:
        subprocess.run(
            ["docker", "compose", "down"],
            cwd=compose_dir,
            check=True,
            capture_output=True,
            text=True,
        )
        return "Virtual desktop environment stopped successfully."
    except subprocess.CalledProcessError as e:
        return f"Failed to stop environment: {e.stderr}"


@tool
def load_synthea_patients() -> str:
    """Load the pre-packaged Synthea patients into the OpenEMR instance running in the virtual desktop environment."""
    from .openemr_synthea_import import (
        import_synthea_patients,
        OpenEMRSyntheaImportConfig,
    )

    current_dir = os.path.dirname(os.path.abspath(__file__))
    synthea_dir = os.path.join(current_dir, "synthea", "fhir")
    spec_path = os.path.join(
        os.path.dirname(os.path.dirname(current_dir)),
        "tools",
        "open-api-specs",
        "openEMR.yml",
    )

    if not os.path.exists(synthea_dir):
        return f"Error: Synthea directory not found at {synthea_dir}"

    config = OpenEMRSyntheaImportConfig(
        openemr_base_url="http://localhost:80",
        synthea_dir=synthea_dir,
        spec_path=spec_path,
        oauth_username="admin",
        oauth_password="changeme_in_production",
    )
    try:
        report = import_synthea_patients(config)
        return f"Synthea patients loaded successfully: {json.dumps(report, indent=2)}"
    except Exception as e:
        return f"Failed to load Synthea patients: {str(e)}"


@tool
def desktop_click(x: int, y: int, click_type: str = "left") -> str:
    """Click at the specified coordinates on the virtual desktop. click_type can be 'left', 'right', or 'double'."""
    script = f'''
import pyautogui
import os
os.environ["DISPLAY"] = ":1"
os.environ["XAUTHORITY"] = "/config/.Xauthority"
pyautogui.FAILSAFE = True
if "{click_type}" == "double":
    pyautogui.doubleClick({x}, {y})
elif "{click_type}" == "right":
    pyautogui.rightClick({x}, {y})
else:
    pyautogui.click({x}, {y})
'''
    result = _exec_python(script)
    if result["ok"]:
        return f"Clicked {click_type} at ({x}, {y})"
    return f"Failed to click: {result['stderr']}"


@tool
def desktop_type_text(text: str) -> str:
    """Type text into the currently focused window on the virtual desktop."""
    # Escape quotes
    safe_text = text.replace('"', '\\"')
    script = f'''
import pyautogui
import os
os.environ["DISPLAY"] = ":1"
os.environ["XAUTHORITY"] = "/config/.Xauthority"
pyautogui.FAILSAFE = True
pyautogui.write("{safe_text}")
'''
    result = _exec_python(script)
    if result["ok"]:
        return f"Typed text of length {len(text)}"
    return f"Failed to type: {result['stderr']}"


@tool
def desktop_press_key(key: str) -> str:
    """Press a specific key on the virtual desktop (e.g., 'enter', 'tab', 'esc')."""
    script = f'''
import pyautogui
import os
os.environ["DISPLAY"] = ":1"
os.environ["XAUTHORITY"] = "/config/.Xauthority"
pyautogui.FAILSAFE = True
pyautogui.press("{key}")
'''
    result = _exec_python(script)
    if result["ok"]:
        return f"Pressed key '{key}'"
    return f"Failed to press key: {result['stderr']}"


@tool
def desktop_screenshot(path: str = "screenshot.png") -> str:
    """Take a screenshot of the virtual desktop and save it to the specified path inside the container's /workspace directory."""
    script = f"""
import pyautogui
import os
os.environ["DISPLAY"] = ":1"
os.environ["XAUTHORITY"] = "/config/.Xauthority"
pyautogui.FAILSAFE = True
screenshot = pyautogui.screenshot()
screenshot.save("/workspace/{path}")
"""
    result = _exec_python(script)
    if result["ok"]:
        return f"Screenshot saved to /workspace/{path}"
    return f"Failed to take screenshot: {result['stderr']}"
