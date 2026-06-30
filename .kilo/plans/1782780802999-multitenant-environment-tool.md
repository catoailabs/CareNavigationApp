# Plan: Multi-Tenant Environment Tool (unified credential store)

Supersedes the runtime-injection portion of
`.kilo/plans/1782772717634-google-credential-provisioning.md`. Firebase identity auth,
the GIS authorization-code flow, Fernet encryption, the scope catalog, and the
`/api/google/*` endpoints from that plan are KEPT. What changes: instead of a bespoke
`google_integrations` Firestore collection + a `current_google_credentials` contextvar,
Google credentials are stored IN the agent's environment tool, and the environment tool
itself becomes multi-tenant and DB-backed.

## Goal
Make the agent's `environment` tool multi-tenant: effective (the agent can read/use a
tenant's vars, including Google credentials, for easy reuse) and safe (no cross-tenant
leakage). After a user completes Google OAuth, the resulting credentials are written into
that user's environment (`GOOGLE_OAUTH_CREDENTIALS`, encrypted) — one unified, per-tenant
store, not a separate database.

## Resolved Decisions
- **Storage model:** UNIFY. Google credentials are stored as a (sensitive) entry in the
  per-tenant environment doc. Retire the standalone `google_integrations` token doc and the
  `current_google_credentials` contextvar.
- **Tenant isolation mechanism:** a request-scoped overlay in a `contextvars.ContextVar`,
  set at `/api/chat` entry from the verified Firebase uid. Tenant data NEVER touches global
  `os.environ`.
- **Backing DB:** Firestore, ONE doc per variable in a subcollection
  `tenant_environments/{uid}/vars/{NAME}` (NOT a single map doc — avoids the 1 MiB per-doc
  cap so a tenant can store effectively unlimited variables).
- **Encryption at rest:** Fernet, static key from env (simple v1; reuse the existing key
  helper in `server/google_credentials.py`). Sensitive names (TOKEN/SECRET/KEY/AUTH/
  PASSWORD/CREDENTIAL/PRIVATE) encrypted; non-sensitive stored as plaintext. (Upgrade path:
  Cloud KMS envelope encryption — deferred.)
- **Secret usage model:** CONFIRMED arbitrary use. The agent references variables BY NAME
  across many tools and during vibe coding. The agent never receives plaintext values; only
  names. Values are resolved to plaintext only at execution boundaries (see below).
- **Local dev:** when `FIREBASE_AUTH_DISABLED=true`, the tenant store falls back to the
  existing JSON file (`data/agent_environment.json`) keyed by `dev-user`, so the single-dev
  flow keeps working.

## External validation (primary sources — why this is the scalable/elegant/easy path)
Every core decision was checked against authoritative sources, not first principles:

- **Storage = Firestore + app-level Fernet, NOT Google Secret Manager.** Secret Manager
  bills **$0.06 / active secret version / month** and is rate-limited to **600 writes/min and
  600 reads/min per project** (access is higher at 90k/min). At tenant cardinality (users ×
  vars) that is both expensive (1k users × 10 vars ≈ $600/mo just to store) and a hard write
  ceiling. Secret Manager is designed for *app-level* secrets (dozens–hundreds); Firestore is
  the correct store for *tenant-cardinality* secrets (effectively free, no write ceiling, the
  per-var subcollection already removes the 1 MiB doc cap). Sources:
  cloud.google.com/secret-manager/pricing, /secret-manager/quotas.
