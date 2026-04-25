import subprocess
import json
import os
from typing import Any, Optional
from strands import tool

CONTAINER_NAME = "ron-agent-desktop"


def _exec_python(script: str) -> dict[str, Any]:
    cmd = ["docker", "exec", CONTAINER_NAME, "python3", "-c", script]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return {"ok": True, "stdout": res.stdout, "stderr": res.stderr}
    except subprocess.CalledProcessError as e:
        return {"ok": False, "stdout": e.stdout, "stderr": e.stderr}


def _get_base_script() -> str:
    return """
import pyautogui
import os
import sys

# Configure environment for the display inside the container
os.environ["DISPLAY"] = os.environ.get("DISPLAY", ":1")
os.environ["XAUTHORITY"] = "/config/.Xauthority"

# PyAutoGUI settings
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.1
"""


@tool
def desktop_click(x: int, y: int, click_type: str = "left") -> str:
    """Click at the specified coordinates on the virtual desktop. click_type can be 'left', 'right', 'middle', or 'double'."""
    script = (
        _get_base_script()
        + f"""
if "{click_type}" == "double":
    pyautogui.doubleClick({x}, {y})
elif "{click_type}" == "right":
    pyautogui.rightClick({x}, {y})
elif "{click_type}" == "middle":
    pyautogui.middleClick({x}, {y})
else:
    pyautogui.click({x}, {y})
print(f"Clicked {click_type} at ({x}, {y})")
"""
    )
    result = _exec_python(script)
    if result["ok"]:
        return result["stdout"].strip() or f"Clicked {click_type} at ({x}, {y})"
    return f"Failed to click: {result['stderr']}"


@tool
def desktop_type_text(text: str) -> str:
    """Type text into the currently focused window on the virtual desktop."""
    # We use repr to safely encode the string in Python
    script = (
        _get_base_script()
        + f"""
text_to_type = {repr(text)}
pyautogui.write(text_to_type)
print(f"Typed text of length {{len(text_to_type)}}")
"""
    )
    result = _exec_python(script)
    if result["ok"]:
        return result["stdout"].strip() or f"Typed text of length {len(text)}"
    return f"Failed to type: {result['stderr']}"


@tool
def desktop_press_key(key: str) -> str:
    """Press a specific key on the virtual desktop (e.g., 'enter', 'tab', 'esc', 'space')."""
    script = (
        _get_base_script()
        + f"""
pyautogui.press("{key}")
print(f"Pressed key '{key}'")
"""
    )
    result = _exec_python(script)
    if result["ok"]:
        return result["stdout"].strip() or f"Pressed key '{key}'"
    return f"Failed to press key: {result['stderr']}"


@tool
def desktop_hotkey(keys: list[str]) -> str:
    """Press a combination of keys (hotkey) on the virtual desktop (e.g., ['ctrl', 'c'])."""
    keys_repr = repr(keys)
    script = (
        _get_base_script()
        + f"""
keys = {keys_repr}
pyautogui.hotkey(*keys)
print(f"Pressed hotkey {{'+'.join(keys)}}")
"""
    )
    result = _exec_python(script)
    if result["ok"]:
        return result["stdout"].strip() or f"Pressed hotkey {'+'.join(keys)}"
    return f"Failed to press hotkey: {result['stderr']}"


@tool
def desktop_scroll(
    direction: str, amount: int, x: Optional[int] = None, y: Optional[int] = None
) -> str:
    """Scroll the virtual desktop up, down, left, or right. amount is the number of clicks.
    Optionally move to (x, y) before scrolling."""
    script = (
        _get_base_script()
        + f"""
x = {x if x is not None else "None"}
y = {y if y is not None else "None"}
direction = "{direction}"
amount = {amount}

if x is not None and y is not None:
    pyautogui.moveTo(x, y)

multiplier = amount if direction in {{"up", "right"}} else -amount
if direction in {{"left", "right"}}:
    pyautogui.hscroll(multiplier)
else:
    pyautogui.scroll(multiplier)

print(f"Scrolled {{direction}} by {{amount}}")
"""
    )
    result = _exec_python(script)
    if result["ok"]:
        return result["stdout"].strip() or f"Scrolled {direction} by {amount}"
    return f"Failed to scroll: {result['stderr']}"


