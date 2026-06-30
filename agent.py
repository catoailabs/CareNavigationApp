import base64
import json
import logging
import logging.handlers
import os
import sys
import uuid
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import unquote_to_bytes

# Make in-repo tools importable by their canonical dotted paths
_PROJECT_ROOT = Path(__file__).resolve().parent
for _extra in (_PROJECT_ROOT, _PROJECT_ROOT / "tools" / "ronbrowser_agent_tools" / "src"):
    if str(_extra) not in sys.path:
        sys.path.insert(0, str(_extra))

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from strands import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.event_loop._retry import ModelRetryStrategy
from strands.hooks import AfterToolCallEvent
from strands.models import Model
from strands.tools.decorator import DecoratedFunctionTool
from strands.types.agent import AgentInput
from strands_xai import xAIModel
from xai_sdk.tools import code_execution, web_search, x_search

# Baseline tool modules. Every @tool-decorated callable in each of these is
# registered on the agent automatically via `_tools_in(...)`. Adding a new
# @tool to any of these files is picked up on next process start — no
# function-name list to maintain anywhere.
import tools.tool_catalog as _m_tool_catalog
import tools.virtual_desktop.virtual_desktop_tool as _m_virtual_desktop
import tools.browser.desktop_browser as _m_desktop_browser
import strands_tools.devops.shell as _m_shell
import strands_tools.devops.editor as _m_editor
import strands_tools.devops.environment as _m_environment
import strands_tools.agent_orchestration.mem0_memory as _m_mem0
import strands_tools.agent_orchestration.graph as _m_graph
import strands_tools.agent_orchestration.use_agent as _m_use_agent
import strands_tools.research.perplexity_search_api as _m_perplexity_search
import strands_tools.research.perplexity_deep_research as _m_perplexity_deep
from server import tool_catalog_support
from server import skills_support
from server import firebase_admin_support
from server import tenant_environment
from server import tenant_env_hooks
from server import google_credentials

logger = logging.getLogger(__name__)


