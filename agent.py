import asyncio
import os
import re
import sys
from pathlib import Path

# Add local strands_tools to Python path
sys.path.insert(
    0,
    os.path.abspath(
        os.path.join(
            os.path.dirname(__file__), "tools", "ronbrowser_agent_tools", "src"
        )
    ),
)

from strands import Agent, ModelRetryStrategy, tool
from strands.agent.conversation_manager import SummarizingConversationManager
from strands.session import FileSessionManager
from strands.models.litellm import LiteLLMModel
from strands.hooks.events import (
    AfterModelCallEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
    AfterInvocationEvent,
)
from strands.hooks.registry import HookProvider, HookRegistry

# --- OpenTelemetry ---
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor

provider = TracerProvider()
processor = SimpleSpanProcessor(ConsoleSpanExporter())
provider.add_span_processor(processor)
trace.set_tracer_provider(provider)

# --- Strands Tools Imports ---
from strands_tools.agent_orchestration.tool_catalog import tool_catalog
from strands_tools.agent_orchestration.handoff_to_user import handoff_to_user
from strands_tools.devops.editor import editor
from strands_tools.devops.shell import shell
from strands_tools.agent_orchestration.mcp_client import mcp_client
from strands_tools.devops.environment import environment
from strands_tools.devops.dialog import dialog
from strands_tools.multimodal.use_computer import use_computer as desktop
from strands_tools.browser.local_chromium_browser import LocalChromiumBrowser
from strands_tools.devops.python_repl import python_repl as code_interpreter

browser_tool = LocalChromiumBrowser().browser
PROJECT_ROOT = Path(__file__).resolve().parent
ENV_PATH = PROJECT_ROOT / ".env"
DEFAULT_SESSION_ID = "robust-agent-session-002"
DEFAULT_AGENT_ID = "robust-agent"
DEFAULT_MODEL_ID = "openai/qwen/qwen3.5-397b-a17b"
DEFAULT_API_BASE = "https://integrate.api.nvidia.com/v1"
APPROVAL_REQUIRED_TOOLS = {
    "send_email",
    "make_call",
    "delete_integration_secret",
    "create_integration_secret",
    "cloud_storage_delete_object",
    "dialog",
}


def load_env_file(path: Path = ENV_PATH, *, override: bool = False) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if value and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]

        if override or key not in os.environ:
            os.environ[key] = value


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(
            f"Missing required environment variable: {name}. "
            f"Set it in {ENV_PATH.name} or export it before running agent.py."
        )
    return value


def sanitize_session_id(session_id: str) -> str:
    cleaned = session_id.strip() or DEFAULT_SESSION_ID
    if "/" in cleaned or "\\" in cleaned:
        raise ValueError("Session IDs cannot contain path separators.")
    return cleaned


def current_session_id() -> str:
    return sanitize_session_id(os.getenv("STRANDS_SESSION_ID", DEFAULT_SESSION_ID))


load_env_file()


@tool(context=True)
def checkpoint(note: str, tool_context) -> str:
    """Records progress and marks completion or handoff.

    Args:
        note: A concise progress note. Start with 'DONE:' when finished, or 'HANDOFF:' if blocked.
    """
    if "progress_ledger" not in tool_context.agent.state:
        tool_context.agent.state["progress_ledger"] = []

    ledger = tool_context.agent.state["progress_ledger"]
    entry = {"note": note}
    ledger.append(entry)
    tool_context.agent.state["progress_ledger"] = ledger

    if note.startswith("DONE:"):
        tool_context.agent.state["done"] = True
    if note.startswith("HANDOFF:"):
        tool_context.agent.state["handoff_summary"] = note
    return "Checkpoint recorded."


