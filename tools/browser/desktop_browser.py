"""`browser` tool that drives Chromium running on the agent's virtual desktop.

Chromium runs on the webtop desktop (see ``tools/virtual_desktop``) with CDP on
loopback ``127.0.0.1:9222`` *inside* that container. Chromium binds remote
debugging to loopback only and ignores ``--remote-debugging-address`` overrides,
so instead of publishing the port or running a relay we drive it the same way
the ``desktop_*`` tools do: ``docker exec`` + Playwright (already installed in
the desktop image) connecting to the loopback CDP endpoint. Every action lands
in the same browser the user watches in the desktop live-view — no cloud
browser, no published port, no bridge.

Defined as a module-level ``@tool`` so it is registered on the agent and is
fully discoverable by the tool catalog (static AST scan + runtime registry +
load/execute pathways).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from typing import Any

from strands import tool

logger = logging.getLogger(__name__)

CONTAINER_NAME = os.getenv("AGENT_DESKTOP_CONTAINER", "ron-agent-desktop")
CDP_URL = os.getenv("AGENT_DESKTOP_CDP_URL", "http://127.0.0.1:9222")
SHOT_PATH = os.getenv("AGENT_DESKTOP_BROWSER_SHOT", "/workspace/.runtime/agent-browser.png")
ACTION_TIMEOUT_S = int(os.getenv("AGENT_DESKTOP_BROWSER_TIMEOUT_S", "90"))

# Runs *inside* the desktop container. Reads a JSON arg, performs one action
# against the already-running Chromium, prints a JSON result, and disconnects
# without closing the browser (so the desktop session keeps its window).
_DRIVER = r"""
import sys, json, asyncio

async def main():
    args = json.loads(sys.argv[1])
    action = args["action"]
    from playwright.async_api import async_playwright
    pw = await async_playwright().start()
    browser = await pw.chromium.connect_over_cdp(args["cdp"])
    out = {"status": "ok"}
    try:
        ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        if action == "navigate":
            await page.goto(args.get("url", ""), wait_until="domcontentloaded", timeout=45000)
        elif action == "click":
            await page.click(args["selector"], timeout=30000)
        elif action == "type":
            await page.fill(args["selector"], args.get("text", ""), timeout=30000)
        elif action == "extract_text":
            sel = args.get("selector") or "body"
            out["text"] = (await page.locator(sel).first.inner_text())[:8000]
        elif action == "get_url":
            pass
        elif action == "screenshot":
            await page.screenshot(path=args.get("shot"))
            out["screenshot_path"] = args.get("shot")
        else:
            out = {"status": "error", "error": "unknown action: %s" % action}
        if out.get("status") == "ok":
            out["current_url"] = page.url
            out["title"] = await page.title()
    except Exception as exc:  # noqa: BLE001
        out = {"status": "error", "error": str(exc)}
    finally:
        # Disconnect only; never close() — that would kill the desktop's browser.
        try:
            await pw.stop()
        except Exception:
            pass
    print(json.dumps(out))

asyncio.run(main())
"""


@tool
def browser(action: str, url: str = "", selector: str = "", text: str = "") -> dict[str, Any]:
    """Drive the Chromium browser on the agent's virtual desktop, visible live to the user.

    Args:
        action: navigate | click | type | extract_text | get_url | screenshot
        url: target URL for ``navigate``
        selector: CSS selector for ``click`` / ``type`` / ``extract_text``
        text: text to type for ``type``
    """
    payload = {
        "cdp": CDP_URL,
        "action": action,
        "url": url,
        "selector": selector,
        "text": text,
        "shot": SHOT_PATH,
    }
    cmd = ["docker", "exec", CONTAINER_NAME, "python3", "-c", _DRIVER, json.dumps(payload)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=ACTION_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return {"status": "error", "content": [{"text": f"browser '{action}' timed out"}]}
    except FileNotFoundError:
        return {"status": "error", "content": [{"text": "docker not available to reach the agent desktop"}]}

    parsed: dict[str, Any] | None = None
    for line in reversed((res.stdout or "").strip().splitlines()):
        try:
            parsed = json.loads(line)
            break
        except json.JSONDecodeError:
            continue

    if parsed is None:
        detail = (res.stderr or "").strip() or "no output from desktop browser"
        logger.warning("desktop browser '%s' failed: %s", action, detail)
        return {"status": "error", "content": [{"text": detail[:2000]}]}

    if parsed.get("status") != "ok":
        return {
            "status": "error",
            "current_url": parsed.get("current_url"),
            "content": [{"text": parsed.get("error", "unknown browser error")}],
        }

    content: list[dict[str, Any]] = [
        {"json": {k: v for k, v in parsed.items() if k not in {"status", "text"}}}
    ]
    if parsed.get("text"):
        content.append({"text": parsed["text"]})
    return {"status": "ok", "current_url": parsed.get("current_url"), "content": content}