def _configure_file_logging() -> None:
    """Install a size-capped rotating file handler on the module logger.

    Env vars (all optional):
      LOG_FILE         – log file path       (default: <project>/logs/agent_server.log)
      LOG_MAX_BYTES    – max bytes per file   (default: 52428800 = 50 MB)
      LOG_BACKUP_COUNT – rotated file count   (default: 5)
    """
    log_file = Path(os.getenv("LOG_FILE", str(_PROJECT_ROOT / "logs" / "agent_server.log")))
    log_file.parent.mkdir(parents=True, exist_ok=True)
    max_bytes = int(os.getenv("LOG_MAX_BYTES", str(50 * 1024 * 1024)))
    backup_count = int(os.getenv("LOG_BACKUP_COUNT", "5"))
    handler = logging.handlers.RotatingFileHandler(
        filename=str(log_file),
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


_configure_file_logging()

PROJECT_ROOT = _PROJECT_ROOT
ENV_PATH = PROJECT_ROOT / ".env"

BASELINE_TOOL_MODULES = (
    _m_tool_catalog,
    _m_shell,
    _m_editor,
    _m_environment,
    _m_mem0,
    _m_graph,
    _m_use_agent,
    _m_perplexity_search,
    _m_perplexity_deep,
    _m_virtual_desktop,
    _m_desktop_browser,
)


def _tools_in(module: Any) -> list[Any]:
    """Every @tool-decorated callable defined in `module`, in definition order."""
    return [
        obj
        for name, obj in vars(module).items()
        if isinstance(obj, DecoratedFunctionTool) and not name.startswith("_")
    ]


def build_baseline_tools(session_id: str | None = None) -> list[Any]:
    """Collect all @tool callables across BASELINE_TOOL_MODULES. This includes
    the ``browser`` tool (``tools.browser.desktop_browser``) that drives Chromium
    on the agent's virtual desktop over CDP, so the agent and the streamed
    desktop live-view share one visible browser. ``session_id`` is accepted for
    call-site parity."""
    tools: list[Any] = []
    for module in BASELINE_TOOL_MODULES:
        tools.extend(_tools_in(module))
    return tools
DEFAULT_AGENT_ID = "provider-research-agent"
DEFAULT_MODEL_ID = "grok-4.3"
SUPPORTED_DOCUMENT_FORMATS = {"pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"}
DOCUMENT_MEDIA_TYPE_TO_FORMAT = {
    "application/msword": "doc",
    "application/pdf": "pdf",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/csv": "csv",
    "text/html": "html",
    "text/markdown": "md",
    "text/plain": "txt",
}

load_dotenv(ENV_PATH)
# NOTE: Persisted variables are NO LONGER applied to the process ``os.environ``
# at startup. In the multi-tenant model every tenant's variables (including the
# legacy dev JSON store, ``data/agent_environment.json``) are loaded into a
# request-scoped overlay per uid (``tenant_environment.load_tenant_env``), so
# writing them into the shared process environment at boot would leak one
# tenant's secrets to every concurrently-served request. Process-level config
# comes from ``.env`` / the real ``os.environ`` only (loaded above).

# The use_google tool blocks on input() for mutative ops (e.g. gmail send)
# unless consent is bypassed. In this web/server context there is no TTY, so a
# prompt would hang the request. Default to bypass unless explicitly overridden.
os.environ.setdefault("BYPASS_TOOL_CONSENT", "true")

SYSTEM_PROMPT = """You are a provider research assistant.

Use the user's message as the source of truth. Call tools only when they materially improve the answer.

Available tools:
- npiLookup: query structured NPI provider records.
- perplexity_search_api: gather current public web sources for a provider or organization.
- perplexity_deep_research: start or fetch longer-running research when the user wants a deeper dossier.

Native Grok tools (run on xAI servers, invoke them directly when relevant):
- web_search: search the live web for current information and cite sources.
- x_search: search X (Twitter) for posts, trends, and public sentiment about a provider or organization.
- code_execution: run Python to compute, parse, or analyze data when a calculation would help.

Do not invent tool results, simulate workflows, or call tools that are not relevant to the user's request.
If a tool is unavailable or returns no useful data, say that plainly and continue with the evidence you do have.
"""


def build_model() -> xAIModel:
    return xAIModel(
        client_args={"api_key": os.getenv("XAI_API_KEY", "")},
        model_id=os.getenv("STRANDS_MODEL_ID", DEFAULT_MODEL_ID),
        # Grok's native server-side tools, executed on xAI's infrastructure.
        # Per the Strands xAI provider docs, passing xai_tools also auto-enables
        # use_encrypted_content so server-side tool state survives multi-turn.
        xai_tools=[web_search(), x_search(), code_execution()],
        include=["inline_citations"],
        params={
            "temperature": 0.2,
            "top_p": 0.9,
        },
    )


def validate_agent_configuration(model: Model | None = None) -> None:
    if model is None and not os.getenv("XAI_API_KEY"):
        raise RuntimeError("XAI_API_KEY must be set to build the default Strands xAI model.")


def build_agent(
    *,
    model: Model | None = None,
    messages: list[dict[str, Any]] | None = None,
    conversation_manager: Any | None = None,
    retry_strategy: Any | None = None,
    session_id: str | None = None,
    system_prompt: str | None = None,
) -> Agent:
    validate_agent_configuration(model)
    kwargs: dict[str, Any] = {
        "model": model or build_model(),
        "system_prompt": system_prompt or SYSTEM_PROMPT,
        "tools": build_baseline_tools(session_id),
        "agent_id": os.getenv("STRANDS_AGENT_ID", DEFAULT_AGENT_ID),
        "retry_strategy": retry_strategy or ModelRetryStrategy(),
        "hooks": [tenant_env_hooks.TenantEnvHookProvider()],
    }
    if messages is not None:
        kwargs["messages"] = messages
    if conversation_manager is not None:
        kwargs["conversation_manager"] = conversation_manager
    return Agent(**kwargs)


def _build_conversation_manager() -> SlidingWindowConversationManager:
    window_size = int(os.getenv("STRANDS_CONVERSATION_WINDOW_SIZE", "40"))
    return SlidingWindowConversationManager(window_size=window_size, per_turn=1)


async def _create_agent_for_request(
    model: Model | None,
    messages: list[dict[str, Any]],
    session_id: str | None = None,
    system_prompt: str | None = None,
) -> Agent:
    return build_agent(
        model=model,
        messages=messages,
        conversation_manager=_build_conversation_manager(),
        session_id=session_id,
        system_prompt=system_prompt,
    )





def _parse_tool_input(tool_input: Any) -> object:
    if tool_input is None:
        return {}
    if not isinstance(tool_input, str):
        return tool_input
    stripped = tool_input.strip()
    if not stripped:
        return {}
    try:
        return json.loads(stripped)
    except ValueError:
        return stripped


def _normalize_tool_source(source: Any) -> Any:
    if not isinstance(source, dict):
        return source
    normalized = {k: v for k, v in source.items() if k not in {"bytes", "byteLength"}}
    raw_bytes = source.get("bytes")
    if isinstance(raw_bytes, (bytes, bytearray, memoryview)):
        normalized["byteLength"] = len(raw_bytes)
    elif "byteLength" in source:
        normalized["byteLength"] = source["byteLength"]
    return normalized


def _parse_tool_output(content: list[dict[str, Any]] | None) -> list[object]:
    if not content:
        return []
    normalized: list[object] = []
    for block in content:
        if "text" in block:
            normalized.append({"text": block["text"]})
        elif "json" in block:
            normalized.append(block["json"])
        elif "image" in block and isinstance(block["image"], dict):
            image = dict(block["image"])
            if "source" in image:
                image["source"] = _normalize_tool_source(image["source"])
            normalized.append({"image": image})
        elif "document" in block and isinstance(block["document"], dict):
            document = dict(block["document"])
            if "source" in document:
                document["source"] = _normalize_tool_source(document["source"])
            normalized.append({"document": document})
        else:
            normalized.append(block)
    return normalized


def _tool_result_payloads(
    tool_result: dict[str, Any],
    active_tools: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    tool_id = str(tool_result.get("toolUseId", ""))
    tool_info = active_tools.pop(tool_id, {})
    return [
        {
            "type": "tool-input-available",
            "toolCallId": tool_id,
            "toolName": str(tool_info.get("name", "unknown")),
            "input": _parse_tool_input(tool_info.get("input")),
            "dynamic": True,
        },
        {
            "type": "tool-output-available",
            "toolCallId": tool_id,
            "output": _parse_tool_output(tool_result.get("content")),
            "dynamic": True,
        },
    ]


# Tools whose image output is an ephemeral *screen capture* (a full-page
# browser/desktop screenshot) rather than a content image the model is meant to
# reason over (e.g. ``image_reader``, ``generate_image``, DICOM viewers). Their
# raw bytes are only useful at the moment they are produced; left in the
# conversation history they balloon the model context (and cost) on every
# subsequent turn. Add new screen-capture tools here as they are introduced.
SCREEN_CAPTURE_TOOLS: frozenset[str] = frozenset(
    {"browser", "local_chromium_browser", "use_computer", "desktop_screenshot"}
)

# Stand-in left in the model context where a screenshot was lifted out, so the
# model still knows a capture happened without carrying the bytes.
SCREENSHOT_CONTEXT_PLACEHOLDER = "[screenshot omitted from model context; shown to the user]"


def _strip_screenshots_for_context(event: AfterToolCallEvent) -> None:
    """Lift screen-capture screenshots out of the model context, buffering them.

    Registered as an ``AfterToolCallEvent`` callback. For screen-capture tools
    only (``SCREEN_CAPTURE_TOOLS``), each image block in the tool result is
    replaced by a short text placeholder and the original image is stashed on
    the agent's per-request ``_screenshot_buffer`` keyed by ``toolUseId``. The
    streaming layer (:func:`strands_to_aisdk_stream`) drains that buffer and
    re-emits the screenshot to the client as an AI SDK file part, so the user
    still sees it without the bytes living in the model's context window.
    """
    tool_use = getattr(event, "tool_use", None) or {}
    if tool_use.get("name") not in SCREEN_CAPTURE_TOOLS:
        return
    result = getattr(event, "result", None)
    if not isinstance(result, dict):
        return
    content = result.get("content")
    if not isinstance(content, list):
        return

    buffered: list[dict[str, Any]] = []
    rewritten: list[Any] = []
    for block in content:
        image = block.get("image") if isinstance(block, dict) else None
        source = image.get("source") if isinstance(image, dict) else None
        raw = source.get("bytes") if isinstance(source, dict) else None
        if isinstance(raw, (bytes, bytearray, memoryview)):
            buffered.append({"format": str(image.get("format") or "png"), "bytes": bytes(raw)})
            rewritten.append({"text": SCREENSHOT_CONTEXT_PLACEHOLDER})
        else:
            rewritten.append(block)

    if not buffered:
        return
    result["content"] = rewritten
    buffer = getattr(event.agent, "_screenshot_buffer", None)
    if not isinstance(buffer, dict):
        buffer = {}
        event.agent._screenshot_buffer = buffer
    buffer.setdefault(str(tool_use.get("toolUseId", "")), []).extend(buffered)


def _drain_screenshot_file_parts(session_agent: Agent, tool_id: str) -> list[dict[str, Any]]:
    """Pop any buffered screenshots for ``tool_id`` as AI SDK file parts.

    Draining (rather than copying) guarantees a duplicate tool-result event for
    the same ``toolUseId`` cannot re-emit the same screenshot twice.
    """
    buffer = getattr(session_agent, "_screenshot_buffer", None)
    if not isinstance(buffer, dict):
        return []
    shots = buffer.pop(tool_id, None) or []
    parts: list[dict[str, Any]] = []
    for shot in shots:
        raw = shot.get("bytes")
        if not isinstance(raw, (bytes, bytearray, memoryview)):
            continue
        media_type = f"image/{str(shot.get('format') or 'png')}"
        encoded = base64.b64encode(bytes(raw)).decode("ascii")
        parts.append(
            {"type": "file", "mediaType": media_type, "url": f"data:{media_type};base64,{encoded}"}
        )
    return parts


def _extract_sources(tool_result: dict[str, Any]) -> list[dict[str, str]]:
    """Pull citation entries out of a Strands tool_result so they can be
    re-emitted as AI SDK v6 source-url parts.

    Looks at top-level `content` blocks for `{"json": {<key>: [...]}}` shapes
    where <key> is one of `sources`, `citations`, `results`, `documents`.
    Each entry may be a dict with `url`/`link`/`href` (plus optional title) OR
    a bare URL string (perplexity_deep_research returns string citations in
    some response shapes). Title is optional; falls back to URL when missing.
    """
    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    content = tool_result.get("content") or []
    for block in content:
        if not isinstance(block, dict):
            continue
        payload = block.get("json")
        if not isinstance(payload, dict):
            continue
        for key in ("sources", "citations", "results", "documents"):
            collection = payload.get(key)
            if not isinstance(collection, list):
                continue
            for item in collection:
                url: str | None = None
                title: str | None = None
                if isinstance(item, str) and item.startswith(("http://", "https://")):
                    url = item
                elif isinstance(item, dict):
                    candidate = item.get("url") or item.get("link") or item.get("href")
                    if isinstance(candidate, str):
                        url = candidate
                    raw_title = item.get("title") or item.get("name")
                    if isinstance(raw_title, str):
                        title = raw_title
                if url and url not in seen:
                    seen.add(url)
                    entries.append({"url": url, "title": title or url})
    return entries


def _decode_data_url(value: str) -> tuple[str | None, bytes] | None:
    if not value.startswith("data:") or "," not in value:
        return None
    header, payload = value.split(",", 1)
    media_type = header[5:].split(";", 1)[0] or None
    try:
        if ";base64" in header:
            return media_type, base64.b64decode(payload)
        return media_type, unquote_to_bytes(payload)
    except ValueError:
        return None


def _guess_document_format(filename: str, media_type: str) -> str | None:
    suffix = Path(filename).suffix.lower().lstrip(".")
    if suffix in SUPPORTED_DOCUMENT_FORMATS:
        return suffix
    return DOCUMENT_MEDIA_TYPE_TO_FORMAT.get(media_type.lower())


def _file_part_to_content_block(part: dict[str, Any]) -> dict[str, Any] | None:
    url = part.get("url")
    if not isinstance(url, str) or not url:
        return None

    filename = str(part.get("filename") or "attachment")
    media_type = str(part.get("mediaType") or "").lower()
    decoded = _decode_data_url(url)
    if decoded is None:
        label = f"{filename} ({media_type})" if media_type else filename
        return {"text": f"[Attached file: {label}]"}

    decoded_media_type, raw_bytes = decoded
    effective_media_type = (decoded_media_type or media_type or "application/octet-stream").lower()
    if effective_media_type.startswith("image/"):
        image_format = effective_media_type.split("/", 1)[1].split(";", 1)[0] or "png"
        if image_format == "jpg":
            image_format = "jpeg"
        return {"image": {"format": image_format, "source": {"bytes": raw_bytes}}}

    document_format = _guess_document_format(filename, effective_media_type)
    if document_format is not None:
        return {
            "document": {
                "format": document_format,
                "name": filename,
                "source": {"bytes": raw_bytes},
            }
        }

    return {"text": f"[Attached file: {filename} ({effective_media_type})]"}


def _assistant_tool_part_to_text_block(part: dict[str, Any]) -> dict[str, Any] | None:
    tool_name = str(part.get("toolName") or part.get("type") or "tool")
    state = str(part.get("state") or "")

    if state == "output-available" and "output" in part:
        try:
            summary = json.dumps(part["output"], ensure_ascii=True)
        except TypeError:
            summary = str(part["output"])
        if len(summary) > 4000:
            summary = f"{summary[:4000]}... [truncated]"
        return {"text": f"[Tool {tool_name} output]\n{summary}"}

    if state == "output-error":
        error_text = str(part.get("errorText") or "Tool execution failed.")
        return {"text": f"[Tool {tool_name} error]\n{error_text}"}

    return None


def _legacy_content_to_blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"text": content}] if content.strip() else []
    if not isinstance(content, list):
        return []

    blocks: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"].strip():
            blocks.append({"text": part["text"]})
    return blocks


