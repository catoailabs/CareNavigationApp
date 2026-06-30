# Agent Environment, Settings, and Context Mentions

## Goal

Add a persistent environment-variable store, a settings modal, and an `@` mention picker in the prompt input so users can manage and reference environment variables, tools, connectors (MCP servers), agent skills, OpenAPI specs, and toolsets across sessions. The agent's `environment` tool must remain the runtime source of truth for env vars.

## Core Decisions

1. **Environment variables live in a JSON file on disk** (`data/agent_environment.json`). The `environment` tool reads/writes this file and `os.environ`. On agent startup, persisted vars are loaded into `os.environ`. Values never appear in prompt text or chat history.
2. **Settings is a modal, not a page.** The existing workbench has no routing; keep it that way. Replace the top-right Preview/NPPES/Deep-Research badges with a profile avatar dropdown and a settings-cog button that opens the modal.
3. **`@` mention picker belongs in the prompt textarea** (`ProviderPromptInput`). Typing `@` opens a nested category menu. Selecting an item inserts a token such as `@env:NAME`, `@tool:NAME`, `@connector:NAME`, `@skill:NAME`, `@openapi:NAME`, `@toolset:NAME`.
4. **Tool/connector/skill/spec discovery reuses `server/tool_catalog_support.py`** plus filesystem scans for skills. The frontend calls a single `/api/catalog` endpoint.
5. **Tool loading is explicit, not automatic.** Mentioning a tool in the prompt adds context; the user can register/load tools from the settings modal or from the `@` menu's "Load" action.
6. **Phase 1 implements the full menu surface and Environment Variables persistence.** Other settings sections (Tools & Connectors, Skills, OpenAPI Specs, Models, Preferences, System) are wired into the modal sidebar with their discovery endpoints and CRUD actions where already supported by the backend; any heavy new backend work for those sections is marked.

## Data Model

### `data/agent_environment.json`

```json
{
  "schema_version": 1,
  "variables": [
    {
      "name": "XAI_API_KEY",
      "value": "...",
      "createdAt": "2026-06-29T22:00:00Z",
      "updatedAt": "2026-06-29T22:00:00Z"
    }
  ]
}
```

- Names follow `^[A-Z_][A-Z0-9_]*$` (uppercase + underscore).
- Values are strings.
- Protected system names (`PATH`, `HOME`, `USER`, `SHELL`, `PYTHONPATH`, `STRANDS_HOME`, `BYPASS_TOOL_CONSENT`) cannot be modified or deleted.

### `@` Token Format

| Kind       | Token example         | Meaning in prompt                               |
|------------|-----------------------|-------------------------------------------------|
| env        | `@env:XAI_API_KEY`    | Variable is available in `os.environ`           |
| tool       | `@tool:npiLookup`     | Tool reference / intent to use                  |
| connector  | `@connector:telnyx`   | MCP server reference                            |
| skill      | `@skill:init`         | Agent skill reference                           |
| openapi    | `@openapi:coverageapi`| OpenAPI spec reference                          |
| toolset    | `@toolset:research`   | Named toolset reference                         |

## Backend Changes

### 1. Persistent Environment Store

Create `server/environment_store.py`:

- `load_environment_store() -> dict`
- `save_environment_store(store: dict) -> None`
- `get_environment_variables() -> dict[str, str]`
- `set_environment_variable(name: str, value: str) -> None`
- `delete_environment_variable(name: str) -> None`
- `is_protected_name(name: str) -> bool`

Thread-safe writes using a file lock or simple atomic rename (`.tmp` then replace).

### 2. Update the `environment` Tool

Edit `tools/ronbrowser_agent_tools/src/strands_tools/devops/environment.py`:

- On `set`: write to store and `os.environ[name] = value`.
- On `delete`: remove from store and `os.environ`.
- On `list`/`get`: read from `os.environ` (already persisted).
- Keep masking, protected-var checks, and confirmation behavior unchanged.

### 3. Agent Startup Loading

Edit `agent.py`:

- After `load_dotenv(ENV_PATH)`, call `load_environment_store()` and apply all persisted vars to `os.environ`.
- This makes variables available to the model, tools, and any subprocesses.

### 4. API Endpoints

In `agent.py`:

- `GET /api/settings/environment` — returns all persisted env vars with values masked.
- `POST /api/settings/environment` — body `{ name, value }`; sets var.
- `DELETE /api/settings/environment/{name}` — deletes var.
- `GET /api/catalog` — returns `{ tools, connectors, skills, openapiSpecs, toolsets }` discovered via `server/tool_catalog_support.py` plus skill scans.
- Extend `POST /api/chat` to accept optional `mentions: string[]` (the `@` tokens from the prompt). The backend can use these to inject a short system note listing referenced items; env-var values are never included.

### 5. Skill Discovery Helper

Create `server/skills_support.py`:

- Scan `.agents/skills`, `.kilo/*/SKILL.md`, `tools/**/SKILL.md`, and any configured skill directories.
- Parse `SKILL.md` frontmatter via `strands.vended_plugins.skills.Skill.from_file`.
- Return `{ name, description, path, allowed_tools, compatibility }`.

## Frontend Changes

### 1. Header Replacement

