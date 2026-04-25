# CLAUDE.md

![CI](https://github.com/catoailabs/CareNavigationApp/actions/workflows/ci.yml/badge.svg)

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

A provider-research chat app. The frontend is a Vite + React 19 + Tailwind v4 workbench (`ronAI "Ron"` brand) that talks to a FastAPI backend (`agent.py`) wrapping a Strands `Agent` running xAI Grok. Streaming uses the Vercel AI SDK v6 **UI Message Stream** over SSE; the backend translates Strands `stream_async` events into that protocol verbatim.

## Commands

All commands below are run from the repo root.

```bash
# Full dev (vite + uvicorn + optional Chromium-with-extension), colored per-process logs
npm run dev

# Only the web app (port 5173)
npm run dev:app

# Only the Strands agent server (uvicorn, port 8000, --reload on by default)
npm run dev:agent

# Only the Provider Tab Bridge Chromium helper (skipped unless /Applications/Chromium.app exists
# or a Playwright cache Chromium is present). Set PROVIDER_BROWSER_AUTOSTART=0 to suppress.
npm run dev:browser

# Production build + typecheck (tsc -b across app+node projects, then vite build)
npm run build

# ESLint (TypeScript + React hooks + react-refresh). No Prettier in this repo.
npm run lint

# Python tests — the project uses stdlib unittest, not pytest. Pytest is NOT installed in .venv.
./.venv/bin/python -m unittest discover -s tests -v
# Run a single test case
./.venv/bin/python -m unittest tests.test_agent.BuildAgentTests.test_build_agent_relies_on_sdk_defaults_for_conversation_and_execution
# Typecheck Python (Pyright config in pyrightconfig.json; extraPaths include tools/ronbrowser_agent_tools/src)
./.venv/bin/python -m pyright   # if installed; otherwise pyright is typically run via editor
```

There is no JS/TS test runner configured. Client-side verification is "typecheck + run it in the browser."

### Dev environment prerequisites

- `.venv/` Python venv at project root (currently 3.14) — `scripts/run-provider-agent.sh` hard-codes `.venv/bin/python`.
- `.env` at project root with: `XAI_API_KEY` (required), `PERPLEXITY_API_KEY` (required for the two perplexity tools). Optional: `STRANDS_MODEL_ID`, `STRANDS_AGENT_ID`, `STRANDS_SESSION_ID`, `STRANDS_MAX_FOLLOWUPS`, `PROVIDER_BROWSER_AUTOSTART=0`. Logging: `LOG_FILE` (default `./logs/agent_server.log`), `LOG_MAX_BYTES` (default 50 MB), `LOG_BACKUP_COUNT` (default 5). CORS: `APP_ENV` (`development`|`production`; default `development`), `CORS_ALLOWED_ORIGINS` (comma-separated allowlist, **required when `APP_ENV=production`** — boot fails closed otherwise; defaults to `http://127.0.0.1:5173,http://localhost:5173` in dev).
- Git submodules under `tools/mcp/` (datacommons, healthcare-mcp-public, mcp-playwright, openapi-mcp, pophive-mcp-server, telnyx-mcp-server, unsloth-mcp-server) — run `git submodule update --init --recursive` after clone.

## Architecture

### Three processes, one chat

```
Browser ──/api/chat──► Vite dev server ──proxy──► FastAPI (uvicorn) ──► Strands Agent ──► xAI Grok
 PromptInput           vite.config.ts              agent.py            stream_async
                       proxies:
                         /api/chat       → 127.0.0.1:8000   (chat)
                         /api/chrome-tabs→ localhost:9222   (CDP tab bridge)
                         /api/chrome-ws  → ws://:9222       (CDP ws)
```

`scripts/dev.mjs` fans out three child `npm run` processes with color-prefixed stdout: `[app]`, `[agent]`, and transient `[browser]`. SIGINT propagates to the whole group.

### Message pipeline (prompt → agent → UI)

The wire format is the AI SDK v6 UI Message Stream. **Do not invent a new format.**

1. **Client submit** — `src/components/build/CenterPane.tsx::ActiveChat` uses `@ai-sdk/react` `useChat<ProviderChatMessage>` with `DefaultChatTransport({ api: '/api/chat', body: { sessionId } })`. `sendMessage({ text, files, metadata })` POSTs a `UIMessage[]` array plus the app's `sessionId`.
2. **Server translate-in** — `agent.py::ui_messages_to_agent_input` converts v6 `UIMessage.parts` (`text` / `file` / `dynamic-tool` / `reasoning` / …) into Strands content blocks (`{"role","content":[{"text"|"image"|"document":…}]}`). Image/PDF data-URLs are decoded to raw bytes.
3. **Agent selection** — `agent.py::get_or_create_session_agent(session_id)` returns a cached Strands `Agent` per session. A missing sessionId yields a transient agent (tests rely on this). Session-backed agents are wired with `strands.session.FileSessionManager(storage_dir='.strands-sessions/')` so multi-turn memory persists across server restarts.
4. **Agent loop** — `session_agent.stream_async(prompt)` yields event dicts. `agent.py::strands_to_aisdk_stream` maps each event to an SSE `data:` frame:
   - text deltas → `text-start` / `text-delta` / `text-end`
   - reasoning → `reasoning-start` / `reasoning-delta` / `reasoning-end`
   - tool-use streaming → `tool-input-start` / `tool-input-delta`
   - tool result → `tool-input-available` + `tool-output-available` + **`source-url`** parts extracted from the result's `sources` / `citations` / `results` / `documents` arrays (dict-or-bare-URL-string)
   - envelope: `start` / `start-step` / … / `finish-step` / `finish` / `[DONE]`
   - response header: `x-vercel-ai-ui-message-stream: v1`
5. **Client render** — `ActiveChat` renders via `<Conversation>`/`<Message>` from `src/components/ai-elements/`. Tool + reasoning parts are delegated to `src/components/ai-elements/strands-chain-of-thought.tsx`, which does substring-based dispatch to the right AI Element (`<Terminal>` for shell, `<Sandbox>` + `<CodeBlock>` for code interpreters, `<Artifact>` + `<WebPreview>` for browser automation, `<Agent>` for subagents, `<Confirmation>` for HITL, `<ChainOfThoughtSearchResults>` for `*_search` tools, …). **This substring dispatch is intentional scale** — it catches tools the user later wires in without manual registry updates. Treat it as an asset, not customization.

### Tool registration

Only three tools are wired into the live agent today. See `server/agent_tooling.py::PROVIDER_TOOL_PATHS`:

- `npiLookup` — `tools/ronbrowser_agent_tools/src/strands_tools/healthcare/npiLookup.py`
- `perplexity_search_api` — `tools/ronbrowser_agent_tools/src/strands_tools/research/perplexity_search_api.py`
- `perplexity_deep_research` — `.../research/perplexity_deep_research.py`

`build_baseline_tools()` dynamically imports each by file path and caches them in `_LOADED_PROVIDER_TOOLS`. `validate_baseline_tooling()` is called from `build_agent()` so a missing tool file fails fast at server boot.

`tools/ronbrowser_agent_tools/` ships **~70+ additional Strands `@tool`-decorated functions** (FDA drug sections, PubMed, DICOM, Telnyx voice, FHIR, CMS coverage, Playwright browser, code interpreters, subagent orchestration, …) that are *not* registered — see `unmapped_tools.md` for the catalog. To wire one in, add a `PROVIDER_TOOL_PATHS` entry and Ron's substring dispatch in `strands-chain-of-thought.tsx` will automatically give it a rich UI if its name matches one of the existing patterns.

`tools/mcp/` holds git submodules of external MCP servers (healthcare, telnyx, pophive, datacommons, …). They are *not* auto-connected to the running agent — `tools/mcp/mcp-installer/` has install helpers and `tools/tool_catalog.py` indexes them for a future catalog UI.

### Frontend surfaces

`src/App.tsx` → `src/components/build/BuildWorkbenchPage.tsx` (Three.js ambient scene + header + preview iframe slot) → `CenterPane.tsx` wraps chat in `ProviderThreadStateProvider` (from `src/copilot/provider/ProviderThreadState.tsx`) which **reads the live `UIMessage[]` stream** and re-normalizes it into provider search runs / compare rows / research jobs via `src/copilot/provider/normalizers.ts`. Those derived structures feed four product sheets (`ProviderCompareTray`, `ProviderProfileSheet`, `ProviderCompareSheet`, `ProviderResearchDossierModal`) defined in `src/components/provider/ProviderUi.tsx`. This is how "click a provider card to open a profile" works without a separate data layer — the chat stream *is* the data layer.

`src/components/ai-elements/` holds ~90 files copied via shadcn-style install: canonical AI Elements plus a few project-owned helpers (`strands-chain-of-thought.tsx`, `strands-workflow.tsx`, `CDPBrowserViewer.tsx`, `TabAttachment.tsx`, `jsx-preview.tsx` + `jsxPreviewRegistry.ts` for Gen-UI rendering of model-emitted JSX). Only a handful are currently consumed (`Conversation`, `Message`, `MessageResponse` (Streamdown), `PromptInput`, `Tool`, `Reasoning`, `ChainOfThought`, `Attachments`, `Sources`, `Task`, `Artifact`) — adding a new one costs nothing; they are already typed against `ai`'s `UIMessage` union.

`src/components/provider/ProviderPromptInput.tsx` composes `<PromptInput>` with a product-specific **tab-context multi-select** powered by `src/services/tabService.ts` + `browser-extension/provider-tab-bridge/`. Selected tab text + navigation metadata is concatenated into the prompt before `sendMessage`. Keep this flow intact.

### Styling

- Tailwind v4 via `@tailwindcss/vite`. Single stylesheet at `src/index.css` — `@import "tailwindcss"` + `@import "shadcn/tailwind.css"` + `@fontsource-variable/geist`.
- **Dark-only app.** `src/main.tsx` force-applies `<html class="dark">`. Do not add light-mode support unless you also audit every `bg-surface-950` class in provider UI.
- Two parallel token systems: shadcn tokens (`--background`, `--primary`, `--muted`, `--ring`, …) live under `.dark { … }` and drive AI Elements; project tokens (`--color-surface-{0,50,100,…,950}`, `--color-ink-inverse-*`) live in `@theme` and drive the bespoke provider/build chrome. The `.dark` block is now indigo/violet-branded so AI Elements pick up the brand automatically.
- `.elements-surface` class (in `@layer components`) is a glassmorphic container utility for AI Elements cards that want project-native depth.
- Components library is shadcn "radix-nova" style, neutral baseColor (see `components.json`). Aliases: `@/components`, `@/lib`, `@/components/ui`, `@/hooks`. Icons: **both** `lucide-react` (AI Elements components) and `@heroicons/react/24/outline` (project chrome). Don't replace one with the other — match the neighborhood.

## Non-obvious gotchas

- **Agent is stateful per `sessionId`.** `_AGENT_CACHE` keeps one `Agent` per session in memory; unique sessionIds leak memory on a long-lived server. For production, add an LRU or a `/sessions/{id}` eviction endpoint.
- **`agent.py` test contract**: `tests/test_agent.py::BuildAgentTests` asserts `session_manager` is NOT in the kwargs passed to `Agent(…)` for the default `build_agent(model=…)` path. `build_agent` only adds `session_manager` when explicitly passed — preserve that invariant.
- **Uvicorn `--reload` runs by default** via `run-provider-agent.sh`. Python tracebacks on boot mean a tool file under `PROVIDER_TOOL_PATHS` is missing or raising at import time.
- **Perplexity deep-research citations can be bare URL strings** *or* dicts; `_extract_sources` handles both. Don't tighten that to dict-only.
- **`agent_server.log` rotation** — `agent.py` installs a `RotatingFileHandler` at import time (50 MB max, 5 backups, total ceiling 250 MB). Log path defaults to `./logs/agent_server.log`; override with env vars `LOG_FILE`, `LOG_MAX_BYTES`, `LOG_BACKUP_COUNT`.
- **Dev port choreography**: Vite 5173, FastAPI 8000, Chromium CDP 9222. `/api/chat` is proxied from 5173 → 8000 in `vite.config.ts`. If uvicorn fails to bind, the chat silently 502s from the proxy.
- **Strands sessions directory is gitignored** (`.strands-sessions/`). Conversation memory is local-machine-only; don't rely on it in CI.
- **AI SDK v3 package alongside v6**: `package.json` has `@ai-sdk/react@^3.0.148` (React bindings) *paired with* `ai@^6.0.116`. This is the canonical v6 layout — both are required. Don't "upgrade" `@ai-sdk/react` to v6 expecting parity; the v3 major of the React package is what pairs with `ai@6`.
- **`strands-chain-of-thought.tsx` uses substring matching on tool names** to pick the right AI Element. New tools get rich UI "for free" if their name contains recognizable substrings (`search`, `shell`, `code_interpreter`, `browser`, `subagent`, `test`, `http_request`, `hitl`, …). Adding a new pattern is a copy-paste of an existing branch.
- **`src/lib/tools/registry.tsx`** is a newer tool-renderer dispatcher for three baseline tools. It is *currently unused* — it exists as an opt-in override layer, not a replacement for the substring dispatch above. If you wire it in, consult it first and fall through to the substring chain, do not replace.
- **`@ai-sdk/react` `status` values** are `'submitted' | 'streaming' | 'ready' | 'error'`. `isStreaming` in this codebase means `status === 'streaming' || status === 'submitted'` — preserve that both-phase truthiness in any rewrite.
- **The empty root `GEMINI.md`** is a deliberate placeholder for the Gemini CLI — do not delete it.