def _ui_message_to_strands_message(message: dict[str, Any]) -> dict[str, Any] | None:
    role = message.get("role")
    if role not in {"user", "assistant"}:
        return None

    blocks: list[dict[str, Any]] = []
    parts = message.get("parts")
    if isinstance(parts, list):
        for part in parts:
            if not isinstance(part, dict):
                continue
            part_type = part.get("type")
            if part_type == "text" and isinstance(part.get("text"), str) and part["text"].strip():
                blocks.append({"text": part["text"]})
                continue
            if role == "user" and part_type == "file":
                file_block = _file_part_to_content_block(part)
                if file_block is not None:
                    blocks.append(file_block)
                continue
            if role == "assistant" and isinstance(part_type, str) and (
                part_type == "dynamic-tool" or part_type.startswith("tool-")
            ):
                tool_block = _assistant_tool_part_to_text_block(part)
                if tool_block is not None:
                    blocks.append(tool_block)

    if not blocks:
        blocks = _legacy_content_to_blocks(message.get("content"))

    if not blocks:
        return None

    return {"role": role, "content": blocks}


def ui_messages_to_agent_input(messages: Any) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return []

    normalized_messages: list[dict[str, Any]] = []
    for raw_message in messages:
        if not isinstance(raw_message, dict):
            continue
        strands_message = _ui_message_to_strands_message(raw_message)
        if strands_message is not None:
            normalized_messages.append(strands_message)
    return normalized_messages