class LongRunningHooks(HookProvider):
    def __init__(
        self,
        *,
        approval_required_tools: set[str] | None = None,
        max_followups: int = 5,
    ) -> None:
        self.approval_required_tools = set(approval_required_tools or set())
        self.max_followups = max_followups

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)
        registry.add_callback(BeforeModelCallEvent, self._on_before_model_call)
        registry.add_callback(AfterModelCallEvent, self._on_after_model_call)
        registry.add_callback(AfterInvocationEvent, self._on_after_invocation)

    async def _on_before_tool_call(self, event: BeforeToolCallEvent) -> None:
        tool_use = event.tool_use or {}
        tool_name = tool_use.get("name")
        tool_input = tool_use.get("input")

        if tool_name == "environment" and isinstance(tool_input, dict):
            action = str(tool_input.get("action", "")).strip().lower()
            if action in {"get", "list"}:
                tool_input["masked"] = True

        if tool_name in self.approval_required_tools:
            event.interrupt(
                f"approval_{tool_name}",
                reason=f"Approve {tool_name} before it executes?",
            )

    async def _on_before_model_call(self, event: BeforeModelCallEvent) -> None:
        messages = getattr(event.agent, "messages", None)
        if not isinstance(messages, list):
            return

        for index, message in enumerate(messages):
            messages[index] = sanitize_message_payload(message)

    async def _on_after_model_call(self, event: AfterModelCallEvent) -> None:
        pass

    async def _on_after_invocation(self, event: AfterInvocationEvent) -> None:
        state = event.agent.state
        result = event.result
        invocation_state = (
            event.invocation_state if isinstance(event.invocation_state, dict) else {}
        )
        request_state = invocation_state.get("request_state", invocation_state)
        stop_reason = getattr(result, "stop_reason", None)

        if result is None or stop_reason == "interrupt":
            return
        if isinstance(request_state, dict) and request_state.get("stop_event_loop"):
            return
        if state.get("done") or state.get("handoff_summary"):
            return

        followup_count = int(state.get("followup_count", 0))
        if followup_count >= self.max_followups:
            state["handoff_summary"] = "HANDOFF: follow-up cap reached."
            return

        state["followup_count"] = followup_count + 1
        event.resume = "Continue from the latest checkpoint."


from strands.vended_plugins.steering.core.handler import SteeringHandler
from strands.vended_plugins.steering.core.action import (
    Guide,
    ModelSteeringAction,
    Proceed,
)


SENSITIVE_PATTERNS = [
    (re.compile(r"(?i)(password|passwd|pwd)\s*[:=]\s*\S+", re.IGNORECASE), "password"),
    (re.compile(r"(?i)(api[_-]?key|apikey)\s*[:=]\s*\S+", re.IGNORECASE), "API key"),
    (re.compile(r"(?i)(secret|secret[_-]?key)\s*[:=]\s*\S+", re.IGNORECASE), "secret"),
    (
        re.compile(
            r"(?i)(token|auth[_-]?token|access[_-]?token)\s*[:=]\s*\S+", re.IGNORECASE
        ),
        "token",
    ),
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"), "email"),
    (re.compile(r"\b\d{3}[-.]?\d{2}[-.]?\d{4}\b"), "SSN"),
    (
        re.compile(r"\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b"),
        "credit card",
    ),
]


def redact_sensitive_text(text: str) -> str:
    redacted = text
    for pattern, sensitive_type in SENSITIVE_PATTERNS:
        replacement = f"[REDACTED {sensitive_type.upper()}]"
        redacted = pattern.sub(replacement, redacted)
    return redacted


def sanitize_message_payload(value):
    if isinstance(value, str):
        return redact_sensitive_text(value)
    if isinstance(value, list):
        return [sanitize_message_payload(item) for item in value]
    if isinstance(value, dict):
        return {key: sanitize_message_payload(item) for key, item in value.items()}
    return value


class RobustSteeringHandler(SteeringHandler):
    async def steer_after_model(
        self, *, agent, message, stop_reason, **kwargs
    ) -> ModelSteeringAction:
        content = ""
        if hasattr(message, "content") and message.content:
            if isinstance(message.content, str):
                content = message.content
            elif isinstance(message.content, list):
                for block in message.content:
                    if isinstance(block, dict) and block.get("text"):
                        content += block["text"]
                    elif hasattr(block, "text"):
                        content += block.text

        for pattern, sensitive_type in SENSITIVE_PATTERNS:
            match = pattern.search(content)
            if match:
                return Guide(
                    reason=(
                        f"SENSITIVE DATA DETECTED: The response contains what appears to be "
                        f"a {sensitive_type} ('{match.group()[:30]}...'). Redact or remove "
                        f"sensitive information before proceeding. Do not include credentials, "
                        f"PII, or secrets in your response."
                    )
                )

        return Proceed(reason="Model response passes all compliance checks.")


from strands.types.content import SystemContentBlock

