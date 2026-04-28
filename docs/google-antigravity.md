# Google Antigravity (IDE / Cloud Code Assist Unified Gateway)

```bash
npx llm-liberty@latest login google-antigravity
```

Runs the [Google Antigravity](https://antigravity.google) IDE OAuth flow in your default browser, exchanges the auth code for tokens, calls Cloud Code Assist's `loadCodeAssist` (and `onboardUser` for first-time users) to discover the `cloudaicompanionProject` your account is bound to, then verifies the result by sending a one-word prompt to `gemini-3-flash` via `cloudcode-pa.googleapis.com/v1internal:generateContent`. On success, copies the JSON envelope to the clipboard and prints it to stdout. Pass `--example` to also append a copy-pasteable `curl`.

The project-discovery step runs **even with `--no-verify`** — every API call requires the project id in the request body, so it is part of the credential, not a smoke check.

Antigravity is Google's unified-gateway product: a single Gemini-style API that fans out to Gemini, Anthropic Claude, and other model backends. The same OAuth token reaches all of them — just change the `model` field in the request body.

## Example output

With `--example` you'll also see a `curl` block appended after the JSON envelope:

```text
json below is copied to clipboard
---
{
  "provider": "google-antigravity",
  "access_token": "ya29.…",
  "refresh_token": "1//…",
  "expires_at": 1761686400,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "oauth": {
    "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
    "token_url": "https://oauth2.googleapis.com/token",
    "revoke_url": "https://oauth2.googleapis.com/revoke"
  },
  "api": {
    "base_url": "https://cloudcode-pa.googleapis.com/v1internal",
    "chat_url": "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
    "models_url": null
  },
  "headers": {
    "User-Agent": "antigravity/1.15.8 windows/amd64",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": "{\"ideType\":\"ANTIGRAVITY\",\"platform\":\"MACOS\",\"pluginType\":\"GEMINI\"}"
  },
  "body": {
    "project": "your-cloudaicompanion-project-id",
    "userAgent": "antigravity",
    "requestId": "<uuid>"
  },
  "extra": {
    "stream_chat_url": "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
  }
}
---
curl -X POST 'https://cloudcode-pa.googleapis.com/v1internal:generateContent' \
  -H 'Authorization: Bearer ya29.…' \
  -H 'content-type: application/json' \
  -H 'User-Agent: antigravity/1.15.8 windows/amd64' \
  -H 'X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1' \
  -H 'Client-Metadata: {"ideType":"ANTIGRAVITY","platform":"MACOS","pluginType":"GEMINI"}' \
  --data-raw \
  '{
    "project": "your-cloudaicompanion-project-id",
    "model": "gemini-3-flash",
    "request": {
      "contents": [
        { "role": "user", "parts": [{ "text": "answer in one word, what day comes after Monday?" }] },
      ],
      "generationConfig": { "maxOutputTokens": 256 }
    },
    "userAgent": "antigravity",
    "requestId": "<uuid>"
  }'
```

## Flags

- `--no-verify` — skip the post-login `:generateContent` smoke test (offline / CI use). The `loadCodeAssist` + onboarding step still runs because the project id is part of the credential.
- `--example` — also print a `---` separator and a copy-pasteable `curl` example after the JSON envelope. Off by default.
- `--no-clipboard` — skip copying the JSON envelope to the system clipboard; stdout becomes the plain JSON envelope (or `{…}\n---\ncurl` when combined with `--example`).

## Calling the API with the resulting token

OAuth tokens issued under the Antigravity `client_id` are scoped to the same private Cloud Code Assist host as `google-gemini` (`https://cloudcode-pa.googleapis.com/v1internal`) — _not_ the public `https://generativelanguage.googleapis.com/v1beta` API-key endpoint. Use `api.chat_url` (or `extra.stream_chat_url` for SSE streaming).

The gateway uses a **wrapped** request body: the user-facing `contents` / `generationConfig` go inside a `request: {…}` envelope, alongside top-level `model`, `project`, `userAgent`, and `requestId` fields:

```json
{
  "project": "<value from body.project>",
  "model": "gemini-3-flash",
  "request": {
    "contents": [{ "role": "user", "parts": [{ "text": "your message here" }] }],
    "generationConfig": { "maxOutputTokens": 256 },
    "systemInstruction": { "parts": [{ "text": "You are a helpful assistant." }] }
  },
  "userAgent": "antigravity",
  "requestId": "<unique id per request, e.g. crypto.randomUUID()>"
}
```

Build it from the envelope as `{ ...creds.body, model, request: { contents, ... }, requestId: <fresh uuid> }` — `creds.body` already contains `project` + `userAgent`. **Generate a new `requestId` per request**: the value baked into the envelope is just a sample, and Google's gateway uses `requestId` for de-duplication on retries.

Required headers (forward `headers` verbatim and add `Authorization` + `content-type`):

- `Authorization: Bearer <access_token>`
- `content-type: application/json`
- `User-Agent: antigravity/1.15.8 windows/amd64`
- `X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1`
- `Client-Metadata: {"ideType":"ANTIGRAVITY","platform":"MACOS","pluginType":"GEMINI"}`

For Server-Sent Events streaming, POST to `extra.stream_chat_url` with the same body shape and an `Accept: text/event-stream` header; parse the `data:` lines as `GenerateContentResponse` chunks.

`api.models_url` is `null` because Antigravity's gateway does not expose a public model-listing endpoint. Useful model ids include:

- **Gemini** — `gemini-3-flash` (cheapest; default verify model), `gemini-3-pro-low`, `gemini-3-pro-high` (Pro variants **require** the `-low` / `-high` thinking-budget suffix; sending bare `gemini-3-pro` returns a 404).
- **Anthropic** — `claude-sonnet-4-6`, `claude-opus-4-6-thinking`.
- **Other** — `gpt-oss-120b-medium`.

> **Note.** All models use the same Gemini-style request shape. Anthropic-style `messages` arrays, `anthropic_version`, `max_tokens`, and plain-string `systemInstruction` are **not** accepted — always use `request.contents[]` with `role: "user" | "model"` and `request.systemInstruction.parts[]`. See the [Antigravity API spec](https://github.com/fares111111122/fares-antigravity-oauth/blob/main/docs/ANTIGRAVITY_API_SPEC.md) for full request/response details.

## Operational notes

- The redirect URI is `http://localhost:36742/oauth-callback`, so port `36742` must be free when you run `login google-antigravity`. If something else is bound to it, free the port (e.g. `lsof -i :36742`) and re-run. The port is deliberately distinct from `google-gemini`'s `8085`, so both providers can be logged into in the same shell session.
- The flow requests `access_type=offline` + `prompt=consent`, so a fresh `refresh_token` is returned on every login. **Refresh** by POSTing to `oauth.token_url` with `application/x-www-form-urlencoded`:
  ```
  grant_type=refresh_token&client_id=<…>&client_secret=<…>&refresh_token=<…>
  ```
  Both `client_id` and `client_secret` are baked into [`src/providers/google-antigravity.ts`](../src/providers/google-antigravity.ts) — Google explicitly documents that the client secret of an installed-app OAuth client is not actually a secret.
- **Revoke**: POST to `oauth.revoke_url` (`https://oauth2.googleapis.com/revoke`) with `?token=<access_or_refresh_token>` — Google's standard RFC 7009 endpoint accepts either an access or refresh token and immediately invalidates it. You can also remove the grant interactively at <https://myaccount.google.com/permissions>.
- An Antigravity-eligible Google account is required. First-time users are auto-onboarded via `:onboardUser`; this involves a long-running operation that is polled every ~5s and reported via the spinner.
- The grant uses the same scopes as `google-gemini` plus two extras (`cclog`, `experimentsandconfigs`) — these are what differentiate the Antigravity grant from the plain Gemini grant on the consent screen.
- If `:loadCodeAssist` or `:generateContent` returns `SERVICE_DISABLED` for `cloudcode-pa.googleapis.com`, the issue is a server-side Google entitlement on your account, not the CLI.
- `expires_at` is computed as `now + expires_in` from the token endpoint (typically ~1 hour). Access tokens here are opaque (not JWTs), so the expiry is taken from the OAuth response, not decoded from the token itself.