def _graph_data_part(tool_stream_event: Any) -> dict[str, Any] | None:
    """Translate a Strands multi-agent Graph stream event into a ``data-graph``
    UI-message part. Returns ``None`` for events the workflow UI ignores.

    The graph tool yields raw ``MultiAgentStreamEvent`` dicts (and a custom
    ``graph_topology`` envelope); the SDK wraps each in a ``ToolStreamEvent`` so
    they surface here as ``tool_stream``. Each emitted part carries the owning
    ``toolCallId`` so the client can key the live DAG to the right tool call.
    Parts are emitted without an ``id`` so the SDK appends (rather than
    replaces) them, preserving the event log the workflow replays.
    """
    if not isinstance(tool_stream_event, dict):
        return None
    tool_use = tool_stream_event.get("tool_use") or {}
    tool_call_id = tool_use.get("toolUseId", "")
    data = tool_stream_event.get("data")
    if not tool_call_id or not isinstance(data, dict):
        return None

    event_type = data.get("type")
    part: dict[str, Any] | None = None

    if event_type == "graph_topology":
        topology = data.get("topology") or {}
        part = {
            "kind": "topology",
            "nodes": [
                {"id": n.get("id"), "role": n.get("role"), "model": n.get("model_provider")}
                for n in topology.get("nodes", [])
                if isinstance(n, dict)
            ],
            "edges": [
                {"from": e.get("from"), "to": e.get("to")}
                for e in topology.get("edges", [])
                if isinstance(e, dict)
            ],
            "entryPoints": list(topology.get("entry_points", [])),
        }
    elif event_type == "multiagent_node_start":
        part = {
            "kind": "node_start",
            "nodeId": data.get("node_id"),
            "nodeType": data.get("node_type"),
        }
    elif event_type == "multiagent_node_stop":
        node_result = data.get("node_result")
        status = getattr(getattr(node_result, "status", None), "value", None)
        part = {
            "kind": "node_stop",
            "nodeId": data.get("node_id"),
            "status": status,
            "executionTime": getattr(node_result, "execution_time", None),
        }
    elif event_type == "multiagent_handoff":
        part = {
            "kind": "handoff",
            "from": list(data.get("from_node_ids", [])),
            "to": list(data.get("to_node_ids", [])),
        }
    elif event_type == "multiagent_node_stream":
        inner = data.get("event")
        delta = inner.get("data") if isinstance(inner, dict) else None
        if isinstance(delta, str) and delta:
            part = {"kind": "node_text", "nodeId": data.get("node_id"), "delta": delta}

    if part is None:
        return None
    part["toolCallId"] = tool_call_id
    return {"type": "data-graph", "data": part}


