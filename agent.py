import asyncio
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
from strands.models import Model
from strands.session import FileSessionManager
from strands.tools.decorator import DecoratedFunctionTool
from strands.types.agent import AgentInput
from strands_xai import xAIModel

# Baseline tool modules. Every @tool-decorated callable in each of these is
# registered on the agent automatically via `_tools_in(...)`. Adding a new
# @tool to any of these files is picked up on next process start — no
# function-name list to maintain anywhere.
import tools.tool_catalog as _m_tool_catalog
import tools.virtual_desktop.virtual_desktop_tool as _m_virtual_desktop
import strands_tools.devops.shell as _m_shell
import strands_tools.devops.editor as _m_editor
import strands_tools.devops.environment as _m_environment
import strands_tools.agent_orchestration.mem0_memory as _m_mem0
import strands_tools.agent_orchestration.graph as _m_graph
import strands_tools.agent_orchestration.use_agent as _m_use_agent
import strands_tools.research.perplexity_search_api as _m_perplexity_search
import strands_tools.research.perplexity_deep_research as _m_perplexity_deep
from strands_tools.browser.local_chromium_browser import LocalChromiumBrowser

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
SESSIONS_DIR = PROJECT_ROOT / ".strands-sessions"

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
)


def _tools_in(module: Any) -> list[Any]:
    """Every @tool-decorated callable defined in `module`, in definition order."""
    return [
        obj
        for name, obj in vars(module).items()
        if isinstance(obj, DecoratedFunctionTool) and not name.startswith("_")
    ]


def build_baseline_tools() -> list[Any]:
    """Collect all @tool callables across BASELINE_TOOL_MODULES and append a
    fresh LocalChromiumBrowser session. A new browser instance is created on
    every call so each session-scoped Agent owns its own Chromium session."""
    tools: list[Any] = []
    for module in BASELINE_TOOL_MODULES:
        tools.extend(_tools_in(module))
    tools.append(LocalChromiumBrowser().browser)
    return tools
DEFAULT_AGENT_ID = "provider-research-agent"
DEFAULT_MODEL_ID = "grok-4.20-0309-reasoning"
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

SYSTEM_PROMPT = """You are a provider research assistant.

Use the user's message as the source of truth. Call tools only when they materially improve the answer.

Available tools:
- npiLookup: query structured NPI provider records.
- perplexity_search_api: gather current public web sources for a provider or organization.
- perplexity_deep_research: start or fetch longer-running research when the user wants a deeper dossier.

Do not invent tool results, simulate workflows, or call tools that are not relevant to the user's request.
If a tool is unavailable or returns no useful data, say that plainly and continue with the evidence you do have.
"""


def build_model() -> xAIModel:
    return xAIModel(
        client_args={"api_key": os.getenv("XAI_API_KEY", "")},
        model_id=os.getenv("STRANDS_MODEL_ID", DEFAULT_MODEL_ID),
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
    session_manager: FileSessionManager | None = None,
) -> Agent:
    validate_agent_configuration(model)
    kwargs: dict[str, Any] = {
        "model": model or build_model(),
        "system_prompt": SYSTEM_PROMPT,
        "tools": build_baseline_tools(),
        "agent_id": os.getenv("STRANDS_AGENT_ID", DEFAULT_AGENT_ID),
    }
    if session_manager is not None:
        kwargs["session_manager"] = session_manager
    return Agent(**kwargs)


_AGENT_CACHE: dict[str, Agent] = {}
_AGENT_CACHE_LOCK = asyncio.Lock()


async def get_or_create_session_agent(session_id: str | None) -> Agent:
    """Return a cached Strands Agent for this session, or build one.

    Empty/None session_id falls back to a transient agent so unrelated callers
    never share state. Existing sessions get the same Agent instance back, which
    preserves Strands conversation memory and avoids re-running tool registration
    on every request. The Agent is wired with FileSessionManager so multi-turn
    history survives server restarts via the .strands-sessions/ directory.
    """
    if not session_id:
        return build_agent()
    async with _AGENT_CACHE_LOCK:
        cached = _AGENT_CACHE.get(session_id)
        if cached is not None:
            return cached
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        session_manager = FileSessionManager(
            session_id=session_id,
            storage_dir=str(SESSIONS_DIR),
        )
        agent = build_agent(session_manager=session_manager)
        _AGENT_CACHE[session_id] = agent
        return agent


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

        if event.get("type") == "tool_result" and isinstance(event.get("tool_result"), dict):
            tool_result = event["tool_result"]
            for payload in _tool_result_payloads(tool_result, active_tools):
                yield f"data: {json.dumps(payload)}\n\n"
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
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type", "authorization", "x-session-id"],
    allow_credentials=False,
    expose_headers=["x-vercel-ai-ui-message-stream"],
    max_age=600,
)


@app.post("/api/chat")
async def chat_endpoint(request: Request) -> StreamingResponse:
    body = await request.json()
    messages = body.get("messages", [])
    prompt = ui_messages_to_agent_input(messages)
    if not prompt:
        raise HTTPException(status_code=400, detail="No chat message content was provided.")
    last_role = None
    if isinstance(messages, list) and messages and isinstance(messages[-1], dict):
        last_role = messages[-1].get("role")
    session_id = body.get("sessionId") or body.get("session_id")
    logger.info(
        "chat_request message_count=%s trigger=%s last_role=%s converted_messages=%s session_id=%s",
        len(messages) if isinstance(messages, list) else 0,
        body.get("trigger"),
        last_role,
        len(prompt),
        session_id,
    )
    session_agent = await get_or_create_session_agent(session_id)
    return StreamingResponse(
        strands_to_aisdk_stream(prompt, session_agent),
        media_type="text/event-stream",
        headers={
            "x-vercel-ai-ui-message-stream": "v1",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8000))
    uvicorn.run("agent:app", host="127.0.0.1", port=port, reload=True)
