from __future__ import annotations

import json
import logging.handlers
import os
import types
import unittest
from unittest.mock import MagicMock, patch

import agent
from fastapi.testclient import TestClient

# Run the suite in the documented local/dev posture: Firebase auth bypassed.
# This mirrors how the agent runs in development (.env.development /
# scripts/run-provider-agent.sh default FIREBASE_AUTH_DISABLED=true), so
# endpoint tests resolve to DEV_FALLBACK_UID without a token and the tenant
# store uses the local JSON fallback instead of reaching for Firestore. Tests
# that exercise production fail-closed behavior set their own env explicitly via
# patch.dict(..., clear=True), so this default never masks them.
os.environ.setdefault("FIREBASE_AUTH_DISABLED", "true")


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
        # Task 2b: the tenant-env execution-boundary hook is intentionally wired
        # (${env:NAME} interception + output redaction). Other execution knobs
        # still rely on SDK defaults.
        self.assertIn("hooks", built)
        self.assertEqual(len(built["hooks"]), 1)
        self.assertIsInstance(
            built["hooks"][0], agent.tenant_env_hooks.TenantEnvHookProvider
        )
        self.assertNotIn("plugins", built)
        self.assertNotIn("tool_executor", built)
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
        self._screenshot_buffer: dict[str, list[dict[str, object]]] = {}

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

    async def test_stream_emits_buffered_screenshot_as_file_part(self) -> None:
        session_agent = _FakeSessionAgent(
            [
                {
                    "type": "tool_result",
                    "tool_result": {"toolUseId": "tool-9", "content": [{"text": "ok"}]},
                },
                {"result": {"stop_reason": "end_turn"}},
            ]
        )
        # Simulate the AfterToolCall hook having lifted a screenshot out of context.
        session_agent._screenshot_buffer = {"tool-9": [{"format": "jpeg", "bytes": b"IMG"}]}

        payloads: list[object] = []
        async for chunk in agent.strands_to_aisdk_stream(prompt=None, session_agent=session_agent):
            if chunk == "data: [DONE]\n\n":
                continue
            payloads.append(json.loads(chunk.removeprefix("data: ").strip()))

        file_parts = [p for p in payloads if isinstance(p, dict) and p.get("type") == "file"]
        self.assertEqual(len(file_parts), 1)
        self.assertEqual(file_parts[0]["mediaType"], "image/jpeg")
        self.assertTrue(file_parts[0]["url"].startswith("data:image/jpeg;base64,"))
        # Drained so a duplicate tool-result event cannot re-emit it.
        self.assertIsNone(session_agent._screenshot_buffer.get("tool-9"))


class ScreenshotContextGuardTests(unittest.TestCase):
    def test_strip_removes_image_from_context_and_buffers_it(self) -> None:
        agent_obj = types.SimpleNamespace()
        event = types.SimpleNamespace(
            result={
                "toolUseId": "call_9",
                "content": [
                    {"text": "navigated"},
                    {"image": {"format": "jpeg", "source": {"bytes": b"PNGDATA"}}},
                ],
            },
            tool_use={"name": "local_chromium_browser", "toolUseId": "call_9"},
            agent=agent_obj,
        )

        agent._strip_screenshots_for_context(event)

        self.assertEqual(
            event.result["content"],
            [{"text": "navigated"}, {"text": agent.SCREENSHOT_CONTEXT_PLACEHOLDER}],
        )
        self.assertEqual(agent_obj._screenshot_buffer["call_9"][0]["bytes"], b"PNGDATA")

    def test_strip_leaves_non_screen_capture_tool_images_intact(self) -> None:
        agent_obj = types.SimpleNamespace()
        event = types.SimpleNamespace(
            result={
                "toolUseId": "c",
                "content": [{"image": {"format": "png", "source": {"bytes": b"x"}}}],
            },
            tool_use={"name": "image_reader", "toolUseId": "c"},
            agent=agent_obj,
        )

        agent._strip_screenshots_for_context(event)

        self.assertIn("image", event.result["content"][0])
        self.assertFalse(hasattr(agent_obj, "_screenshot_buffer"))