async def strands_to_aisdk_stream(
    prompt: AgentInput,
    session_agent: Agent,
) -> AsyncIterator[str]:
    msg_id = str(uuid.uuid4())
    text_id = f"text_{uuid.uuid4().hex[:16]}"
    reasoning_id = f"reasoning_{uuid.uuid4().hex[:16]}"
    in_text = False
    in_reasoning = False
    active_tools: dict[str, dict[str, Any]] = {}

    yield f"data: {json.dumps({'type': 'start', 'messageId': msg_id})}\n\n"
    yield f"data: {json.dumps({'type': 'start-step'})}\n\n"

    async for event in session_agent.stream_async(prompt):
        if "data" in event and "delta" in event:
            if in_reasoning:
                yield f"data: {json.dumps({'type': 'reasoning-end', 'id': reasoning_id})}\n\n"
                in_reasoning = False
                reasoning_id = f"reasoning_{uuid.uuid4().hex[:16]}"
            if not in_text:
                yield f"data: {json.dumps({'type': 'text-start', 'id': text_id})}\n\n"
                in_text = True
            delta = event.get("data", "")
            if delta:
                yield f"data: {json.dumps({'type': 'text-delta', 'id': text_id, 'delta': delta})}\n\n"
            continue

        if event.get("reasoning") and "reasoningText" in event:
            if in_text:
                yield f"data: {json.dumps({'type': 'text-end', 'id': text_id})}\n\n"
                in_text = False
                text_id = f"text_{uuid.uuid4().hex[:16]}"
            if not in_reasoning:
                yield f"data: {json.dumps({'type': 'reasoning-start', 'id': reasoning_id})}\n\n"
                in_reasoning = True
            yield (
                f"data: {json.dumps({'type': 'reasoning-delta', 'id': reasoning_id, 'delta': event['reasoningText']})}\n\n"
            )
            continue

        if event.get("type") == "tool_use_stream":
            tool_use = event.get("current_tool_use", {})
            tool_id = tool_use.get("toolUseId", "")
            tool_name = tool_use.get("name", "")
            if tool_id and tool_id not in active_tools:
                active_tools[tool_id] = {"name": tool_name, "input": ""}
                if in_reasoning:
                    yield f"data: {json.dumps({'type': 'reasoning-end', 'id': reasoning_id})}\n\n"
                    in_reasoning = False
                    reasoning_id = f"reasoning_{uuid.uuid4().hex[:16]}"
                if in_text:
                    yield f"data: {json.dumps({'type': 'text-end', 'id': text_id})}\n\n"
                    in_text = False
                    text_id = f"text_{uuid.uuid4().hex[:16]}"
                yield (
                    f"data: {json.dumps({'type': 'tool-input-start', 'toolCallId': tool_id, 'toolName': tool_name, 'dynamic': True})}\n\n"
                )
            tool_input = tool_use.get("input")
            if tool_id and isinstance(tool_input, str):
                previous_input = str(active_tools[tool_id].get("input", ""))
                input_delta = (
                    tool_input[len(previous_input):]
                    if tool_input.startswith(previous_input)
                    else tool_input
                )
                active_tools[tool_id]["input"] = tool_input
                if input_delta:
                    yield (
                        f"data: {json.dumps({'type': 'tool-input-delta', 'toolCallId': tool_id, 'inputTextDelta': input_delta})}\n\n"
                    )
            elif tool_id:
                active_tools[tool_id]["input"] = tool_input
            continue

        if event.get("type") == "tool_stream":
            payload = _graph_data_part(event.get("tool_stream_event", {}))
            if payload is not None:
                yield f"data: {json.dumps(payload)}\n\n"
            continue

        if event.get("type") == "tool_result" and isinstance(event.get("tool_result"), dict):
            tool_result = event["tool_result"]
            for payload in _tool_result_payloads(tool_result, active_tools):
                yield f"data: {json.dumps(payload)}\n\n"
            for file_part in _drain_screenshot_file_parts(
                session_agent, str(tool_result.get("toolUseId", ""))
            ):
                yield f"data: {json.dumps(file_part)}\n\n"
            for source in _extract_sources(tool_result):
                yield (
                    f"data: {json.dumps({'type': 'source-url', 'sourceId': uuid.uuid4().hex, 'url': source['url'], 'title': source['title']})}\n\n"
                )
            continue

        if isinstance(event.get("message"), dict):
            content = event["message"].get("content", [])
            for block in content:
                if isinstance(block, dict) and "toolResult" in block:
                    tool_result = block["toolResult"]
                    for payload in _tool_result_payloads(tool_result, active_tools):
                        yield f"data: {json.dumps(payload)}\n\n"
                    for file_part in _drain_screenshot_file_parts(
                        session_agent, str(tool_result.get("toolUseId", ""))
                    ):
                        yield f"data: {json.dumps(file_part)}\n\n"
                    for source in _extract_sources(tool_result):
                        yield (
                            f"data: {json.dumps({'type': 'source-url', 'sourceId': uuid.uuid4().hex, 'url': source['url'], 'title': source['title']})}\n\n"
                        )
            continue

        if "result" in event:
            continue

    if in_text:
        yield f"data: {json.dumps({'type': 'text-end', 'id': text_id})}\n\n"
    if in_reasoning:
        yield f"data: {json.dumps({'type': 'reasoning-end', 'id': reasoning_id})}\n\n"

    yield f"data: {json.dumps({'type': 'finish-step'})}\n\n"
    yield f"data: {json.dumps({'type': 'finish', 'finishReason': 'stop'})}\n\n"
    yield "data: [DONE]\n\n"


