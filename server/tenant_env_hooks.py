"""Tenant-env execution-boundary hook for the Strands tool-dispatch path (Task 2b).

Two cross-cutting concerns are applied to *every* tool call through one hook:

* ``${env:NAME}`` substitution (the tool-arg interceptor): expand tokens in
  string tool arguments from the current tenant overlay just before the tool
  runs, so the model can reference a secret by name without ever seeing its
  value. Unknown names are left intact (visible failure rather than silent).
* Output redaction (the backstop): replace any known sensitive tenant value
  (and common encoded forms) in the tool result with ``[redacted]`` before it
  returns to the model/user. This is a backstop, not a guarantee — see the
  plan's stated honest limitation.

Both operations are pure overlay reads; when no tenant overlay is bound (e.g.
local/dev without a request scope) they are no-ops.
"""
from __future__ import annotations

from typing import Any, Callable, Sequence

from strands.hooks import (
    AfterToolCallEvent,
    BeforeToolCallEvent,
    HookRegistry,
)

from server import tenant_environment


AfterToolCallback = Callable[[AfterToolCallEvent], None]


def _expand(value: Any) -> Any:
    """Recursively expand ``${env:NAME}`` tokens in string leaves."""
    if isinstance(value, str):
        return tenant_environment.resolve_env_tokens(value)
    if isinstance(value, list):
        return [_expand(item) for item in value]
    if isinstance(value, dict):
        return {key: _expand(item) for key, item in value.items()}
    return value


def _redact(value: Any) -> Any:
    """Recursively redact known secret values in string leaves."""
    if isinstance(value, str):
        return tenant_environment.redact_secrets(value)
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, dict):
        return {key: _redact(item) for key, item in value.items()}
    return value


class TenantEnvHookProvider:
    """Register the ``${env:NAME}`` interceptor and output redaction on an agent.

    ``after_tool_callbacks`` lets callers attach additional
    ``AfterToolCallEvent`` handlers through this same single provider (e.g. the
    screenshot context guard), so the agent keeps one execution-boundary hook
    rather than a growing list of providers.
    """

    def __init__(
        self, after_tool_callbacks: Sequence[AfterToolCallback] | None = None
    ) -> None:
        self._after_tool_callbacks: tuple[AfterToolCallback, ...] = tuple(
            after_tool_callbacks or ()
        )

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self._before_tool_call)
        registry.add_callback(AfterToolCallEvent, self._after_tool_call)
        for callback in self._after_tool_callbacks:
            registry.add_callback(AfterToolCallEvent, callback)

    def _before_tool_call(self, event: BeforeToolCallEvent) -> None:
        """Expand ``${env:NAME}`` tokens in the tool's input arguments in place."""
        tool_use = event.tool_use
        tool_input = tool_use.get("input")
        if isinstance(tool_input, (str, list, dict)):
            tool_use["input"] = _expand(tool_input)

    def _after_tool_call(self, event: AfterToolCallEvent) -> None:
        """Redact known secret values from the tool result before it is returned."""
        result = event.result
        if not isinstance(result, dict):
            return
        content = result.get("content")
        if not isinstance(content, list):
            return
        for item in content:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("text"), str):
                item["text"] = tenant_environment.redact_secrets(item["text"])
            if "json" in item:
                item["json"] = _redact(item["json"])
