"""Live agent tool-structure test.

Sends ONE test prompt to the REAL provider agent (real baseline tools from
server.agent_tooling + native Grok web_search/x_search) and records the full
structure of every tool event: native web_search, native x_search, and the
Strands perplexity_search_api tool — with images enabled — so we can map each
shape onto AI Elements ChainOfThought / Sources components.

Run: .venv/bin/python run_agent_tool_test.py
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

from dotenv import load_dotenv

load_dotenv()

from strands_xai import xAIModel
from xai_sdk.tools import code_execution, web_search, x_search

# THE REAL AGENT — same module the FastAPI server uses.
import agent as agent_mod

DEFAULT_MODEL_ID = os.getenv("STRANDS_MODEL_ID", "grok-4.3")

# Faithful to agent.build_model(), but with image/video understanding enabled so
# native search image structure is exercised. Injected into the REAL build_agent().
MODEL = xAIModel(
    client_args={"api_key": os.getenv("XAI_API_KEY", "")},
    model_id=DEFAULT_MODEL_ID,
    xai_tools=[
        web_search(enable_image_understanding=True),
        x_search(enable_image_understanding=True, enable_video_understanding=True),
        code_execution(),
    ],
    include=["inline_citations"],
    params={"temperature": 0.2, "top_p": 0.9},
)

PROMPT = (
    "This is a TOOL STRUCTURE TEST. I am inspecting the raw output shape of each of your tools. "
    "Please ACTUALLY INVOKE all three of the following tools in this single turn:\n"
    "1) web_search: find the current overall hospital quality rating / recognition for "
    "Mayo Clinic in Rochester, MN, and reference any relevant images you can see.\n"
    "2) x_search: find recent public sentiment on X (Twitter) about Mayo Clinic, including "
    "posts that contain images.\n"
    "3) perplexity_search_api: call it with query='Mayo Clinic Rochester patient reviews 2025', "
    "max_results=5, and return_images=true so it returns sources WITH images.\n"
    "After the tools return, give a 2-sentence synthesis and cite sources. "
    "It is essential for the test that you really call all three tools."
)

KEY_RE = re.compile(r"xai-[A-Za-z0-9_-]{12,}")


def safe(obj: Any, depth: int = 0) -> Any:
    if depth > 10:
        return f"<depth {type(obj).__name__}>"
    if isinstance(obj, str):
        return KEY_RE.sub("xai-REDACTED", obj)
    if isinstance(obj, (int, float, bool)) or obj is None:
        return obj
    if isinstance(obj, bytes):
        return f"<bytes len={len(obj)}>"
    if isinstance(obj, dict):
        # never serialize the live Agent object (carries api key + huge graph)
        return {str(k): safe(v, depth + 1) for k, v in obj.items() if k != "agent"}
    if isinstance(obj, (list, tuple)):
        return [safe(v, depth + 1) for v in obj]
    for attr in ("model_dump", "dict", "__dict__"):
        if hasattr(obj, attr):
            try:
                val = getattr(obj, attr)
                val = val() if callable(val) else val
                if isinstance(val, dict):
                    return {"__type__": type(obj).__name__, **safe(val, depth + 1)}
            except Exception:
                pass
    return f"<{type(obj).__name__}>"


def trunc(s: str, n: int = 400) -> str:
    s = s.replace("\n", "\\n")
    return s if len(s) <= n else s[:n] + f"...(+{len(s) - n})"


TOOL_KEYS = ("current_tool_use", "tool_use", "toolUse", "tool_stream_event", "toolResult", "tool_result")


async def main() -> None:
    if not os.getenv("XAI_API_KEY"):
        raise SystemExit("XAI_API_KEY not set")

    # THE REAL AGENT: real SYSTEM_PROMPT, real build_baseline_tools(), real hooks/retry.
    agent = agent_mod.build_agent(model=MODEL)
    print("[info] agent tools:", [getattr(t, "tool_name", getattr(t, "__name__", repr(t))) for t in getattr(agent, "tool_names", getattr(agent, "tools", []))] or "(built via build_agent)")

    out = open("_agent_tool_events.jsonl", "w")
    i = 0
    tool_hits: dict[str, int] = {}
    print("=" * 100)
    print("LIVE AGENT TOOL-STRUCTURE TEST — model:", DEFAULT_MODEL_ID)
    print("=" * 100)

    async for event in agent.stream_async(PROMPT):
        i += 1
        # strip the agent object up-front (defensive: no key leak, less noise)
        if isinstance(event, dict) and "agent" in event:
            event = {k: v for k, v in event.items() if k != "agent"}
        s = safe(event)
        out.write(json.dumps({"i": i, "event": s}) + "\n")
        out.flush()

        if not isinstance(event, dict):
            continue

        # Surface tool-bearing events prominently
        hit = [k for k in TOOL_KEYS if k in event]
        if hit:
            for k in hit:
                tool_hits[k] = tool_hits.get(k, 0) + 1
            payload = {k: safe(event[k]) for k in hit}
            name = ""
            for k in hit:
                v = event.get(k)
                if isinstance(v, dict):
                    name = v.get("name") or v.get("toolUseId") or name
            print(f"#{i:03d} TOOL[{','.join(hit)}] name={name!r} :: {trunc(json.dumps(payload), 600)}")

        # message events carry assembled content blocks (toolUse / toolResult / citations)
        if "message" in event and isinstance(event["message"], dict):
            content = event["message"].get("content", [])
            blocks = [list(b.keys())[0] if isinstance(b, dict) and b else type(b).__name__ for b in content] if isinstance(content, list) else content
            print(f"#{i:03d} MESSAGE role={event['message'].get('role')!r} blocks={blocks}")

    out.close()
    print("=" * 100)
    print(f"TOTAL EVENTS: {i}")
    print("TOOL EVENT COUNTS:", tool_hits)
    print("Full JSONL -> _agent_tool_events.jsonl")


if __name__ == "__main__":
    asyncio.run(main())
