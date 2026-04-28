# Anthropic (Claude / Claude Code)

```bash
npx llm-liberty@latest login anthropic
```

Runs the Claude Code OAuth flow in your default browser, exchanges the auth code for tokens, then verifies the result by calling `/v1/models`, picking the latest Haiku, and asking it "what day comes after Monday?". On success, prints the JSON envelope on stdout followed by `---` and a copy-pasteable `curl` you can re-run any time.

## Example output

The JSON envelope is copied to the clipboard by default (`--no-clipboard` to opt out).

```text
json below is copied to clipboard
---
{
  "provider": "anthropic",
  "access_token": "sk-ant-oat01-…",
  "refresh_token": "sk-ant-ort01-…",
  "expires_at": 1761686400,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "authorize_url": "https://claude.ai/oauth/authorize",
  "token_url": "https://platform.claude.com/v1/oauth/token",
  "logout_url": null,
  "headers": {
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01"
  },
  "body": {
    "system": "You are Claude Code, Anthropic's official CLI for Claude.",
    "max_tokens": 256
  }
}
---
curl -X POST 'https://api.anthropic.com/v1/messages' \
  -H 'Authorization: Bearer sk-ant-oat01-…' \
  -H 'content-type: application/json' \
  -H 'anthropic-beta: oauth-2025-04-20' \
  -H 'anthropic-version: 2023-06-01' \
  --data-raw \
  '{ … }'
```

## Flags

- `--no-verify` — skip the post-login API check (offline / CI use).
- `--no-example` — suppress the `---` separator and `curl` block; stdout becomes pure JSON for piping.
- `--no-clipboard` — skip copying the JSON envelope to the system clipboard; stdout reverts to the plain `{…}\n---\ncurl` layout.

## Calling the API with the resulting token

The Anthropic API requires every request from this OAuth client to send:

- `Authorization: Bearer <access_token>`
- `anthropic-beta: oauth-2025-04-20` (toggles the OAuth code path on the API)
- `anthropic-version: 2023-06-01`
- A system message identifying the client as Claude Code, supplied via the request body's `system` field.

The envelope's `headers` and `body` fields contain exactly what you need to forward — merge them into your request, add `model` + `messages`, and you're done.

## Operational notes

- The redirect URI is fixed at `http://localhost:53692/callback` (registered with the upstream OAuth client), so port `53692` must be free when you run `login anthropic`. If something else is bound to it, free the port (e.g. `lsof -i :53692`) and re-run.
- Refresh: POST to `token_url` with `{ grant_type: "refresh_token", client_id: <…>, refresh_token: <…> }` as JSON. The response uses the same `access_token` / `refresh_token` / `expires_in` shape as the initial exchange.
