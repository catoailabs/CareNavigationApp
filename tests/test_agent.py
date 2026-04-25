from __future__ import annotations

import json
import logging.handlers
import os
import unittest
from unittest.mock import patch

import agent
from fastapi.testclient import TestClient


class BuildAgentTests(unittest.TestCase):
    def test_build_agent_relies_on_sdk_defaults_for_conversation_and_execution(self) -> None:
        with (
            patch.object(agent, "validate_agent_configuration"),
            patch.object(agent, "build_baseline_tools", return_value=[]),
            patch.object(agent, "Agent", side_effect=lambda **kwargs: kwargs),
        ):
            built = agent.build_agent(model=object())

        self.assertEqual(built["system_prompt"], agent.SYSTEM_PROMPT)
        self.assertEqual(built["tools"], [])
        self.assertNotIn("callback_handler", built)
        self.assertNotIn("hooks", built)
        self.assertNotIn("plugins", built)
        self.assertNotIn("retry_strategy", built)
        self.assertNotIn("tool_executor", built)
        self.assertNotIn("conversation_manager", built)
        self.assertNotIn("session_manager", built)


class UIMessageConversionTests(unittest.TestCase):
    def test_parts_are_converted_to_strands_messages(self) -> None:
        converted = agent.ui_messages_to_agent_input(
            [
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "file",
                            "mediaType": "image/png",
                            "filename": "scan.png",
                            "url": "data:image/png;base64,YWJj",
                        },
                        {"type": "text", "text": "Find a dermatologist in Austin."},
                    ],
                },
                {
                    "role": "assistant",
                    "parts": [
                        {"type": "text", "text": "I can help with that."},
                        {
                            "type": "dynamic-tool",
                            "toolName": "npiLookup",
                            "state": "output-available",
                            "output": {"result_count": 2},
                        },
                    ],
                },
            ]
        )

        self.assertEqual(
            converted,
            [
                {
                    "role": "user",
                    "content": [
                        {"image": {"format": "png", "source": {"bytes": b"abc"}}},
                        {"text": "Find a dermatologist in Austin."},
                    ],
                },
                {
                    "role": "assistant",
                    "content": [
                        {"text": "I can help with that."},
                        {"text": '[Tool npiLookup output]\n{"result_count": 2}'},
                    ],
                },
            ],
        )

    def test_legacy_content_fallback_still_works(self) -> None:
        converted = agent.ui_messages_to_agent_input(
            [
                {
                    "role": "user",
                    "content": [{"text": "Legacy content still reaches the agent."}],
                }
            ]
        )

        self.assertEqual(
            converted,
            [
                {
                    "role": "user",
                    "content": [{"text": "Legacy content still reaches the agent."}],
                }
            ],
        )


class ParseToolOutputTests(unittest.TestCase):
    def test_parse_tool_output_preserves_all_normalized_blocks(self) -> None:
        output = agent._parse_tool_output(
            [
                {"text": "plain text"},
                {"json": {"status": "ok"}},
                {
                    "image": {
                        "format": "png",
                        "source": {"mediaType": "image/png", "bytes": b"abc"},
                    }
                },
                {
                    "document": {
                        "format": "pdf",
                        "source": {"mediaType": "application/pdf", "bytes": b"report"},
                    }
                },
                {"cache_path": "/tmp/tool-cache"},
            ]
        )

        self.assertEqual(output[0], {"text": "plain text"})
        self.assertEqual(output[1], {"status": "ok"})
        self.assertEqual(
            output[2],
            {
                "image": {
                    "format": "png",
                    "source": {"mediaType": "image/png", "byteLength": 3},
                }
            },
        )
        self.assertEqual(
            output[3],
            {
                "document": {
                    "format": "pdf",
                    "source": {"mediaType": "application/pdf", "byteLength": 6},
                }
            },
        )
        self.assertEqual(output[4], {"cache_path": "/tmp/tool-cache"})


class _FakeSessionAgent:
    def __init__(self, events: list[dict[str, object]]) -> None:
        self._events = events

    async def stream_async(self, prompt):  # noqa: ANN001
        del prompt
        for event in self._events:
            yield event


class StreamTranslationTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_translates_tool_output_to_block_list(self) -> None:
        session_agent = _FakeSessionAgent(
            [
                {"data": "Hello", "delta": {"text": "Hello"}},
                {"reasoning": True, "reasoningText": "Thinking", "delta": {"text": "Thinking"}},
                {
                    "type": "tool_use_stream",
                    "delta": {"toolUse": {}},
                    "current_tool_use": {
                        "toolUseId": "tool-1",
                        "name": "search",
                        "input": {"query": "test"},
                    },
                },
                {
                    "type": "tool_result",
                    "tool_result": {
                        "toolUseId": "tool-1",
                        "content": [
                            {"text": "done"},
                            {
                                "image": {
                                    "source": {
                                        "mediaType": "image/png",
                                        "bytes": b"img",
                                    }
                                }
                            },
                        ],
                    },
                },
                {"result": {"stop_reason": "end_turn"}},
            ]
        )

        chunks = [
            chunk
            async for chunk in agent.strands_to_aisdk_stream(
                prompt=None,
                session_agent=session_agent,
            )
        ]

        payloads: list[object] = []
        for chunk in chunks:
            if chunk == "data: [DONE]\n\n":
                payloads.append("[DONE]")
                continue
            payloads.append(json.loads(chunk.removeprefix("data: ").strip()))

        tool_output = next(
            payload
            for payload in payloads
            if isinstance(payload, dict) and payload.get("type") == "tool-output-available"
        )
        tool_input_start = next(
            payload
            for payload in payloads
            if isinstance(payload, dict) and payload.get("type") == "tool-input-start"
        )
        tool_input_available = next(
            payload
            for payload in payloads
            if isinstance(payload, dict) and payload.get("type") == "tool-input-available"
        )

        self.assertTrue(tool_input_start["dynamic"])
        self.assertTrue(tool_input_available["dynamic"])
        self.assertEqual(tool_output["toolCallId"], "tool-1")
        self.assertTrue(tool_output["dynamic"])
        self.assertEqual(
            tool_output["output"],
            [
                {"text": "done"},
                {"image": {"source": {"mediaType": "image/png", "byteLength": 3}}},
            ],
        )
        self.assertEqual(payloads[-1], "[DONE]")

    async def test_stream_translates_tool_result_message_events(self) -> None:
        session_agent = _FakeSessionAgent(
            [
                {
                    "type": "tool_use_stream",
                    "delta": {"toolUse": {"input": '{"query":"test"}'}},
                    "current_tool_use": {
                        "toolUseId": "tool-2",
                        "name": "search",
                        "input": '{"query":"test"}',
                    },
                },
                {
                    "message": {
                        "content": [
                            {
                                "toolResult": {
                                    "toolUseId": "tool-2",
                                    "content": [{"json": {"status": "ok"}}],
                                }
                            }
                        ]
                    }
                },
                {"result": {"stop_reason": "end_turn"}},
            ]
        )

        chunks = [
            chunk
            async for chunk in agent.strands_to_aisdk_stream(
                prompt=None,
                session_agent=session_agent,
            )
        ]

        payloads: list[object] = []
        for chunk in chunks:
            if chunk == "data: [DONE]\n\n":
                payloads.append("[DONE]")
                continue
            payloads.append(json.loads(chunk.removeprefix("data: ").strip()))

        tool_input_available = next(
            payload
            for payload in payloads
            if isinstance(payload, dict) and payload.get("type") == "tool-input-available"
        )
        tool_output = next(
            payload
            for payload in payloads
            if isinstance(payload, dict) and payload.get("type") == "tool-output-available"
        )

        self.assertEqual(tool_input_available["input"], {"query": "test"})
        self.assertEqual(tool_output["output"], [{"status": "ok"}])