async def stream_with_request_context(
    prompt: AgentInput,
    session_agent: Agent,
    uid: str,
) -> AsyncIterator[str]:
    """Bind the request-scoped tenant env overlay, then proxy the stream.

    The overlay is set inside this async generator (the same task that drives
    ``stream_async``) so it propagates into tool execution, and is reset when
    the stream completes or the client disconnects. The tenant overlay scopes
    every ``environment`` tool read/write to ``uid`` so secrets never bleed
    across concurrently served users. The user's Google credentials travel in
    the overlay as ``GOOGLE_OAUTH_CREDENTIALS`` (read by ``use_google``); there
    is no separate credential contextvar.
    """
    tenant_token = tenant_environment.load_tenant_env(uid)
    try:
        async for chunk in strands_to_aisdk_stream(prompt, session_agent):
            yield chunk
    finally:
        tenant_environment.reset_tenant_env(tenant_token)


_DEV_CORS_ORIGINS = ("http://127.0.0.1:5173", "http://localhost:5173")
_PROD_ENV_NAMES = {"prod", "production"}


def _build_cors_origins() -> list[str]:
    """Resolve the CORS allowlist from env, failing closed in production.

    Reads ``CORS_ALLOWED_ORIGINS`` (comma-separated). When unset, dev returns
    the Vite localhost pair; prod raises so the server cannot boot wildcard-open.
    """
    raw = os.getenv("CORS_ALLOWED_ORIGINS", "").strip()
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    env = os.getenv("APP_ENV", "development").strip().lower()
    if env in _PROD_ENV_NAMES:
        raise RuntimeError(
            "CORS_ALLOWED_ORIGINS must be set in production "
            "(comma-separated allowlist of trusted origins)."
        )
    return list(_DEV_CORS_ORIGINS)


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_build_cors_origins(),
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["content-type", "authorization", "x-session-id"],
    allow_credentials=False,
    expose_headers=["x-vercel-ai-ui-message-stream"],
    max_age=600,
)