@tool
def desktop_drag_and_drop(
    from_x: int, from_y: int, to_x: int, to_y: int, duration_s: float = 1.0
) -> str:
    """Drag an item from (from_x, from_y) to (to_x, to_y) on the virtual desktop."""
    script = (
        _get_base_script()
        + f"""
pyautogui.moveTo({from_x}, {from_y})
pyautogui.dragTo({to_x}, {to_y}, duration={duration_s})
print(f"Dragged from ({from_x}, {from_y}) to ({to_x}, {to_y})")
"""
    )
    result = _exec_python(script)
    if result["ok"]:
        return (
            result["stdout"].strip()
            or f"Dragged from ({from_x}, {from_y}) to ({to_x}, {to_y})"
        )
    return f"Failed to drag and drop: {result['stderr']}"


@tool
def desktop_screenshot(path: str = "screenshot.jpg") -> dict[str, Any]:
    """Take a screenshot of the virtual desktop. Returns the compressed jpeg image data natively so you can see the screen, and also saves it to the specified path."""
    script = (
        _get_base_script()
        + f"""
import io
import base64
screenshot = pyautogui.screenshot()
screenshot.save("/workspace/{path}")

buffered = io.BytesIO()
# Convert to RGB to save as JPEG
if screenshot.mode != "RGB":
    screenshot = screenshot.convert("RGB")
screenshot.save(buffered, format="JPEG", quality=45, optimize=True)
img_str = base64.b64encode(buffered.getvalue()).decode()
print(img_str)
"""
    )
    result = _exec_python(script)
    if result["ok"]:
        import base64
        import hashlib
        import time
        from pathlib import Path

        b64_data = result["stdout"].strip()
        raw_bytes = base64.b64decode(b64_data)

        # Cache the image following strands framework pattern
        cache_dir = Path(
            os.getenv(
                "STRANDS_SCREENSHOT_CACHE_DIR", os.path.join("screenshots", "cache")
            )
        )
        cache_dir.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha1(raw_bytes).hexdigest()[:10]
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"desktop_{timestamp}_{digest}.jpg"
        cache_path = cache_dir / filename
        cache_path.write_bytes(raw_bytes)

        image_block = {
            "image": {"format": "jpeg", "source": {"bytes": raw_bytes}},
            "cache_path": str(cache_path),
        }

        return {
            "status": "success",
            "content": [
                image_block,
                {
                    "text": f"Screenshot ({round(len(raw_bytes) / 1024, 1)} KB, jpeg) saved to /workspace/{path}"
                },
            ],
        }
    return {
        "status": "error",
        "content": [{"text": f"Failed to take screenshot: {result['stderr']}"}],
    }


@tool
def start_virtual_desktop_environment() -> str:
    """Start the virtual desktop environment (including OpenEMR and Orthanc) using docker compose. This will start the ron-agent-desktop container."""
    compose_dir = os.path.dirname(__file__)
    try:
        subprocess.run(
            ["docker", "compose", "up", "-d"],
            cwd=compose_dir,
            check=True,
            capture_output=True,
            text=True,
        )

        # We can kick off the synthea load in the background, or inform the agent
        return "Virtual desktop environment started successfully on port 3001. OpenEMR is booting up and data is permanently persisted in Docker volumes. Use load_synthea_patients() if the database is fresh."
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

    # We load from the original open-api-specs path (assuming it exists in the main tools repo)
    spec_path = os.path.join(
        os.path.dirname(current_dir), "open-api-specs", "openEMR.yml"
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


VIRTUAL_DESKTOP_TOOLS = [
    desktop_click,
    desktop_type_text,
    desktop_press_key,
    desktop_hotkey,
    desktop_scroll,
    desktop_drag_and_drop,
    desktop_screenshot,
    start_virtual_desktop_environment,
    stop_virtual_desktop_environment,
    load_synthea_patients,
]
