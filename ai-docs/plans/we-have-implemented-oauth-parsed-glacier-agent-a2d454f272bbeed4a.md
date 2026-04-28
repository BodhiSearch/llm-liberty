# OpenAI Codex CLI OAuth Flow — Research Findings

Source: https://github.com/openai/codex (Rust workspace at `codex-rs/`).
Primary files referenced:
- `codex-rs/login/src/server.rs`        — authorize URL builder, token exchange, callback server
- `codex-rs/login/src/pkce.rs`          — PKCE codes
- `codex-rs/login/src/token_data.rs`    — id_token JWT claim parsing
- `codex-rs/login/src/auth/manager.rs`  — `CLIENT_ID`, refresh
- `codex-rs/login/src/auth/storage.rs`  — `auth.json` shape
- `codex-rs/login/src/auth/default_client.rs` — `originator` header default
- `codex-rs/model-provider/src/bearer_auth_provider.rs` — `ChatGPT-Account-ID` / `Authorization` headers
- `codex-rs/model-provider-info/src/lib.rs` — base URL `https://chatgpt.com/backend-api/codex`
- `codex-rs/codex-api/src/requests/headers.rs` — `session_id` header
- `codex-rs/codex-api/src/endpoint/responses.rs` / `models.rs` — endpoints
- `codex-rs/core/src/client.rs` — extra request headers (`OpenAI-Beta`, `x-client-request-id`)

---

## 1. OAuth endpoints

- **issuer**: `https://auth.openai.com`
- **authorize_url**: `https://auth.openai.com/oauth/authorize`
- **token_url**: `https://auth.openai.com/oauth/token` (also used for refresh)
- **redirect_uri** (built dynamically with the bound port): `http://localhost:{port}/auth/callback`
- **default port**: `1455` (constant `DEFAULT_PORT`). On collision, codex sends a `GET /cancel` to the existing instance to force shutdown, then retries.
- **success redirect after callback**: `http://localhost:{port}/success?...` (used to render a success page; not a real OAuth field).

## 2. Client ID

Defined in `codex-rs/login/src/auth/manager.rs`:

```rust
pub const CLIENT_ID: &str = "app_...";
```

(Per project policy, store this base64-encoded inside `src/providers/openai-codex.ts` only — not in any other file.)

## 3. Scopes

Single space-separated string:

```
openid profile email offline_access api.connectors.read api.connectors.invoke
```

## 4. PKCE method

`S256`. Implementation:
- `code_verifier` = `URL-SAFE base64 (no padding)` over **64 random bytes** (yields a ~86-char verifier).
- `code_challenge` = `URL-SAFE base64 (no padding)` of `SHA256(code_verifier)`.
- Sent in authorize URL as `code_challenge=...&code_challenge_method=S256`.

## 5. State / nonce

- `state` = `URL-SAFE base64 (no padding)` over **32 random bytes**. Mandatory; the callback rejects mismatches.
- No explicit `nonce` parameter.
- Additional non-standard query params codex always adds:
  - `id_token_add_organizations=true`
  - `codex_cli_simplified_flow=true`
  - `originator=codex_cli_rs` (default; from `DEFAULT_ORIGINATOR`)
  - Optional `allowed_workspace_id={workspace}` if the user pinned a workspace.

Final authorize URL is:
`https://auth.openai.com/oauth/authorize?response_type=code&client_id=...&redirect_uri=...&scope=...&code_challenge=...&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=...&originator=codex_cli_rs`

## 6. Token exchange request

`POST https://auth.openai.com/oauth/token`
- Header: `Content-Type: application/x-www-form-urlencoded`
- Body (form-encoded, manually built):

```
grant_type=authorization_code
&code={code}
&redirect_uri={redirect_uri}
&client_id={client_id}
&code_verifier={code_verifier}
```

(Refresh uses the same URL but `Content-Type: application/json` with body `{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":"..."}` — note the inconsistency with the initial exchange.)

## 7. Token response

JSON, three fields the codex deserializer expects (other fields ignored):

```json
{ "id_token": "...", "access_token": "...", "refresh_token": "..." }
```

No `expires_in` / `token_type` is read. Expiry is parsed from the JWT `exp` claim (`parse_jwt_expiration` in `token_data.rs`). Both `id_token` and `access_token` are JWTs.

## 8. Persisted `auth.json` shape

File: `$CODEX_HOME/auth.json`. Struct `AuthDotJson`:

```json
{
  "auth_mode": "Chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<raw JWT string>",
    "access_token": "<raw JWT string>",
    "refresh_token": "...",
    "account_id": "<from id_token claims['https://api.openai.com/auth'].chatgpt_account_id>"
  },
  "last_refresh": "2025-...Z"
}
```

Note: at runtime `id_token` is deserialized into a `IdTokenInfo` struct (see `token_data.rs`) but **serialized back as the raw JWT string** via custom serde.