Edit `src/components/build/BuildWorkbenchPage.tsx` `Header`:

- Remove Preview badge, NPPES badge, and Deep Research Ready badge from the right section.
- Add:
  - **Profile avatar** with dropdown: My Account, Support, Log Out (placeholders).
  - **Settings cog** that opens `SettingsModal`.

### 2. Settings Modal

Create `src/components/settings/SettingsModal.tsx`:

- Dialog with left sidebar and right content area.
- Sidebar sections:
  1. Environment Variables
  2. Tools & Connectors
  3. Agent Skills
  4. OpenAPI Specs
  5. Models
  6. Preferences
  7. System

Use existing shadcn/ui `Dialog`, `Tabs` or simple state-driven panels. Match dark glassmorphic aesthetic (surface-900, white/10 borders, indigo accents).

### 3. Environment Variables Section

Create `src/components/settings/EnvironmentVariablesSection.tsx`:

- Table/list of vars with masked values.
- Toggle to reveal a single value.
- Add/edit form with name validation and value input.
- Delete button with confirmation.
- Calls `GET/POST/DELETE /api/settings/environment`.
- Reuse `src/components/ai-elements/environment-variables.tsx` primitives for consistent display.

### 4. `@` Mention Picker

Create `src/components/provider/PromptMentionPicker.tsx` and a hook `usePromptMentions`:

- Attach to `ProviderPromptInput` textarea.
- Detect `@` at word boundary; show floating menu near cursor.
- Nested menu categories:
  - **Environment Variables**
    - Add / Update / Remove / Mention
  - **Tools**
    - Build new tool (agent meta-tooling)
    - Current Loaded Tools
    - Discoverable Tools
    - Load / Unload actions
  - **Connectors (MCP Servers)**
    - Connected
    - Installed
    - New Connection
    - Remove Server
    - Build Server (uses OpenAPI + FastMCP; runtime creation already exists)
    - Explore Marketplace
  - **Agent Skills**
    - Current Skills
    - Find New Skill
    - Create New Skill
    - Update Skill
    - Remove Skill
    - On skill click: choose use as Tool or Agent meta-tool, update, delete, or back
  - **OpenAPI Specs**
    - Current specs
    - Add by upload
    - Add by paste (JSON/YAML)
    - Convert to MCP Server
    - Update Schema
    - Delete
  - **Toolsets**
    - Current toolsets
    - Create toolset
    - Load / Unload / Delete
- Selecting "Mention" or any reference inserts the corresponding `@` token into the textarea at cursor position.
- Fetch catalog data from `GET /api/catalog`.

### 5. Prompt Submission

Update `ProviderComposerSubmitPayload` in `src/components/provider/providerChatTypes.ts`:

```ts
export interface ProviderComposerSubmitPayload {
  displayText: string
  files: ProviderComposerFile[]
  promptText: string
  tabAttachments: ProviderTabAttachment[]
  mentions?: string[]
}
```

Update `CenterPane.tsx` `handleComposerSubmit` to pass `mentions` to `sendMessage` metadata, and include them in the request body via AI SDK transport `body`.

Update `agent.py` `chat_endpoint` to read `mentions` and prepend a short system note such as:

```
Referenced context: XAI_API_KEY (env), npiLookup (tool), telnyx (connector), init (skill).
Use these resources when relevant.
```

## Integration Flow

1. User opens Settings → Environment Variables, adds `XAI_API_KEY`.
2. Frontend POSTs value to backend; backend saves to JSON and applies to `os.environ`.
3. User types in prompt: `Use @env:XAI_API_KEY to call @tool:npiLookup for Dr. Smith`.
4. `@` picker shows persisted env vars and catalog tools.
5. On submit, `mentions: ["@env:XAI_API_KEY", "@tool:npiLookup"]` travel with the chat request.
6. Backend loads persisted vars into `os.environ` for the new agent instance, injects the referenced-context note, and streams the response.
7. The agent can call `environment(action="get", name="XAI_API_KEY")` when it needs the value; the value itself was never in the prompt or history.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Env values leak into logs/history | Never include values in request/response bodies; backend only sends masked values on `GET`. |
| Race conditions writing JSON store | Atomic rename write; lock if concurrent agent/tool access becomes an issue. |
| Protected vars overwritten | Frontend + backend both enforce the protected-name set; backend is source of truth. |
| Large catalog payload | `/api/catalog` returns summaries only; toolset/skill details fetched on demand. |
| `@` picker conflicts with IME composition | Only trigger when `isComposing` is false. |

## Validation

1. Add env var in Settings; refresh page; verify `/api/settings/environment` returns it masked and the agent sees it via `environment(action="list")`.
2. Type `@env:` in prompt; confirm picker lists the var and inserts the token.
3. Submit a prompt with `@env:` mention; inspect network tab — value must not appear.
4. Delete env var; confirm it disappears from `environment(action="list")` and the JSON file.
5. Verify the three removed badges no longer render in the header; settings cog and profile avatar are present.

## Out of Scope / Phase 2

- Marketplace backend for connectors.
- Runtime MCP server builder (use existing tooling; UI exposes it as an action).
- Full account/auth implementation for profile dropdown.
- Encrypted-at-rest env values.
