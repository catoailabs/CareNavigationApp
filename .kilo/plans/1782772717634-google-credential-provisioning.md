# Plan: Per-User Google API Credential Provisioning (Firebase + FastAPI)

## Goal
Let non-technical users self-provision Google API access (per-service scopes) so the
agent's existing Google tools (`use_google`, `gmail_*`) act on the signed-in user's
behalf, with credentials stored securely per user. Identity auth via Firebase.

## Resolved Decisions
- **Identity auth:** Firebase Auth (email/password + Google sign-in for identity only).
- **Google data access:** Direct Google Identity Services (GIS) **authorization code flow**,
  NOT Firebase/provider tokens. Per-service scope selection by the user.
- **OAuth code exchange + token store backend:** Extend existing FastAPI (`agent.py`).
  FastAPI stays hosted separately (not Firebase Hosting).
- **Token store:** Firestore via `firebase-admin`, keyed by Firebase UID.
- **Runtime credential injection:** Request-scoped `contextvars.ContextVar` (grounded:
  agent is built per request in `_create_agent_for_request` and streamed via
  `stream_async`, so a contextvar is concurrency-safe). Avoids the global-env race in
  `use_google.get_google_service`.

## Critical Code Facts
- `tools/.../devops/use_google.py:108-199` (`get_google_service`) resolves creds ONLY from
  global env vars/files (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_OAUTH_CREDENTIALS`,
  `GOOGLE_API_KEY`). This is a multi-user concurrency hazard and must be changed.
- The `@tool use_google` signature does NOT expose a `credentials` param to the LLM; keep it
  that way. Inject creds out-of-band via contextvar.
- `agent.py:88` `BASELINE_TOOL_MODULES` does not include Google tools yet.
- `agent.py:199` `_create_agent_for_request` + `agent.py:721 /api/chat` = per-request boundary.
- `src/stores/authStore.ts` is a hardcoded dummy user (`test-user-123`) — must become real
  Firebase Auth.
- `strands_tools/strands_google/__init__.py` imports broken/non-existent paths — fix or bypass.
- No Firebase/Google deps currently in `package.json` or `requirements.txt`.

## Out of Scope (follow-ups)
- Firebase Hosting deploy (blocked: needs interactive `firebase login` + project selection;
  app is a Vite SPA → static hosting, publicDir `dist`).
- Paid membership tiers.

## Tasks (ordered)

### 1. Firebase identity auth (frontend)
- Add `firebase` to `package.json`; add Firebase web config (env-driven, not committed).
- Replace dummy `src/stores/authStore.ts` with real Firebase Auth state (email/password +
  Google identity sign-in); expose current user + ID token getter.
- Gate the app on auth state; send the Firebase ID token as `Authorization: Bearer` on all
  backend calls (including `/api/chat`).

### 2. Backend token verification
- Add `firebase-admin` to `requirements.txt`; init Admin SDK from a service-account
  credential (env/secret).
- Add a dependency/middleware that verifies the Firebase ID token and resolves `uid` for
  `/api/chat` and new Google endpoints. Reject unauthenticated requests.

### 3. Google "Connect" UX (frontend)
- New Settings panel "Connect Google" with per-service scope checkboxes (e.g. Gmail read,
  Gmail send, Calendar, Drive). Map UI selections → Google scope URLs.
- Use GIS authorization **code flow** (`access_type=offline`, `prompt=consent` to ensure a
  refresh token) to obtain an auth code; POST it to `POST /api/google/connect`.

### 4. Code exchange + encrypted Firestore store (backend)
- `POST /api/google/connect`: verify Firebase token → exchange auth code for tokens using the
  Google OAuth client secret (server-side) → encrypt the refresh token (Fernet key from
  env/secret) → upsert Firestore doc keyed by `uid`:
  `{ encrypted_refresh_token, scopes: [...], connected_at, updated_at }`.
- `GET /api/google/status`: report connected state + granted scopes for the user.
- `DELETE /api/google/connect`: revoke the token at Google and delete the Firestore doc.

### 5. Request-scoped credential injection (backend)
- Add a `contextvars.ContextVar` (e.g. `current_google_credentials`).
- At `/api/chat` entry: load the user's Firestore token doc, decrypt refresh token, build a
  fresh `google.oauth2.credentials.Credentials` (mint/refresh access token), set the
  contextvar for the request.
- Modify `use_google.get_google_service` to consult the contextvar FIRST (use the injected
  `Credentials`/scopes), falling back to existing env behavior only when unset. Keep tool
  signatures unchanged.
- Ensure the contextvar is set within the same async task that runs `stream_async` so it
  propagates to tool calls; clear/reset after the request.

### 6. Register Google tools
- Add `use_google` and gmail tools (`gmail_send`, `gmail_reply` from
  `omni_channel_comms/gmail_helpers.py`) to `BASELINE_TOOL_MODULES`.
- Fix the broken `strands_google/__init__.py` namespace (or import tools directly) so
  registration succeeds.
- Confirm `gmail_helpers` calls with `credential_type="oauth"` resolve via the injected
  contextvar credentials rather than `GOOGLE_OAUTH_CREDENTIALS` file.

### 7. Config / secrets
- Backend env/secrets: Google OAuth client ID + secret, token encryption key (Fernet),
  Firebase service-account credentials.
- Frontend env: Firebase web config, Google OAuth client ID, scope catalog.

## Failure Modes to Handle
- Missing/expired refresh token → return a clear "reconnect Google" signal to the tool/agent
  and surface a reconnect prompt in the UI.
- Refresh failure / revoked grant at Google → mark disconnected; delete or flag the doc.
- Requested tool needs a scope the user didn't grant → fail gracefully with which scope is
  missing (leverage existing permission-error handling in `use_google`).
- No Google connection at all → tools return an actionable "not connected" message; agent
  should not crash.

## Validation
- **Concurrency:** two users with different Google accounts issue overlapping `/api/chat`
  requests; verify each tool call uses the correct user's credentials (no env bleed).
- Token refresh path: stored refresh token mints a working access token end-to-end.
- End-to-end `gmail_send` on behalf of the connected user succeeds.
- Disconnect revokes at Google and removes the Firestore doc; subsequent calls report
  "not connected".
- Scope-mismatch returns the missing-scope error, not a generic 500.

## Open Items (decide at implementation time)
- Encryption key mechanism: env Fernet key (simplest) vs Google KMS (stronger, more infra).
- Exact Firestore collection path (e.g. `users/{uid}/integrations/google`).
