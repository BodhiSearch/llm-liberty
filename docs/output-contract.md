# Output contract

Every successful `login` run prints a JSON object to stdout describing both the credentials and the request shape the provider expects. The shape is **stable across providers**:

```json
{
  "version": "1.0.0",
  "provider": "anthropic",
  "access_token": "…",
  "refresh_token": "…",
  "expires_at": 1735689600,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "oauth": {
    "authorize_url": "https://…/oauth/authorize",
    "token_url": "https://…/oauth/token",
    "revoke_url": "https://…/oauth/revoke"
  },
  "api": {
    "base_url": "https://api.example.com",
    "chat_url": "https://api.example.com/v1/messages",
    "models_url": "https://api.example.com/v1/models"
  },
  "headers": { "x-app-platform": "cli", "...": "..." },
  "body": { "max_tokens": 4096 }
}
```

## Field reference

### Top-level

- `version` — envelope schema version (`"1.0.0"`). Downstream consumers can check this and fail fast on a major-version bump that signals a breaking change.
- `provider` — short id matching the subcommand (`anthropic`, `openai-codex`, `google-gemini`, `github-copilot`).
- `access_token` / `refresh_token` — tokens as returned by the provider's token endpoint.
- `expires_at` — Unix epoch seconds at which `access_token` becomes invalid.
- `auth` — how to attach the token to API calls. `in` is `"header"` or `"query"`; `key` is the header/parameter name; `scheme` is the prefix (e.g. `Bearer`). Identical across all current providers (`Authorization: Bearer …`); kept as a structural field so future providers can vary.

### `oauth` — endpoints for the OAuth lifecycle

- `authorize_url` — where the browser sends the user to authenticate. (For device flows, this is the device-code endpoint; the user-facing URL is shown interactively during login.)
- `token_url` — POST here to refresh the access token. The exact body depends on the provider — see each provider's docs page. (GitHub Copilot is non-standard: refresh is a `GET` with the `ghu_…` token in `Authorization`.)
- `revoke_url` — OAuth 2.0 token-revocation endpoint (RFC 7009). `null` when the provider does not expose a user-callable revoke endpoint; in that case, revocation requires removing the grant from the provider's web UI.

### `api` — endpoints for actually using the token

- `base_url` — root of the API the token is scoped to.
- `chat_url` — canonical chat/inference endpoint. Forward `headers` + `body`, add provider-specific fields (`model`, `messages`, …), POST.
- `models_url` — model-listing endpoint, when the provider exposes one. `null` when there's no public listing endpoint (e.g. Google Code Assist's internal API).

### Wire-format helpers

- `headers` — extra HTTP headers the provider's official CLI sends and the API filters on. Forward these verbatim on every request (case is preserved to match the official CLI's wire output, even though HTTP headers are case-insensitive).
- `body` — request-body fields the API requires from CLI clients (e.g. system prompts, `max_tokens` defaults, project ids). Merge into your own request bodies.
- `extra` (optional) — anything provider-specific that doesn't fit the fields above. Currently:
  - `openai-codex.extra.id_token` — OpenID Connect id_token JWT carrying ChatGPT account/plan/email claims.
  - `google-gemini.extra.stream_chat_url` — SSE-streaming variant of `api.chat_url`.
  - `github-copilot.extra.is_enterprise` — `true` when the session token routes to a Copilot Enterprise tenant rather than `api.individual.githubcopilot.com`.

## Stdout layout

By default `login` copies the JSON envelope to the system clipboard and writes:

```
json below is copied to clipboard
---
<JSON envelope>
```

Pass `--example` to also append a copy-pasteable curl block:

```
json below is copied to clipboard
---
<JSON envelope>
---
<copy-pasteable curl block>
```

Pass `--no-clipboard` to skip the clipboard copy; the leading preamble is suppressed and stdout becomes just the JSON envelope (or `{…}\n---\ncurl` when combined with `--example`).

For pure JSON suitable for piping into `jq`, files, or downstream programs, pass `--no-clipboard`.

Human-readable progress (spinners, `✓ Token verified`, error messages) goes to **stderr** and never to stdout. If the clipboard is unavailable (e.g. Linux without xsel/xclip installed), a warning is printed to **stderr** and the preamble is omitted — the login still succeeds.

## Stability

The envelope is versioned via the top-level `version` field (semver). A major-version bump signals a breaking change; consumers should check `version` and fail fast on mismatch. Minor/patch bumps are additive only.