class ChatEndpointTests(unittest.TestCase):
    def test_chat_endpoint_passes_parts_based_messages_to_strands(self) -> None:
        captured: dict[str, object] = {}

        async def fake_stream(prompt, session_agent):  # noqa: ANN001
            captured["prompt"] = prompt
            captured["session_agent"] = session_agent
            yield "data: [DONE]\n\n"

        with (
            patch.object(agent, "build_agent", return_value=MagicMock()) as build_agent,
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
        build_agent.assert_called_once()
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


class AuthBypassFailClosedTests(unittest.TestCase):
    """The Firebase auth bypass must never be honored in production."""

    def setUp(self) -> None:
        from server import firebase_admin_support

        self.fas = firebase_admin_support

    def test_bypass_active_in_local_dev(self) -> None:
        with patch.dict(os.environ, {"FIREBASE_AUTH_DISABLED": "true"}, clear=True):
            self.assertTrue(self.fas.auth_disabled())

    def test_bypass_ignored_in_production(self) -> None:
        # Even with the flag set, production enforces real auth (fail-closed).
        with patch.dict(
            os.environ,
            {"FIREBASE_AUTH_DISABLED": "true", "APP_ENV": "production"},
            clear=True,
        ):
            self.assertFalse(self.fas.auth_disabled())

    def test_bypass_ignored_in_prod_alias(self) -> None:
        with patch.dict(
            os.environ,
            {"FIREBASE_AUTH_DISABLED": "true", "APP_ENV": "prod"},
            clear=True,
        ):
            self.assertFalse(self.fas.auth_disabled())

    def test_disabled_by_default(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(self.fas.auth_disabled())

    def test_production_resolve_uid_requires_token(self) -> None:
        from fastapi import HTTPException

        class _Req:
            headers: dict[str, str] = {}

        with patch.dict(
            os.environ,
            {"FIREBASE_AUTH_DISABLED": "true", "APP_ENV": "production"},
            clear=True,
        ):
            with self.assertRaises(HTTPException) as ctx:
                self.fas.resolve_uid(_Req())
        self.assertEqual(ctx.exception.status_code, 401)


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


class GoogleConnectRoundTripTests(unittest.TestCase):
    """Connect/status/use/disconnect round-trip for the tenant-store Google creds.

    Verifies the POST writes ``GOOGLE_OAUTH_CREDENTIALS`` as a sensitive (masked)
    tenant var, status reports connected with granted scopes (never the secret),
    ``use_google`` builds creds from the stored value via the request overlay, and
    DELETE revokes + removes it. The tenant store primitives, ``resolve_uid``, the
    OAuth-app client config, and the network calls are all patched so no Firestore,
    no dev JSON file, and no real network are touched.
    """

    UID = "google-test-uid"

    def setUp(self) -> None:
        from server import google_credentials, tenant_environment

        self.tenant_environment = tenant_environment
        self.google_credentials = google_credentials

        # In-memory tenant store {uid: {name: entry}} mirroring _store_load shape.
        self._store: dict[str, dict[str, dict[str, object]]] = {}

        def fake_load(uid):  # noqa: ANN001
            return {n: dict(e) for n, e in self._store.get(uid, {}).items()}

        def fake_set(uid, name, value, sensitive):  # noqa: ANN001
            self._store.setdefault(uid, {})[name] = {
                "value": value,
                "sensitive": sensitive,
                "updated_at": "2026-01-01T00:00:00Z",
                "decrypt_error": False,
            }

        def fake_delete(uid, name):  # noqa: ANN001
            self._store.get(uid, {}).pop(name, None)

        patches = [
            patch.object(tenant_environment, "_store_load", side_effect=fake_load),
            patch.object(tenant_environment, "_store_set", side_effect=fake_set),
            patch.object(tenant_environment, "_store_delete", side_effect=fake_delete),
            patch.object(agent.firebase_admin_support, "resolve_uid", return_value=self.UID),
            patch.object(google_credentials, "_client_id", return_value="client-id-xyz"),
            patch.object(google_credentials, "_client_secret", return_value="client-secret-abc"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        self.client = TestClient(agent.app)

    def test_connect_status_use_disconnect_round_trip(self) -> None:
        gc = self.google_credentials
        te = self.tenant_environment
        gmail_scope = "https://www.googleapis.com/auth/gmail.readonly"
        identity_scope = "https://www.googleapis.com/auth/userinfo.email"

        # 1. CONNECT — exchange returns a refresh token + the granted scope.
        with patch.object(
            gc,
            "exchange_authorization_code",
            return_value={"refresh_token": "refresh-token-123", "scope": gmail_scope},
        ) as exchange:
            resp = self.client.post(
                "/api/google/connect",
                json={"code": "auth-code", "scopes": ["gmail.readonly"]},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["connected"])
        self.assertIn(gmail_scope, body["scopes"])
        self.assertIn(identity_scope, body["scopes"])
        exchange.assert_called_once()

        # Persisted as the sensitive var (encrypted-at-rest path => masked listing).
        entry = self._store[self.UID]["GOOGLE_OAUTH_CREDENTIALS"]
        self.assertTrue(entry["sensitive"])
        stored = json.loads(str(entry["value"]))
        self.assertEqual(stored["refresh_token"], "refresh-token-123")
        self.assertIn(gmail_scope, stored["scopes"])
        # SECURITY: the app-level OAuth client identity must NEVER be persisted in
        # the model-reachable tenant blob. Only per-user secret material is stored;
        # use_google re-attaches client_id/client_secret/token_uri from process env.
        self.assertNotIn("client_id", stored)
        self.assertNotIn("client_secret", stored)
        self.assertNotIn("token_uri", stored)
        self.assertNotIn("client-secret-abc", json.dumps(stored))

        listing = te.tenant_env_list_for_uid(self.UID)
        cred_row = next(r for r in listing if r["name"] == "GOOGLE_OAUTH_CREDENTIALS")
        self.assertEqual(cred_row["value"], te.MASKED_SENTINEL)
        self.assertTrue(cred_row["sensitive"])
        self.assertNotIn("refresh-token-123", json.dumps(listing))

        # 2. STATUS — connected, exposes granted scopes, never the secret value.
        status = self.client.get("/api/google/status").json()
        self.assertTrue(status["connected"])
        self.assertIn(gmail_scope, status["scopes"])
        self.assertNotIn("refresh-token-123", json.dumps(status))

        # 3. USE — use_google resolves GOOGLE_OAUTH_CREDENTIALS from the bound
        #    overlay and builds creds from that exact stored value.
        from strands_tools.devops import use_google

        sentinel_creds = object()
        sentinel_service = object()
        token = te.load_tenant_env(self.UID)
        try:
            with (
                patch.object(
                    use_google,
                    "_credentials_from_oauth_value",
                    return_value=sentinel_creds,
                ) as from_oauth,
                patch(
                    "googleapiclient.discovery.build",
                    return_value=sentinel_service,
                ) as build_mock,
            ):
                service = use_google.get_google_service("gmail", "v1")
            self.assertIs(service, sentinel_service)
            from_oauth.assert_called_once()
            passed_value = from_oauth.call_args.args[0]
            self.assertIn("refresh-token-123", passed_value)
            build_mock.assert_called_once()
            self.assertIs(build_mock.call_args.kwargs["credentials"], sentinel_creds)
        finally:
            te.reset_tenant_env(token)

        # 4. DISCONNECT — best-effort revoke with the stored refresh token, then
        #    the var is removed and status reports disconnected.
        with patch.object(gc, "revoke_token") as revoke:
            disc = self.client.delete("/api/google/connect")
        self.assertEqual(disc.status_code, 200)
        self.assertFalse(disc.json()["connected"])
        revoke.assert_called_once_with("refresh-token-123")
        self.assertNotIn("GOOGLE_OAUTH_CREDENTIALS", self._store.get(self.UID, {}))

        after = self.client.get("/api/google/status").json()
        self.assertFalse(after["connected"])
        self.assertEqual(after["scopes"], [])


class GoogleCredentialReattachTests(unittest.TestCase):
    """The app OAuth client identity is re-attached from process env at build
    time and is never expected inside the stored (model-reachable) tenant blob.
    """

    def test_client_identity_pulled_from_env_not_blob(self) -> None:
        from strands_tools.devops import use_google

        # Stored blob carries ONLY per-user secret material — no app secret.
        stored_blob = json.dumps(
            {"refresh_token": "rt-abc", "scopes": ["s1"]}
        )

        captured: dict[str, object] = {}

        class _FakeCreds:
            valid = True
            refresh_token = "rt-abc"

        def _from_info(info, scopes=None):  # noqa: ANN001
            captured["info"] = info
            captured["scopes"] = scopes
            return _FakeCreds()

        fake_creds_mod = types.SimpleNamespace(
            Credentials=types.SimpleNamespace(from_authorized_user_info=_from_info)
        )
        fake_req_mod = types.SimpleNamespace(Request=lambda: object())

        env = {
            "GOOGLE_OAUTH_CLIENT_ID": "app-client-id",
            "GOOGLE_OAUTH_CLIENT_SECRET": "app-client-secret",
        }
        with (
            patch.dict(
                "sys.modules",
                {
                    "google.oauth2.credentials": fake_creds_mod,
                    "google.auth.transport.requests": fake_req_mod,
                },
            ),
            patch.dict(os.environ, env, clear=False),
        ):
            creds = use_google._credentials_from_oauth_value(stored_blob, ["s1"])

        self.assertIs(creds.__class__, _FakeCreds)
        info = captured["info"]
        # App identity injected from process env (never from the blob).
        self.assertEqual(info["client_id"], "app-client-id")
        self.assertEqual(info["client_secret"], "app-client-secret")
        self.assertEqual(info["token_uri"], "https://oauth2.googleapis.com/token")
        self.assertEqual(info["refresh_token"], "rt-abc")


class DevStoreIsolationTests(unittest.TestCase):
    """The local dev backend must enforce the SAME per-uid isolation and
    encryption-at-rest as Firestore. One dev user must never read another's
    variables, and sensitive values must not sit on disk in plaintext."""

    def setUp(self) -> None:
        import tempfile

        from server import tenant_environment

        self.te = tenant_environment
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store_path = os.path.join(self._tmp.name, "tenant_environments.dev.json")
        # No encryption key in env -> the dev store must auto-provision one.
        self._saved_key = os.environ.pop("GOOGLE_TOKEN_ENCRYPTION_KEY", None)
        if self._saved_key is not None:
            self.addCleanup(
                lambda: os.environ.__setitem__("GOOGLE_TOKEN_ENCRYPTION_KEY", self._saved_key)
            )
        p = patch.dict(os.environ, {"TENANT_ENV_DEV_FILE": self.store_path}, clear=False)
        p.start()
        self.addCleanup(p.stop)

    def test_each_uid_has_its_own_isolated_namespace(self) -> None:
        te = self.te
        te._dev_set("alice", "MEMBER_ID", "alice-secret", sensitive=True)
        te._dev_set("bob", "MEMBER_ID", "bob-secret", sensitive=True)

        alice = te._dev_load("alice")
        bob = te._dev_load("bob")

        self.assertEqual(alice["MEMBER_ID"]["value"], "alice-secret")
        self.assertEqual(bob["MEMBER_ID"]["value"], "bob-secret")
        # Cross-tenant read must be impossible.
        self.assertNotIn("MEMBER_ID", te._dev_load("carol"))
        # Deleting one uid's var leaves the other intact.
        te._dev_delete("alice", "MEMBER_ID")
        self.assertNotIn("MEMBER_ID", te._dev_load("alice"))
        self.assertEqual(te._dev_load("bob")["MEMBER_ID"]["value"], "bob-secret")

    def test_sensitive_values_are_encrypted_at_rest(self) -> None:
        te = self.te
        te._dev_set("alice", "MEMBER_ID", "plaintext-should-not-appear", sensitive=True)
        with open(self.store_path, encoding="utf-8") as fh:
            on_disk = fh.read()
        self.assertNotIn("plaintext-should-not-appear", on_disk)
        # But it round-trips back to plaintext on read.
        self.assertEqual(
            te._dev_load("alice")["MEMBER_ID"]["value"], "plaintext-should-not-appear"
        )

    def test_load_applies_sensitivity_policy(self) -> None:
        te = self.te
        te._dev_set("alice", "NOTE", "hello", sensitive=True)
        self.assertTrue(te._dev_load("alice")["NOTE"]["sensitive"])

    def test_auto_generated_key_is_not_world_readable(self) -> None:
        import stat

        te = self.te
        te._dev_set("alice", "MEMBER_ID", "x", sensitive=True)
        key_file = self.store_path + ".key"
        self.assertTrue(os.path.exists(key_file))
        mode = stat.S_IMODE(os.stat(key_file).st_mode)
        # No group/other access to the decryption key sitting beside the store.
        self.assertEqual(mode & 0o077, 0, f"key file mode too open: {oct(mode)}")

    def test_created_at_preserved_across_updates(self) -> None:
        te = self.te
        te._dev_set("alice", "MEMBER_ID", "v1", sensitive=True)
        first = te._dev_read_all()["tenants"]["alice"]["MEMBER_ID"]["created_at"]
        te._dev_set("alice", "MEMBER_ID", "v2", sensitive=True)
        rec = te._dev_read_all()["tenants"]["alice"]["MEMBER_ID"]
        self.assertEqual(rec["created_at"], first)
        self.assertEqual(te._dev_load("alice")["MEMBER_ID"]["value"], "v2")


if __name__ == "__main__":
    unittest.main()