def _build_system_prompt_with_mentions(mentions: list[str] | None) -> str | None:
    """Return a system prompt variant that lists referenced context.

    Env-var values are never included; only the token reference is shown.
    """
    if not mentions:
        return None
    clean = [str(m).strip() for m in mentions if str(m).strip()]
    if not clean:
        return None

    labels: list[str] = []
    for token in clean:
        if token.startswith("@env:"):
            labels.append(f"{token[5:]} (env)")
        elif token.startswith("@tool:"):
            labels.append(f"{token[6:]} (tool)")
        elif token.startswith("@connector:"):
            labels.append(f"{token[11:]} (connector)")
        elif token.startswith("@skill:"):
            labels.append(f"{token[7:]} (skill)")
        elif token.startswith("@openapi:"):
            labels.append(f"{token[9:]} (openapi)")
        elif token.startswith("@toolset:"):
            labels.append(f"{token[9:]} (toolset)")
        else:
            labels.append(token)

    note = "Referenced context: " + ", ".join(labels) + ".\nUse these resources when relevant."
    return f"{SYSTEM_PROMPT}\n\n{note}"


@app.post("/api/chat")
async def chat_endpoint(request: Request) -> StreamingResponse:
    uid = firebase_admin_support.resolve_uid(request)
    body = await request.json()
    messages = body.get("messages", [])
    prompt = ui_messages_to_agent_input(messages)
    if not prompt:
        raise HTTPException(status_code=400, detail="No chat message content was provided.")
    last_role = None
    if isinstance(messages, list) and messages and isinstance(messages[-1], dict):
        last_role = messages[-1].get("role")
    session_id = body.get("sessionId") or body.get("session_id")
    mentions = body.get("mentions")
    if isinstance(mentions, str):
        mentions = [mentions]
    mentions = [str(m).strip() for m in (mentions or []) if str(m).strip()]
    system_prompt = _build_system_prompt_with_mentions(mentions)

    # The user's Google credentials (if connected) live in the tenant overlay as
    # ``GOOGLE_OAUTH_CREDENTIALS`` and are bound for this request by
    # ``stream_with_request_context`` -> ``load_tenant_env(uid)``. ``use_google``
    # reads them from the overlay, so no separate credential injection is needed.
    logger.info(
        "chat_request uid=%s message_count=%s trigger=%s last_role=%s converted_messages=%s session_id=%s mentions=%s",
        uid,
        len(messages) if isinstance(messages, list) else 0,
        body.get("trigger"),
        last_role,
        len(prompt),
        session_id,
        len(mentions),
    )
    session_agent = await _create_agent_for_request(None, prompt, session_id, system_prompt)
    return StreamingResponse(
        stream_with_request_context(prompt, session_agent, uid),
        media_type="text/event-stream",
        headers={
            "x-vercel-ai-ui-message-stream": "v1",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/settings/environment")
async def get_environment_settings(request: Request) -> dict[str, Any]:
    """Return the signed-in user's environment variables (sensitive values masked)."""
    uid = firebase_admin_support.resolve_uid(request)
    return {
        "schema_version": 1,
        "variables": tenant_environment.tenant_env_list_for_uid(uid),
    }


@app.post("/api/settings/environment")
async def set_environment_setting(request: Request) -> dict[str, Any]:
    uid = firebase_admin_support.resolve_uid(request)
    body = await request.json()
    name = body.get("name")
    value = body.get("value")
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail="name is required")
    if value is None:
        raise HTTPException(status_code=400, detail="value is required")
    try:
        tenant_environment.tenant_env_set_for_uid(uid, name, str(value))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "name": name.strip()}


@app.delete("/api/settings/environment/{name}")
async def delete_environment_setting(name: str, request: Request) -> dict[str, Any]:
    uid = firebase_admin_support.resolve_uid(request)
    try:
        tenant_environment.tenant_env_delete_for_uid(uid, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"success": True, "name": name.strip()}


@app.get("/api/catalog")
async def get_catalog() -> dict[str, Any]:
    """Discover tools, connectors, skills, OpenAPI specs, and toolsets."""
    overview = tool_catalog_support.build_catalog_overview(None)
    skills_catalog = skills_support.build_skills_catalog()
    return {
        "schema_version": 1,
        "tools": overview.get("categories", []),
        "connectors": [
            category
            for category in overview.get("categories", [])
            if category.get("mcp_servers")
        ],
        "skills": skills_catalog.get("skills", []),
        "openapiSpecs": [
            category
            for category in overview.get("categories", [])
            if category.get("openapi_specs")
        ],
        "toolsets": overview.get("toolsets", []),
    }


