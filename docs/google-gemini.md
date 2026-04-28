# Google Gemini (gemini-cli / Code Assist)

```bash
npx llm-liberty@latest login google-gemini
```

Runs the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) "Sign in with Google" OAuth flow in your default browser, exchanges the auth code for tokens, calls Code Assist's `loadCodeAssist` (and `onboardUser` for first-time users) to discover the `cloudaicompanionProject` your account is bound to, then verifies the result by sending a one-word prompt to `gemini-2.5-flash` via `cloudcode-pa.googleapis.com/v1internal:generateContent`. On success, copies the JSON envelope to the clipboard and prints it to stdout followed by `---` and a copy-pasteable `curl`.

The project-discovery step runs **even with `--no-verify`** — every API call requires the project id in the request body, so it is part of the credential, not a smoke check.

## Example output

```text
json below is copied to clipboard
---
{
  "provider": "google-gemini",
  "access_token": "ya29.…",
  "refresh_token": "1//…",
  "expires_at": 1761686400,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
  "token_url": "https://oauth2.googleapis.com/token",
  "logout_url": null,
  "headers": {
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "gl-node/22.17.0"
  },
  "body": {
    "project": "your-cloudaicompanion-project-id"
  },
  "extra": {
    "project_id": "your-cloudaicompanion-project-id",
    "api_base": "https://cloudcode-pa.googleapis.com/v1internal",
    "generate_content_url": "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
    "stream_generate_content_url": "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
  }
}
---
curl -X POST 'https://cloudcode-pa.googleapis.com/v1internal:generateContent' \
  -H 'Authorization: Bearer ya29.…' \
  -H 'content-type: application/json' \
  -H 'User-Agent: google-api-nodejs-client/9.15.1' \
  -H 'X-Goog-Api-Client: gl-node/22.17.0' \
  --data-raw \
  '{
    "model": "gemini-2.5-flash",
    "project": "your-cloudaicompanion-project-id",
    "request": {
      "contents": [
        { "role": "user", "parts": [{ "text": "answer in one word, what day comes after Monday?" }] }
      ]
    }
  }'
```

## Flags

- `--no-verify` — skip the post-login `:generateContent` smoke test (offline / CI use). The `loadCodeAssist` + onboarding step still runs because the project id is part of the credential.
- `--no-example` — suppress the `---` separator and `curl` block; stdout becomes pure JSON for piping.
- `--no-clipboard` — skip copying the JSON envelope to the system clipboard; stdout reverts to the plain `{…}\n---\ncurl` layout.

## Calling the API with the resulting token

OAuth tokens issued under the gemini-cli `client_id` are scoped to a **private** Google API at `https://cloudcode-pa.googleapis.com/v1internal` — _not_ the public `https://generativelanguage.googleapis.com/v1beta` you may know from the API-key flow. Sending these tokens to the public endpoint returns `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`. Use `extra.generate_content_url` (or `extra.stream_generate_content_url` for SSE streaming).

The internal endpoint also uses a **wrapped** request body — the user-facing `contents` / `generationConfig` go inside a `request: {…}` envelope, alongside top-level `model` and `project` fields:

```json
{
  "model": "gemini-2.5-flash",
  "project": "<value from body.project>",
  "request": {
    "contents": [{ "role": "user", "parts": [{ "text": "your message here" }] }],
    "generationConfig": { "maxOutputTokens": 256 }
  }
}
```

Build it from the envelope as `{ ...creds.body, model, request: { contents, ... } }` — `creds.body` already contains `project`, so you only have to add `model` and `request`.

Required headers (forward `headers` verbatim and add `Authorization` + `content-type`):

- `Authorization: Bearer <access_token>`
- `content-type: application/json`
- `User-Agent: google-api-nodejs-client/9.15.1`
- `X-Goog-Api-Client: gl-node/22.17.0`

For Server-Sent Events streaming, POST to `extra.stream_generate_content_url` with the same body shape and parse the `data:` lines as `GenerateContentResponse` chunks.

## Operational notes

- The redirect URI is `http://localhost:8085/oauth2callback`, so port `8085` must be free when you run `login google-gemini`. If something else is bound to it, free the port (e.g. `lsof -i :8085`) and re-run.
- The flow requests `access_type=offline` + `prompt=consent`, so a fresh `refresh_token` is returned on every login. Refresh by POSTing to `token_url` with `application/x-www-form-urlencoded`:
  ```
  grant_type=refresh_token&client_id=<…>&client_secret=<…>&refresh_token=<…>
  ```
  Both `client_id` and `client_secret` are baked into [`src/providers/google-gemini.ts`](../src/providers/google-gemini.ts) — Google explicitly documents that the client secret of an installed-app OAuth client is not actually a secret.
- A free-tier or Google AI Pro account is required. First-time users are auto-onboarded via `:onboardUser`; this involves a long-running operation that is polled every ~5s and is reported via the spinner.
- If `:loadCodeAssist` or `:generateContent` returns `SERVICE_DISABLED` for `cloudcode-pa.googleapis.com`, the issue is a server-side Google entitlement on your account, not the CLI — see [google-gemini/gemini-cli#25167](https://github.com/google-gemini/gemini-cli/issues/25167) for context.
- `expires_at` is computed as `now + expires_in` from the token endpoint (typically ~1 hour). Access tokens here are opaque (not JWTs), so the expiry is taken from the OAuth response, not decoded from the token itself.