TOOL_BUILDER_SYSTEM_PROMPT = """You are an advanced agent that creates and uses custom Strands Agents tools.

Use all available tools implicitly as needed without being explicitly told. Always use tools instead of suggesting code 
that would perform the same operations. Proactively identify when tasks can be completed using available tools.

## TOOL NAMING CONVENTION:
   - The tool name (function name) MUST match the file name without the extension
   - Example: For file "tool_name.py", use tool name "tool_name"

## TOOL CREATION vs. TOOL USAGE:
   - CAREFULLY distinguish between requests to CREATE a new tool versus USE an existing tool
   - When a user asks a question like "reverse hello world" or "count abc", first check if an appropriate tool already exists before creating a new one
   - If an appropriate tool already exists, use it directly instead of creating a redundant tool
   - Only create a new tool when the user explicitly requests one with phrases like "create", "make a tool", etc.

## TOOL CREATION PROCESS:
   - Name the file "tool_name.py" where "tool_name is a human readable name
   - Name the function in the file the SAME as the file name (without extension)
   - The "name" parameter in the TOOL_SPEC MUST match the name of the file (without extension)
   - Include detailed docstrings explaining the tool's purpose and parameters
   - After creating a tool, announce "TOOL_CREATED: <filename>" to track successful creation

## TOOL USAGE:
   - Use existing tools with appropriate parameters
   - Provide a clear explanation of the result

## TOOL STRUCTURE
When creating a tool, follow this exact structure:

```python
from typing import Any
from strands.types.tools import ToolUse, ToolResult

TOOL_SPEC = {
    "name": "tool_name",  # Must match function name
    "description": "What the tool does",
    "inputSchema": {  # Exact capitalization required
        "json": {
            "type": "object",
            "properties": {
                "param_name": {
                    "type": "string",
                    "description": "Parameter description"
                }
            },
            "required": ["param_name"]
        }
    }
}

def tool_name(tool_use: ToolUse, **kwargs: Any) -> ToolResult:
    # Tool function docstring
    tool_use_id = tool_use["toolUseId"]
    param_value = tool_use["input"]["param_name"]
    
    # Process inputs
    result = param_value  # Replace with actual processing
    
    return {
        "toolUseId": tool_use_id,
        "status": "success",
        "content": [{"text": f"Result: {result}"}]
    }
```

Critical requirements:
1. Use "inputSchema" (not input_schema) with "json" wrapper
2. Function must access parameters via tool_use["input"]["param_name"]
3. Return dict must use "toolUseId" (not tool_use_id)
4. Content must be a list of objects: [{"text": "message"}]

## AUTONOMOUS TOOL CREATION WORKFLOW

When asked to create a tool:
1. Generate the complete Python code for the tool following the structure above
2. Use the editor tool to write the code directly to a file named "tool_name.py" where "tool_name" is a human readable name. 
3. Use the tool_catalog tool to dynamically load the newly created tool
4. After loading, report the exact tool name and path you created
5. Confirm when the tool has been created and loaded

Always extract your own code and write it to files without waiting for further instructions or relying on external extraction functions.

Always use the following tools when appropriate:
- editor: For writing code to files and file editing operations
- tool_catalog: For loading custom tools
- shell: For running shell commands
- mcp_client: For database and external server integrations
- environment: For environment variables manipulation
- code_interpreter: For sandboxed python execution
- desktop: For local desktop and UI control
- browser: For web navigation

You should detect user intents to create tools from natural language (like "create a tool that...", "build a tool for...", etc.) and handle the creation process automatically.
"""

SYSTEM_PROMPT = [
    SystemContentBlock(text=TOOL_BUILDER_SYSTEM_PROMPT),
    SystemContentBlock(cachePoint={"type": "default"}),
]


def build_model():
    load_env_file()

    return LiteLLMModel(
        client_args={
            "api_key": require_env("NVIDIA_API_KEY"),
            "api_base": os.getenv("NVIDIA_API_BASE", DEFAULT_API_BASE),
        },
        model_id=os.getenv("STRANDS_MODEL_ID", DEFAULT_MODEL_ID),
        params={
            "max_tokens": 16384,
            "temperature": 0.60,
            "top_p": 0.95,
            "chat_template_kwargs": {"enable_thinking": True},
        },
    )