@app.get("/api/google/scopes")
async def get_google_scopes() -> dict[str, Any]:
    """Return the selectable Google scope catalog for the connect UI."""
    return {"schema_version": 1, "scopes": google_credentials.scope_catalog()}


@app.get("/api/google/status")
async def get_google_status(request: Request) -> dict[str, Any]:
    """Report whether the signed-in user has connected Google, and which scopes.

    Derived from the tenant store: presence of the sensitive
    ``GOOGLE_OAUTH_CREDENTIALS`` var means "connected". The granted scopes are
    parsed from the (owner-only) stored authorized-user JSON so the connect UI
    can pre-check them. The secret itself is never returned.
    """
    uid = firebase_admin_support.resolve_uid(request)
    meta = tenant_environment.tenant_env_metadata_for_uid(uid, "GOOGLE_OAUTH_CREDENTIALS")
    if not meta or not meta.get("present"):
        return {"connected": False, "scopes": []}
    scopes: list[str] = []
    raw = tenant_environment.tenant_env_get_for_uid(uid, "GOOGLE_OAUTH_CREDENTIALS")
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict) and isinstance(parsed.get("scopes"), list):
                scopes = [str(s) for s in parsed["scopes"]]
        except (ValueError, TypeError) as exc:
            logger.warning("Failed to parse stored Google scopes for uid=%s: %s", uid, exc)
    return {
        "connected": True,
        "scopes": scopes,
        "updated_at": meta.get("updated_at"),
    }


@app.post("/api/google/connect")
async def connect_google(request: Request) -> dict[str, Any]:
    """Exchange a GIS authorization code for tokens and persist them per uid.

    Only the per-user secret material (the refresh token and the granted
    scopes) is persisted, as the sensitive tenant var ``GOOGLE_OAUTH_CREDENTIALS``
    (encrypted at rest by the tenant store), which ``use_google`` reads from the
    request overlay. The app-level OAuth client id/secret are backend-owned,
    process-protected values and are deliberately NOT stored here — they are
    re-attached from process env at credential-build time so the app secret
    never lands in a model-reachable tenant var.
    """
    uid = firebase_admin_support.resolve_uid(request)
    body = await request.json()
    code = body.get("code")
    if not isinstance(code, str) or not code.strip():
        raise HTTPException(status_code=400, detail="code is required")
    redirect_uri = body.get("redirectUri") or body.get("redirect_uri") or "postmessage"
    selection = body.get("scopes") or []
    scopes = google_credentials.resolve_scopes(selection)

    try:
        tokens = google_credentials.exchange_authorization_code(str(code), str(redirect_uri))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        raise HTTPException(
            status_code=400,
            detail=(
                "Google did not return a refresh token. Re-run the consent flow with "
                "access_type=offline and prompt=consent, and revoke prior access if needed."
            ),
        )

    granted = tokens.get("scope")
    if isinstance(granted, str) and granted.strip():
        scopes = google_credentials.resolve_scopes(granted.split())

    # SECURITY: persist ONLY the per-user secret material. The app-level OAuth
    # client_id/client_secret/token_uri are backend-owned and process-protected
    # (see tenant_environment._BASE_PROCESS_PROTECTED). They must never be copied
    # into GOOGLE_OAUTH_CREDENTIALS, which is a tenant var the model can reference
    # via ${env:...} and that is injected into tool subprocess environments.
    # use_google re-attaches the app client identity from process env at build time.
    authorized_user = {
        "refresh_token": str(refresh_token),
        "scopes": scopes,
    }
    tenant_environment.tenant_env_set_for_uid(
        uid, "GOOGLE_OAUTH_CREDENTIALS", json.dumps(authorized_user)
    )
    return {"success": True, "connected": True, "scopes": scopes}


@app.delete("/api/google/connect")
async def disconnect_google(request: Request) -> dict[str, Any]:
    """Revoke the user's Google grant and delete the stored credential var."""
    uid = firebase_admin_support.resolve_uid(request)
    raw = tenant_environment.tenant_env_get_for_uid(uid, "GOOGLE_OAUTH_CREDENTIALS")
    if raw:
        try:
            parsed = json.loads(raw)
            refresh_token = parsed.get("refresh_token") if isinstance(parsed, dict) else None
            if refresh_token:
                google_credentials.revoke_token(str(refresh_token))
        except Exception as exc:  # noqa: BLE001 - revocation is best-effort
            logger.warning("Google revoke failed for uid=%s: %s", uid, exc)
    tenant_environment.tenant_env_delete_for_uid(uid, "GOOGLE_OAUTH_CREDENTIALS")
    return {"success": True, "connected": False}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8000))
    uvicorn.run("agent:app", host="127.0.0.1", port=port, reload=True)
