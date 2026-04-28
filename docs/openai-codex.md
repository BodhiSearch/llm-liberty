# OpenAI Codex (ChatGPT / Codex CLI)

```bash
npx llm-liberty@latest login openai-codex
```

Runs the "Sign in with ChatGPT" OAuth flow used by the open-source [Codex CLI](https://github.com/openai/codex) in your default browser, exchanges the auth code for tokens, then verifies the result by calling the `/models` endpoint and sending a one-word prompt through `/responses` (SSE). On success, copies the JSON envelope to the clipboard and prints it to stdout followed by `---` and a copy-pasteable `curl`.

## Example output

```text
json below is copied to clipboard
---
{
  "provider": "openai-codex",
  "access_token": "<jwt>",
  "refresh_token": "…",
  "expires_at": 1761686400,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "authorize_url": "https://auth.openai.com/oauth/authorize",
  "token_url": "https://auth.openai.com/oauth/token",
  "logout_url": null,
  "headers": {
    "ChatGPT-Account-ID": "user-…",
    "originator": "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.1",
    "OpenAI-Beta": "responses=experimental"
  },
  "body": {
    "instructions": "You are Codex, OpenAI's coding agent.",
    "store": false,
    "stream": true
  },
  "extra": {
    "id_token": "<jwt>",
    "api_base": "https://chatgpt.com/backend-api/codex",
    "responses_url": "https://chatgpt.com/backend-api/codex/responses",
    "models_url": "https://chatgpt.com/backend-api/codex/models"
  }
}
---
curl -X POST 'https://chatgpt.com/backend-api/codex/responses' \
  -H 'Authorization: Bearer <jwt>' \
  -H 'content-type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'ChatGPT-Account-ID: user-…' \
  -H 'originator: codex_cli_rs' \
  -H 'User-Agent: codex_cli_rs/0.0.1' \
  -H 'OpenAI-Beta: responses=experimental' \
  --data-raw \
  '{
    "instructions": "You are Codex, OpenAI'"'"'s coding agent.",
    "store": false,
    "stream": true,
    "model": "…",
    "input": [
      { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "…" }] }
    ]
  }'
```

## Flags

- `--no-verify` — skip the post-login API check (offline / CI use).
- `--no-example` — suppress the `---` separator and `curl` block; stdout becomes pure JSON for piping.
- `--no-clipboard` — skip copying the JSON envelope to the system clipboard; stdout reverts to the plain `{…}\n---\ncurl` layout.

## Calling the API with the resulting token

The ChatGPT-backed Codex API is at `https://chatgpt.com/backend-api/codex`. Every request must include:

- `Authorization: Bearer <access_token>`
- `ChatGPT-Account-ID: <value from headers>` — derived from the `id_token` claims; already included in `headers`.
- `originator: codex_cli_rs` — required by the backend to route to the Codex path.
- `User-Agent: codex_cli_rs/<version>` — the backend validates the UA; the value in `headers` is correct.
- `OpenAI-Beta: responses=experimental` — beta opt-in some clusters still gate the Responses surface behind.

The envelope's `headers` field contains exactly these values — forward them verbatim on every request.

For chat/inference, POST to `extra.responses_url` (`…/responses`) with `Accept: text/event-stream` and merge `body` into your request:

```json
{
  "instructions": "You are Codex, OpenAI's coding agent.",
  "store": false,
  "stream": true,
  "model": "<model-id from /models>",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "your message here" }]
    }
  ]
}
```

Subscription OAuth has stricter rules than the public Responses API:

- `instructions` must be a **non-empty string** — the backend rejects requests without it (`HTTP 400 {"detail":"Instructions are required"}`).
- `input` must be an **array of message objects**, not a plain string. Each message has `type: "message"`, a `role`, and a `content` array of typed parts (e.g. `{"type": "input_text", "text": "…"}`).
- `store` must be **`false`** — server-side persistence is not available on subscription tokens.
- `stream` must be **`true`** — subscription OAuth is SSE-only.

The response is a Server-Sent Events stream. Parse `response.output_text.delta` events for incremental text and `response.completed` for the final snapshot. The defaults in `body` (`instructions`, `store`, `stream`) are merge-ready — your client just needs to add `model` and `input`.

## Operational notes

- The redirect URI is `http://localhost:1455/auth/callback` (registered with the upstream OAuth client), so port `1455` must be free when you run `login openai-codex`. If something else is bound to it, free the port (e.g. `lsof -i :1455`) and re-run.
- `access_token` is a JWT; its `exp` claim is used for `expires_at`. Refresh by POSTing to `token_url` with:
  ```json
  { "grant_type": "refresh_token", "client_id": "<see source>", "refresh_token": "<…>" }
  ```
  Content-Type for refresh is `application/json` (initial exchange is `application/x-www-form-urlencoded`).
- A ChatGPT Plus or Pro subscription is required to use the Responses API via this flow.