- **OAuth via `google-auth-oauthlib` `Flow.fetch_token` (already chosen).** Google's official
  web-server OAuth guide explicitly says to use the OAuth libraries ("use well-debugged code
  provided by others") and stores `client_id/client_secret/token_uri` server-side only —
  exactly the refresh-token-on-backend model here. Source:
  developers.google.com/identity/protocols/oauth2/web-server.
- **Request isolation = `Depends`/`request.state` primary + module-level `ContextVar` only
  for the deep tool layer.** Python docs confirm `ContextVar` is THE primitive for
  request-scoped ambient state and that asyncio copies context per task (concurrency-safe).
  But DI (`Depends` + `request.state`) is the simpler/more testable primary mechanism; the
  `ContextVar` exists only because the hot-loaded tool layer can't take params. Footguns to
  honor (see Tasks): set the overlay in a **dependency or pure ASGI middleware, NOT
  `BaseHTTPMiddleware`** (historic context-propagation bug); always `reset(token)` at request
  end; `loop.run_in_executor` does **not** propagate context (wrap with
  `copy_context().run`); **child processes never inherit `ContextVar`** — values must be
  passed explicitly (this is exactly why child-process secret use is done by **env merge**,
  not ambient context). Sources: docs.python.org contextvars, PEP 567, starlette.io,
  fastapi.tiangolo.com, encode/starlette#1011.
- **"Use-without-divulging" (reference-by-name + env injection + output masking) IS the
  canonical industry pattern**, independently reconverged from GitHub Actions
  (`${{ secrets.NAME }}` → env → auto-redacted logs), GitLab CI masked/`File` variables, and
  the **Model Context Protocol**, whose spec says STDIO tool servers **"retrieve credentials
  from the environment"** rather than from the model — i.e. the runtime holds creds, the
  model only references them (LangChain's `InjectedToolArg`/`RunnableConfig` is the same
  idea). This is the strongest possible signal the design is standard, not bespoke. Sourced
  refinements folded into the plan below:
  1. **File-handle injection mode** (GitLab `File` vars): where a tool accepts a path, write
     the secret to a short-lived file and pass the PATH, not the value in env — `printenv`
     can't then dump it. Add as an option alongside env merge.
  2. **Mask transformed forms** (base64/hex/url-encoded), and avoid structured-data secret
     values, because value-matching redaction misses substrings/encodings.
  3. **Prefer short-lived/scoped tokens** (OAuth refresh → minted short access tokens) so any
     leak is time-boxed — already the `use_google` model.
  4. **The real boundary is isolation + least privilege + revocability; redaction is the
     safety net.** Both GitHub and GitLab state plainly that masking is "not a guarantee"
     against adversarial extraction — which is exactly the honest limitation recorded below.
  Sources: docs.github.com/.../using-secrets-in-github-actions and /secrets-reference,
  docs.gitlab.com/ci/variables (mask + File + "not guaranteed"),
  modelcontextprotocol.io/specification/2025-06-18/basic/authorization,
  python.langchain.com/docs/how_to/tool_runtime.

## The core safety problem (why this refactor exists)
`os.environ` is one process-global namespace shared by every concurrently-served tenant.
Today, tenant data is written straight into it:
- `server/environment_store.py:145` `set_environment_variable` → `os.environ[name] = value`
- `server/environment_store.py:163-170` `apply_persisted_environment` loads the JSON store
  into `os.environ` at startup
- the agent tool `environment.py` `set`/`delete` mutate `os.environ` directly
So any tenant secret in `os.environ` (e.g. `GOOGLE_OAUTH_CREDENTIALS`) is visible to every
other in-flight request. A safe multi-tenant environment tool must never use `os.environ`
as the source of truth for tenant data.

## Architecture: three scopes + request overlay
| Scope | Holds | Tenant-writable | Backing |
| --- | --- | --- | --- |
| Process env (`os.environ`) | deploy config: model keys, PATH, Fernet/OAuth-app/Firebase secrets, `BYPASS_TOOL_CONSENT` | No (read-only) | process |
| Tenant env | per-uid vars incl. Google creds | Yes | Firestore `tenant_environments/{uid}`, secrets Fernet-encrypted |
| Request overlay | the active tenant's env for this request | — | `ContextVar[dict]`, task-local |

- **Lookup order:** request overlay (tenant) -> `os.environ` (read-only) -> not found.
- **Why concurrency-safe:** overlay is bound to the request's async task; `stream_async`
  runs tool calls in that same task, so the `environment` tool and `use_google` resolve the
  correct tenant. No `os.environ` writes for tenant data. Secrets decrypted only into the
  task-local overlay.
- **Process-protected names** (PATH/HOME/PYTHONPATH/BYPASS_TOOL_CONSENT/model keys/Firebase/
  Fernet/OAuth-app secrets) cannot be shadowed or written by a tenant.

## Secret usage & the non-divulgence boundary
The agent operates on variable NAMES; the system resolves NAME -> VALUE only at execution
boundaries, so plaintext never enters the model context or source files. Two boundaries:

1. **Child-process env injection (primary; covers vibe coding + most tool calls).** When the
   agent spawns a process (shell, `background_process`, dev server, tests), materialize the
   tenant's vars into THAT child process's environment dict. The agent writes code that reads
   `process.env.NAME` / `os.environ["NAME"]`; the running process gets the value; the parent
   `os.environ` is never mutated, so isolation holds. The agent literally cannot hardcode a
   value because `get` is masked (see below) — this enforces correct, value-free source code.
2. **Tool-arg substitution (secondary; covers in-process structured tools).** A SINGLE
   interceptor in the tool-dispatch path expands `${env:NAME}` tokens in string arguments
   server-side, just before the tool runs (implemented once, not per tool). Resolution is
   allowlisted to outbound fields and never to fields echoed back to the model.

Model-facing rules:
- `environment get`/`list` return NAMES + masked sensitive values (`"[set · hidden]"`) +
  metadata (sensitive flag, updated_at) — NEVER plaintext for sensitive vars.
- **Output redaction backstop:** before any child-process stdout or tool result returns to
  the model/user, replace occurrences of known secret values with `[redacted]`.

### Honest limitation (must be stated, not hidden)
"100% never divulged" is NOT absolutely achievable under arbitrary code execution. If the
agent can run code that reads the env AND return its output, a prompt-injection attack can
exfiltrate a value (`print(os.environ["SECRET"])`). The guarantees we DO provide:
- value never enters the model context BY DEFAULT (masked get/list, server-side resolution);
- value never written into source files (agent doesn't possess it);
- redaction strips known values from outputs as a strong backstop.
Adversarial exfiltration via deliberately crafted code is mitigated, not eliminated. Closing
it further requires an egress proxy / sandbox without raw env read-back — deferred.

## SDK & tooling boundaries (explicit)
- **Runtime identity + data layer: `firebase-admin` (official Python Admin SDK) ONLY.**
  Token verification and ALL Firestore reads/writes go through `firebase-admin`. No
  hand-rolled Firestore REST, no third-party Firestore client.
- **Google API access is a SEPARATE concern and CANNOT use the Firebase SDK.** `use_google`
  / `gmail_*` use Google's own client libraries (`google-api-python-client`, `google-auth`).
  Firebase = identity + tenant store; Google libs = Gmail/Calendar/Drive calls.
- **OAuth code exchange:** use `google-auth-oauthlib` `Flow.fetch_token` (official SDK)
  instead of the current hand-rolled `requests.post` in `google_credentials.py`.
- **Firebase MCP server is DEV/AGENT-TIME ONLY, never a runtime path.** It runs via the
  Firebase CLI with the developer's credentials; the FastAPI app cannot call MCP tools. Use
  the MCP server for: `firebase_init` (Firestore), writing/validating security rules,
  inspecting written docs during validation, and managing auth users/claims while testing.

## Prerequisites (NOT yet provisioned — grounded via Firebase MCP)
As of planning, the workspace has `firebase-admin` in `requirements.txt` but NO
`firebase.json`, NO `.firebaserc`, NO `firestore.rules`, NO active project, and NO
authenticated account. Before this plan can run end-to-end:
- `firebase login` + select/create a project (interactive — cannot be done unattended here).
- `firebase_init` Firestore; commit `firebase.json` + `firestore.rules` + indexes.
- Provide the Admin SDK credential (service account JSON / ADC) + the Fernet key + Google
  OAuth client id/secret as backend env/secrets.
- **Security rules:** deny ALL client access to `tenant_environments/**` (Admin SDK bypasses
  rules; this prevents any future client SDK from reading tenant secrets). Validate via
  `firebase_firestore_validate_rules`.

## Critical Code Facts (grounded)
- `server/environment_store.py` — global JSON store + `os.environ` writes (the unsafe path).
  `PROTECTED_VARS` at `:17-25`; `apply_persisted_environment` at `:163`.
- `tools/ronbrowser_agent_tools/src/strands_tools/devops/environment.py` — the agent tool;
  `set`/`delete` mutate `os.environ` AND persist via `server.environment_store` (~:649-651,
  ~:771). `BYPASS_TOOL_CONSENT` in its protected set.
- `tools/.../devops/use_google.py` — `_injected_credentials()` (:68, reads contextvar at
  :79) consulted in `get_google_service` (~:155) before env auto-detection. Will be
  re-sourced from the tenant overlay.
- `server/google_credentials.py` — KEEP: `_fernet`/`encrypt_secret`/`decrypt_secret`
  (:154-174), OAuth `exchange_authorization_code` (:259), `revoke_token` (:282),
  `build_credentials` (:297), `SCOPE_CATALOG`/`resolve_scopes` (:54-146). RETIRE: the
  `google_integrations` doc store (`get_connection`/`save_connection`/`delete_connection`/
  `connection_status`/`load_user_credentials`, :201-336) and `current_google_credentials`
  (:36) in favor of the tenant env.
- `server/firebase_admin_support.py` — KEEP: `resolve_uid(request)`,
  `get_firestore_client`, dev bypass.
- `agent.py` — `/api/chat` per-request boundary (currently sets `current_google_credentials`
  via a `stream_with_google_credentials` wrapper); `/api/settings/environment` GET/POST/
  DELETE; `/api/google/scopes|status|connect|connect(DELETE)`.

## Tasks (ordered)

> Status legend: [DONE] complete + validated · [PARTIAL] started, remainder noted · [TODO] not started.
> 1 [DONE] · 2 [DONE] · 2b [DONE] · 3 [DONE] · 4 [PARTIAL] · 5 [TODO].
> Handoff for remaining work: `.kilo/plans/1782780802999-handoff.md`.

### 1. [DONE] New module `server/tenant_environment.py`
- `current_tenant_uid: ContextVar[str | None]` and `current_tenant_env: ContextVar[dict | None]`.
- `SENSITIVE_NAME_RE` (TOKEN|SECRET|KEY|AUTH|PASSWORD|CREDENTIAL|PRIVATE) and a
  `PROCESS_PROTECTED` set (superset of `environment_store.PROTECTED_VARS` + model/Firebase/
  Fernet/OAuth-app secret names) that tenants cannot write.
- `TenantEnvStore` (Firestore-backed, ONE doc per var):
  - `load(uid) -> dict[str, dict]` — read subcollection `tenant_environments/{uid}/vars/*`,
    returns `{ NAME: {value, sensitive, updated_at} }`, decrypting sensitive values into
    memory.
  - `set(uid, name, value)` / `delete(uid, name)` — upsert/remove doc
    `tenant_environments/{uid}/vars/{NAME}`; encrypt when sensitive; reject protected names.
- Overlay accessors used by tools/endpoints:
  - `load_tenant_env(uid)` — fetch from store, set both contextvars; return a reset token.
  - `tenant_env_get(name)`, `tenant_env_set(name, value)`, `tenant_env_delete(name)`,
    `tenant_env_all()` — operate on the overlay; `set`/`delete` also persist via the store
    for the current uid. `get` falls back to `os.environ` (read-only).
- Dev fallback: when `FIREBASE_AUTH_DISABLED`, back the store with `environment_store`'s
  JSON file keyed `dev-user` (no Firestore needed locally).

### 2. [DONE] Rewrite the `environment` agent tool
- `get`/`set`/`delete`/`list`/`validate` call `tenant_env_*` instead of `os.environ` +
  `environment_store`.
- `set`/`delete` persist to the tenant store; refuse `PROCESS_PROTECTED` names with a clear
  message. Remove direct `os.environ` mutation for tenant vars.
- `get`/`list` return NAMES + metadata; sensitive values masked as `"[set · hidden]"` and
  NEVER returned in plaintext to the model. Non-sensitive vars may be read back.
- Keep `BYPASS_TOOL_CONSENT` behavior intact (process-level).

### 2b. [DONE] Execution-boundary resolution (the "use without divulging" layer)
- **Child-process env injection (primary):** at the shell / `background_process` spawn point,
  merge `tenant_env_all()` (decrypted) into the child's `env` dict. Never mutate the parent
  `os.environ`. This is what makes vibe-coded apps and shell tools actually USE the vars. (This
  is also the MCP-standard mode: STDIO tool servers read creds from the environment.)
- **File-handle injection (optional, stronger) — DEFERRED (follow-up):** for tools/SDKs that accept a path (e.g.
  `GOOGLE_APPLICATION_CREDENTIALS`), write the secret to a short-lived, mode-0600 temp file
  and pass the PATH instead of the value, so a child's `printenv`/`env` cannot dump it. Clean
  up after the call. Source precedent: GitLab CI `File`-type variables.
- **Tool-arg substitution interceptor:** one hook in the tool-dispatch path expands
  `${env:NAME}` in string args from the overlay just before execution; allowlisted to
  outbound fields, never to model-echoed fields.
- **Output redaction:** wrap child-process stdout and tool results to replace any known
  secret value with `[redacted]` before returning to the model/user. Redact **transformed
  forms too** (base64/hex/url-encoded), since value-matching alone misses encoded substrings.

### 3. [DONE] Re-source `use_google` credentials from the overlay
- `get_google_service` reads `tenant_env_get("GOOGLE_OAUTH_CREDENTIALS")` (and
  `GOOGLE_APPLICATION_CREDENTIALS`) from the tenant overlay; build
  `google.oauth2.credentials.Credentials` from the stored authorized-user JSON (refresh to
  mint an access token). Falls back to existing env behavior only when the overlay is unset
  (local/dev). Tool signature unchanged.
- Drop the `current_google_credentials` import/use.

### 4. [PARTIAL] Wire `agent.py`
- `/api/chat`: `resolve_uid` -> `load_tenant_env(uid)` to set the overlay for the request;
  reset the contextvars after streaming completes (replace the
  `stream_with_google_credentials` wrapper). Set the overlay from inside the request
  handler / a FastAPI dependency (or pure ASGI middleware), NOT `BaseHTTPMiddleware`, and
  always `reset(token)` in a `finally` so no overlay leaks into the next request on the task.
- `/api/settings/environment` GET/POST/DELETE: `resolve_uid` -> operate on the tenant store
  so the human UI and the agent share one per-tenant env, safely. Reject protected names.
- `/api/google/connect` (POST): after `exchange_authorization_code`, assemble the
  authorized-user JSON `{ client_id, client_secret, refresh_token, scopes, token_uri }` and
  write it via the tenant store as sensitive `GOOGLE_OAUTH_CREDENTIALS` (encrypted at rest).
- `/api/google/status`: derive connected state from the presence/metadata of
  `GOOGLE_OAUTH_CREDENTIALS` in the tenant env.
- `/api/google/connect` (DELETE): `revoke_token` (best-effort) + `tenant_env_delete(
  "GOOGLE_OAUTH_CREDENTIALS")`.
- Stop calling `apply_persisted_environment()` for tenant vars at startup (process config
  only; or gate behind dev mode).

### 5. Retire the standalone Google store
- Remove `google_integrations` doc functions and `current_google_credentials` from
  `server/google_credentials.py` (keep OAuth/encryption/scope helpers). Update imports.

## Failure Modes to Handle
- Firestore unavailable / uid unresolved -> 401/clear error; agent does not crash.
- Sensitive value can't be decrypted (rotated/invalid Fernet key) -> surface "reconnect
  Google" / re-enter secret, don't 500.
- Refresh token revoked at Google -> `use_google` returns an actionable "reconnect" message;
  `/api/google/status` reports disconnected.
- Tenant attempts to set a `PROCESS_PROTECTED` name -> rejected with the protected list.
- No tenant connection -> `use_google` returns "not connected", not a crash.

## Validation
- **Concurrency/isolation:** two uids with overlapping `/api/chat` requests each set/read
  their own var; assert no value bleeds via `os.environ` (grep that the tool/store no longer
  writes `os.environ` for tenant vars).
- Contextvar identity: a hot-loaded `use_google` and the `environment` tool both resolve the
  same `current_tenant_env` set by `/api/chat` (single `server.tenant_environment` import).
- Round-trip: connect writes encrypted `GOOGLE_OAUTH_CREDENTIALS`; `environment list` masks
  it; `use_google` builds working creds from it.
- **Non-divulgence:** `environment get` on a sensitive var returns `[set · hidden]`, never
  plaintext; a spawned child process started by the agent sees the real value in its env; a
  tool result containing a known secret value comes back `[redacted]`.
- **Unbounded vars:** writing many vars creates many docs under
  `tenant_environments/{uid}/vars/*` (no single-doc size cap).
- Settings UI GET/POST/DELETE operate per-uid and persist to Firestore.
- Local dev (`FIREBASE_AUTH_DISABLED`): JSON-file fallback works without Firestore.
- `npx tsc -b` clean; backend imports clean with routes present; TestClient auth gates
  (`/api/chat`, `/api/settings/environment`, `/api/google/status` -> 401 without token).

## Out of Scope (follow-ups)
- Per-uid in-memory overlay cache (invalidate on write) to avoid one Firestore collection
  read per `/api/chat` request — optimization, add only if read volume warrants.
- Cloud KMS envelope encryption (stronger than the static Fernet key v1).
- Egress proxy / sandbox to close adversarial secret exfiltration via arbitrary code.
- Firebase Hosting deploy (needs interactive `firebase login`).
- Per-tenant model API keys (process keys stay global for now).
- Migration of any existing `google_integrations` docs (none in production yet).