Claims pulled from `id_token` payload (specifically the namespaced `"https://api.openai.com/auth"` object) for use as request metadata:
- `chatgpt_account_id`  — drives the `ChatGPT-Account-ID` header (also stored as `account_id` at top level).
- `chatgpt_user_id` (or fallback `user_id`) — telemetry / display.
- `chatgpt_plan_type` — plan info (free/plus/pro/business/enterprise/edu).
- `chatgpt_account_is_fedramp` — when true, codex adds `X-OpenAI-Fedramp: true`.
- `email` (from top-level `email` or `"https://api.openai.com/profile".email`).

The `access_token` JWT also carries `chatgpt_plan_type` under the same `"https://api.openai.com/auth"` namespace; codex reads it for the success page.

## 9. API request shape (ChatGPT-backed Codex)

When `auth_mode` is `Chatgpt` (or `ChatgptAuthTokens`/`AgentIdentity`), the default base URL becomes:

```
https://chatgpt.com/backend-api/codex
```

(`codex-rs/model-provider-info/src/lib.rs:236`). Endpoints are joined onto this:
- `POST {base}/responses`         — main responses API (SSE)
- `POST {base}/responses/compact` — compaction
- `GET  {base}/models?client_version={ver}` — list models
- `POST {base}/memories/trace_summarize`
- realtime / websocket variants

Headers always set on the HTTP client (from `default_headers()` in `auth/default_client.rs`):
- `originator: codex_cli_rs` (overridable via env `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`)
- `User-Agent: codex_cli_rs/{version} ({os} {ver}; {arch}) {ua-detection}`
- Optional `x-openai-internal-codex-residency: us`

Auth headers added per-request by `BearerAuthProvider::add_auth_headers`:
- `Authorization: Bearer {access_token}`  (the JWT access_token, **not** the id_token)
- `ChatGPT-Account-ID: {chatgpt_account_id}` (from id_token claims)
- `X-OpenAI-Fedramp: true` (only if FedRAMP)

Per-request headers built for the responses endpoint:
- `session_id: {conversation_id}`        — set by `build_conversation_headers`; uses lowercase `session_id` as the header name (a UUID matching the codex conversation/thread id).
- `x-client-request-id: {conversation_id}`
- `OpenAI-Beta: responses_websockets=2026-02-06` (only on the websocket variant, not the SSE POST)
- `version: {CARGO_PKG_VERSION}` (codex CLI version) — set on the OpenAI provider's `http_headers` map, propagated only for non-ChatGPT base URLs by default but practically always sent.
- Several internal codex-only headers: `x-codex-installation-id`, `x-codex-beta-features`, `x-codex-turn-state`, `x-codex-turn-metadata`, `x-codex-parent-thread-id`, `x-codex-window-id`, `x-openai-subagent`, `x-responsesapi-include-timing-metrics`. **Likely not required** for a vanilla POST that simply executes a turn — codex relies on them for routing/telemetry.

Body uses the **OpenAI Responses API** shape (`ResponsesApiRequest`): `model`, `input` (formatted message array), `instructions`, `tools`, `parallel_tool_calls`, `reasoning`, `text`, etc. Identical to the public `/v1/responses` shape, but the host is `chatgpt.com/backend-api/codex` and the auth is the user's ChatGPT bearer instead of an API key.

## 10. Minimal verify endpoint

`GET https://chatgpt.com/backend-api/codex/models?client_version={any-string}`

Source: `codex-rs/codex-api/src/endpoint/models.rs` — the `list_models` method does an HTTP GET on path `models` with a `client_version` query param and decodes a `ModelsResponse { models: Vec<ModelInfo> }`.

Minimum required headers:
- `Authorization: Bearer {access_token}`
- `ChatGPT-Account-ID: {chatgpt_account_id}`  (uncertain whether the backend strictly requires it for `/models`, but codex always sends it; safest to include)
- `originator: codex_cli_rs`
- `User-Agent: codex_cli_rs/<version> (...)` — codex sends this; uncertain whether the backend rejects without a codex-style UA. **Worth testing both with and without a custom UA** before committing to a hard requirement.

No body. Expected JSON response shape: `{ "models": [ { ... } ] }`.

Curl skeleton:

```bash
curl -sS 'https://chatgpt.com/backend-api/codex/models?client_version=0.1.0' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "ChatGPT-Account-ID: $CHATGPT_ACCOUNT_ID" \
  -H 'originator: codex_cli_rs' \
  -H 'User-Agent: codex_cli_rs/0.1.0 (Macintosh; arm64)'
```

---

## Uncertain / worth verifying live

- Whether `originator: codex_cli_rs` is enforced server-side or merely telemetry. Codex hard-codes it.
- Whether `User-Agent` prefix `codex_cli_rs/...` is required (the cloudflare layer in front of `chatgpt.com` historically blocks generic UAs).
- Whether `/models` requires `ChatGPT-Account-ID` for plus/pro accounts (it's always sent by codex).
- Whether the responses POST works without the internal `x-codex-*` headers — codex always sends them but they look like internal bookkeeping. A minimal client probably only needs `session_id` + the auth pair.
- The id_token claim path `"https://api.openai.com/auth".chatgpt_account_id` is the source of truth, but the namespace URL is hard-coded — we should treat it as opaque and copy verbatim.