class ChatEndpointTests(unittest.TestCase):
    def test_chat_endpoint_passes_parts_based_messages_to_strands(self) -> None:
        captured: dict[str, object] = {}

        async def fake_stream(prompt, session_agent):  # noqa: ANN001
            captured["prompt"] = prompt
            captured["session_agent"] = session_agent
            yield "data: [DONE]\n\n"

        with (
            patch.object(agent, "build_agent", return_value=object()) as build_agent,
            patch.object(agent, "strands_to_aisdk_stream", side_effect=fake_stream),
        ):
            client = TestClient(agent.app)
            response = client.post(
                "/api/chat",
                json={
                    "trigger": "submit-message",
                    "messages": [
                        {
                            "id": "user-1",
                            "role": "user",
                            "parts": [{"type": "text", "text": "Find cardiologists in Austin"}],
                        }
                    ],
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, "data: [DONE]\n\n")
        build_agent.assert_called_once_with()
        self.assertEqual(
            captured["prompt"],
            [
                {
                    "role": "user",
                    "content": [{"text": "Find cardiologists in Austin"}],
                }
            ],
        )


def _build_cors_test_app(allow_origins: list[str]):
    """Fresh FastAPI app with the production CORS mount, parameterized.

    Why: `agent.app` freezes its origin allowlist at module-import time, so
    integration tests that assert on preflight behavior would silently
    false-pass or fail when CI sets `CORS_ALLOWED_ORIGINS`. Building a fresh
    app per test breaks the import-time dependency without forking the prod
    middleware configuration.
    """
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["content-type", "authorization", "x-session-id"],
        allow_credentials=False,
        expose_headers=["x-vercel-ai-ui-message-stream"],
        max_age=600,
    )

    @app.post("/api/chat")
    async def _chat() -> dict[str, str]:
        return {"ok": "true"}

    return app


class CorsConfigurationTests(unittest.TestCase):
    """Guarantees the wildcard CORS removal stays removed.

    Why: CAT-6 — wildcard `allow_origins=["*"]` was a billing-DoS vector. The
    middleware must read `CORS_ALLOWED_ORIGINS`, fall back to localhost-only
    in dev, and refuse to boot in prod when unset.
    """

    def test_dev_default_origins_when_env_absent(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            origins = agent._build_cors_origins()
        self.assertEqual(
            origins,
            ["http://127.0.0.1:5173", "http://localhost:5173"],
        )

    def test_explicit_allowlist_overrides_env_default(self) -> None:
        with patch.dict(
            os.environ,
            {"CORS_ALLOWED_ORIGINS": "https://app.example.com, https://staging.example.com"},
            clear=True,
        ):
            origins = agent._build_cors_origins()
        self.assertEqual(
            origins,
            ["https://app.example.com", "https://staging.example.com"],
        )

    def test_production_without_allowlist_raises(self) -> None:
        with patch.dict(os.environ, {"APP_ENV": "production"}, clear=True):
            with self.assertRaises(RuntimeError):
                agent._build_cors_origins()

    def test_production_with_allowlist_succeeds(self) -> None:
        with patch.dict(
            os.environ,
            {
                "APP_ENV": "production",
                "CORS_ALLOWED_ORIGINS": "https://app.example.com",
            },
            clear=True,
        ):
            origins = agent._build_cors_origins()
        self.assertEqual(origins, ["https://app.example.com"])

    def test_allowed_origin_preflight_returns_acao_header(self) -> None:
        app = _build_cors_test_app(["http://localhost:5173"])
        client = TestClient(app)
        response = client.options(
            "/api/chat",
            headers={
                "origin": "http://localhost:5173",
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type",
            },
        )
        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "http://localhost:5173",
        )

    def test_disallowed_origin_preflight_omits_acao_header(self) -> None:
        app = _build_cors_test_app(["http://localhost:5173"])
        client = TestClient(app)
        response = client.options(
            "/api/chat",
            headers={
                "origin": "https://evil.example",
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type",
            },
        )
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_allowed_methods_narrowed_from_wildcard(self) -> None:
        app = _build_cors_test_app(["http://localhost:5173"])
        client = TestClient(app)
        response = client.options(
            "/api/chat",
            headers={
                "origin": "http://localhost:5173",
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type",
            },
        )
        allow_methods = response.headers.get("access-control-allow-methods", "")
        for verb in ("GET", "POST", "OPTIONS"):
            self.assertIn(verb, allow_methods)
        self.assertNotIn("*", allow_methods)


class RotatingFileHandlerTests(unittest.TestCase):
    def test_logger_has_rotating_file_handler(self) -> None:
        handlers = [
            h
            for h in agent.logger.handlers
            if isinstance(h, logging.handlers.RotatingFileHandler)
        ]
        self.assertEqual(len(handlers), 1, "Expected one RotatingFileHandler on agent.logger")
        handler = handlers[0]
        self.assertEqual(handler.maxBytes, 50 * 1024 * 1024)
        self.assertEqual(handler.backupCount, 5)


if __name__ == "__main__":
    unittest.main()