def build_agent(session_id: str | None = None) -> Agent:
    active_session_id = sanitize_session_id(session_id or current_session_id())
    agent_id = os.getenv("STRANDS_AGENT_ID", DEFAULT_AGENT_ID)

    agent = Agent(
        model=build_model(),
        system_prompt=SYSTEM_PROMPT,
        tools=[
            checkpoint,
            handoff_to_user,
            mcp_client,
            tool_catalog,
            editor,
            shell,
            environment,
            dialog,
            desktop,
            browser_tool,
            code_interpreter,
        ],
        conversation_manager=SummarizingConversationManager(
            summary_ratio=0.5,
            preserve_recent_messages=20,
        ),
        session_manager=FileSessionManager(
            session_id=active_session_id,
            storage_dir="./.strands-sessions",
        ),
        retry_strategy=ModelRetryStrategy(
            max_attempts=10,
            initial_delay=10,
            max_delay=600,
        ),
        hooks=[
            LongRunningHooks(
                approval_required_tools=APPROVAL_REQUIRED_TOOLS,
                max_followups=int(os.getenv("STRANDS_MAX_FOLLOWUPS", "5")),
            )
        ],
        agent_id=agent_id,
        state={
            "progress_ledger": [],
            "followup_count": 0,
            "done": False,
            "handoff_summary": None,
        },
        trace_attributes={
            "session.id": active_session_id,
            "gen_ai.conversation.id": active_session_id,
        },
    )

    RobustSteeringHandler().init_agent(agent)
    return agent


def build_prompt(user_input: str) -> str:
    normalized = user_input.strip().lower()
    if normalized.startswith("create ") or normalized.startswith("make a tool"):
        return (
            f'Create a Python tool based on this description: "{user_input}". '
            "Load the tool after it is created. Handle all steps autonomously including "
            "naming and file creation."
        )
    return user_input


def print_registered_tools(agent: Agent) -> None:
    tool_names = sorted(getattr(agent, "tool_names", []))
    print("\nRegistered tools:")
    for tool_name in tool_names:
        print(f"  • {tool_name}")


agent = build_agent()

# Example usage
if __name__ == "__main__":
    print("\nMeta-Tooling Demonstration (Improved)")
    print("==================================")
    print("Commands:")
    print("  • create <description> - Create a new tool")
    print("  • make a tool that <description>")
    print("  • list tools - Show currently registered tools")
    print("  • show session - Show the active session ID")
    print("  • session <id> - Switch to a different session")
    print("  • reload env - Reload .env and rebuild the agent")
    print("  • exit - Exit the program")

    # Interactive loop
    active_session_id = current_session_id()
    while True:
        try:
            user_input = input("\n> ")
            normalized_input = user_input.strip()
            lower_input = normalized_input.lower()

            # Handle exit command
            if lower_input == "exit":
                print("\nGoodbye!")
                break
            elif lower_input == "list tools":
                print_registered_tools(agent)
                continue
            elif lower_input == "show session":
                print(f"\nActive session: {active_session_id}")
                continue
            elif lower_input.startswith("session "):
                requested_session_id = normalized_input.split(" ", 1)[1]
                active_session_id = sanitize_session_id(requested_session_id)
                os.environ["STRANDS_SESSION_ID"] = active_session_id
                agent = build_agent(active_session_id)
                print(f"\nSwitched to session: {active_session_id}")
                continue
            elif lower_input == "reload env":
                load_env_file(override=True)
                active_session_id = current_session_id()
                agent = build_agent(active_session_id)
                print(
                    f"\nReloaded {ENV_PATH.name} and rebuilt agent for session: "
                    f"{active_session_id}"
                )
                continue

            # Regular interaction - let the agent's system prompt handle tool creation detection
            else:
                prompt_text = build_prompt(normalized_input)
                print("Starting agent stream_async...")

                async def run_agent():
                    async for event in agent.stream_async(prompt_text):
                        if event.get("reasoning"):
                            reasoning_text = event["reasoning"].get("reasoningText", "")
                            if reasoning_text:
                                print(
                                    f"[THINKING]: {reasoning_text}", end="", flush=True
                                )
                        elif "data" in event:
                            data = event["data"]
                            if isinstance(data, str):
                                print(data, end="", flush=True)
                        elif "current_tool_use" in event:
                            tool_info = event["current_tool_use"]
                            tool_name = tool_info.get("name", "")
                            if tool_name:
                                print(f"\n[TOOL]: {tool_name}", flush=True)
                        elif event.get("init_event_loop"):
                            print("[STATUS]: Event loop initialized", flush=True)
                        elif event.get("start_event_loop"):
                            print("[STATUS]: Event loop cycle starting", flush=True)
                        elif "result" in event:
                            print("\n[STATUS]: Agent completed with result", flush=True)
                        elif event.get("force_stop"):
                            reason = event.get("force_stop_reason", "unknown")
                            print(f"\n[STATUS]: Force-stopped: {reason}", flush=True)
                    print("\n\nAgent loop completed.")

                asyncio.run(run_agent())

        except KeyboardInterrupt:
            print("\n\nExecution interrupted. Exiting...")
            break
        except Exception as e:
            print(f"\nAn error occurred: {str(e)}")
            print("Please try a different request.")
