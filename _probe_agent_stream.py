"""Temporary probe: observe REAL Strands xAI native-tool streaming.

Replicates agent.build_model() faithfully and dumps every raw stream_async
event so we can map true event shapes onto AI Elements. Writes JSONL to
_probe_events.jsonl and prints a human-readable trace + shape summary.
"""
from __future__ import annotations

import asyncio
import json
import os
from collections import Counter
from typing import Any

from dotenv import load_dotenv

load_dotenv()

from strands import Agent
from strands_xai import xAIModel
from xai_sdk.tools import code_execution, web_search, x_search

DEFAULT_MODEL_ID = "grok-4.3"

SYSTEM_PROMPT = (
    "You are a provider research assistant. Use native Grok tools when relevant: "
    "web_search for the live web, x_search for X/Twitter sentiment, code_execution for math. "
    "Cite sources."
)

PROMPT = (
    "Do two things and stream your reasoning: "
    "(1) use web_search to find the most recent publicly reported overall hospital "
    "rating or quality recognition for Mayo Clinic in Rochester, MN; "
    "(2) use x_search to gauge recent public sentiment on X about Mayo Clinic. "
    "Give a 3-sentence summary citing sources."
)


def build_model() -> xAIModel:
    return xAIModel(
        client_args={"api_key": os.getenv("XAI_API_KEY", "")},
        model_id=os.getenv("STRANDS_MODEL_ID", DEFAULT_MODEL_ID),
        xai_tools=[web_search(), x_search(), code_execution()],
        include=["inline_citations"],
        params={"temperature": 0.2, "top_p": 0.9},
    )


def safe(obj: Any, depth: int = 0) -> Any:
    """Best-effort JSON-serializable conversion with bytes/obj fallback."""
    if depth > 6:
        return f"<depth-limit {type(obj).__name__}>"
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    if isinstance(obj, bytes):
        return f"<bytes len={len(obj)}>"
    if isinstance(obj, dict):
        return {str(k): safe(v, depth + 1) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [safe(v, depth + 1) for v in obj]
    # pydantic / objects
    for attr in ("model_dump", "dict", "__dict__"):
        if hasattr(obj, attr):
            try:
                val = getattr(obj, attr)
                val = val() if callable(val) else val
                return {"__type__": type(obj).__name__, **safe(val, depth + 1)} if isinstance(val, dict) else safe(val, depth + 1)
            except Exception:
                pass
    return f"<{type(obj).__name__}>"


def trunc(s: str, n: int = 220) -> str:
    s = s.replace("\n", "\\n")
    return s if len(s) <= n else s[:n] + f"...(+{len(s)-n})"


async def main() -> None:
    if not os.getenv("XAI_API_KEY"):
        raise SystemExit("XAI_API_KEY not set")

    agent = Agent(model=build_model(), system_prompt=SYSTEM_PROMPT)

    shape_counter: Counter[str] = Counter()
    out = open("_probe_events.jsonl", "w")
    i = 0
    print("=" * 90)
    print("STREAMING REAL AGENT — model:", os.getenv("STRANDS_MODEL_ID", DEFAULT_MODEL_ID))
    print("=" * 90)

    async for event in agent.stream_async(PROMPT):
        i += 1
        s = safe(event)
        out.write(json.dumps({"i": i, "event": s}) + "\n")
        out.flush()

        if isinstance(event, dict):
            keys = ",".join(sorted(event.keys()))
            shape_counter[keys] += 1
            # Highlight the interesting signals
            tags = []
            if "reasoningText" in event or "reasoning_text" in event:
                tags.append("REASONING")
            if "data" in event:
                tags.append("TEXT")
            if any(k in event for k in ("current_tool_use", "tool_use", "toolUse")):
                tags.append("TOOL_USE")
            if "tool_stream_event" in event:
                tags.append("TOOL_STREAM")
            if any(k in event for k in ("citations", "sources", "inline_citations")):
                tags.append("CITATIONS")
            if "event" in event:  # raw model event envelope
                tags.append("RAW_EVENT")
            tagstr = (" [" + ",".join(tags) + "]") if tags else ""
            print(f"#{i:03d} keys={{{trunc(keys,120)}}}{tagstr}")
            # Show payloads for the signal-bearing events
            for k in ("data", "reasoningText", "reasoning_text"):
                if k in event and isinstance(event[k], str):
                    print(f"      {k}: {trunc(event[k])}")
            for k in ("current_tool_use", "tool_use", "toolUse", "tool_stream_event"):
                if k in event:
                    print(f"      {k}: {trunc(json.dumps(safe(event[k])))}")
            for k in ("citations", "sources", "inline_citations"):
                if k in event:
                    print(f"      {k}: {trunc(json.dumps(safe(event[k])))}")
        else:
            shape_counter[type(event).__name__] += 1
            print(f"#{i:03d} <{type(event).__name__}> {trunc(repr(event))}")

    out.close()
    print("=" * 90)
    print(f"TOTAL EVENTS: {i}")
    print("UNIQUE SHAPES (by key-set):")
    for shape, n in shape_counter.most_common():
        print(f"  {n:4d} x  {trunc(shape,140)}")
    print("Full JSONL -> _probe_events.jsonl")


if __name__ == "__main__":
    asyncio.run(main())
