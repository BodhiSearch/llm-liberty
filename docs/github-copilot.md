# GitHub Copilot

```bash
npx llm-liberty@latest login github-copilot
```

Runs GitHub's [OAuth device-code flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) under the well-known Copilot GitHub App, exchanges the resulting GitHub App user token (`ghu_…`) for a short-lived Copilot session token (`tid=…`) via `https://api.github.com/copilot_internal/v2/token`, auto-detects individual vs Copilot Enterprise from the session token's `proxy-ep` segment, then verifies end-to-end by streaming a one-word completion through `/chat/completions`. On success, copies the JSON envelope to the clipboard and prints it to stdout followed by `---` and a copy-pasteable streaming `curl`.

## How it differs from the other providers

- **No localhost callback.** The device flow uses a _user code_ you paste into a browser page on `github.com/login/device`. There is no localhost redirect and no port that needs to be free.
- **Two tokens at runtime.** The `access_token` in the envelope is the **Copilot session token** (~30 min, what goes on `Authorization: Bearer …` for `/chat/completions`). The `refresh_token` is the **`ghu_…` GitHub App user token** — long-lived, but refreshed via a non-standard `GET token_url` (see "Refresh" below) rather than the usual `grant_type=refresh_token`.
- **Always streaming.** Copilot Enterprise tokens **require** `stream: true` on `/chat/completions` (non-streaming returns `400`). For consistency we also stream on individual subscriptions, so `body.stream` is `true` in every envelope and the `curl` example demonstrates SSE.

## Example output

```text
GitHub device login
│
│  ABCD-1234
│
│  Open https://github.com/login/device and paste the code above.
│
└

⠋ Waiting for GitHub authorization…
✓ Token verified (model: gpt-4o-mini)

json below is copied to clipboard
---
{
  "provider": "github-copilot",
  "access_token": "tid=…;exp=…;proxy-ep=…",
  "refresh_token": "ghu_…",
  "expires_at": 1761686400,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "authorize_url": "https://github.com/login/device/code",
  "token_url": "https://api.github.com/copilot_internal/v2/token",
  "logout_url": null,
  "headers": {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat"
  },
  "body": { "stream": true },
  "extra": {
    "github_token": "ghu_…",
    "api_base": "https://api.individual.githubcopilot.com",
    "models_url": "https://api.individual.githubcopilot.com/models",
    "chat_completions_url": "https://api.individual.githubcopilot.com/chat/completions",
    "is_enterprise": false,
    "session_token_url": "https://api.github.com/copilot_internal/v2/token"
  }
}
---
curl -X POST 'https://api.individual.githubcopilot.com/chat/completions' \
  -H 'Authorization: Bearer tid=…' \
  -H 'content-type: application/json' \
  -H 'Accept: text/event-stream' \
  -H 'User-Agent: GitHubCopilotChat/0.35.0' \
  -H 'Editor-Version: vscode/1.107.0' \
  -H 'Editor-Plugin-Version: copilot-chat/0.35.0' \
  -H 'Copilot-Integration-Id: vscode-chat' \
  --data-raw \
  '{
    "stream": true,
    "model": "gpt-4o-mini",
    "messages": [
      { "role": "user", "content": "answer in one word, what day comes after Monday?" }
    ]
  }'
```

For Copilot Enterprise users, `extra.api_base` will instead be `https://api.<tenant>.githubcopilot.com` (derived from the `proxy-ep=…` segment of the session token by swapping `proxy.` → `api.`) and `extra.is_enterprise` will be `true`. The `curl` example points at the same resolved host.

## Flags

- `--no-verify` — skip the post-login streaming `/chat/completions` smoke test (offline / CI use). The device flow + session-token exchange still run, since both are needed to produce the credential.
- `--no-example` — suppress the `---` separator and `curl` block; stdout becomes pure JSON for piping.
- `--no-clipboard` — skip copying the JSON envelope to the system clipboard; stdout reverts to the plain `{…}\n---\ncurl` layout.

## Calling the API with the resulting token

POST to `extra.chat_completions_url` (`<api_base>/chat/completions`) with:

- `Authorization: Bearer <access_token>`
- `content-type: application/json`
- `Accept: text/event-stream`
- The four `headers` from the envelope (`User-Agent`, `Editor-Version`, `Editor-Plugin-Version`, `Copilot-Integration-Id`) — forwarded verbatim. The Copilot API rejects requests missing `Copilot-Integration-Id` (or with a value that doesn't match the integration the session was minted for) with `403 token not authorized for this integration`, and rejects preview models without the editor headers.

Body shape (merge `creds.body` and add `model` + `messages`):

```json
{
  "stream": true,
  "model": "gpt-4o-mini",
  "messages": [{ "role": "user", "content": "your message here" }]
}
```

Response is an SSE stream — each `data: {…}` line carries `choices[0].delta.content`, terminated by `data: [DONE]`. The list of available models for your account is at `extra.models_url`.

## Refresh

The `access_token` (session token) expires roughly every 30 minutes. To mint a new one, **GET** `token_url` (= `https://api.github.com/copilot_internal/v2/token`) with:

- `Authorization: Bearer <refresh_token>` — the long-lived `ghu_…` GitHub token (also exposed as `extra.github_token`)
- `Accept: application/json`
- The same four Copilot headers (`User-Agent`, `Editor-Version`, `Editor-Plugin-Version`, `Copilot-Integration-Id`)

The response is `{ token, expires_at, … }` — drop in as your new `access_token` / `expires_at`. Note: this is **not** the standard `grant_type=refresh_token` POST; envelope readers that assume OAuth-standard refresh semantics for every provider will need a Copilot-specific branch.

## Operational notes

- **No port required.** Unlike the other providers, this flow has no localhost callback server.
- **Subscription required.** A Copilot Free, Pro, Business, or Enterprise subscription is needed. Without one, the session-token request returns `403`.
- **Device-code expiry.** GitHub gives the user roughly 15 minutes to enter the user code in the browser before the device code expires; the CLI will report `Device code expired before authorization completed` and you can simply re-run.
- **SAML SSO orgs.** If your account is in a SAML-protected org, GitHub will prompt you to authorize each org during the device-flow consent screen — the same flow as `gh auth login`.
- **Enterprise routing.** When the session token includes `proxy-ep=proxy.<tenant>.githubcopilot.com`, requests are auto-routed to `https://api.<tenant>.githubcopilot.com`. Both individual (`api.individual.…`) and enterprise hosts use the same path layout (`/models`, `/chat/completions`).
- The `client_id` is the public GitHub App identifier baked into [`src/providers/github-copilot.ts`](../src/providers/github-copilot.ts) — the same one every official Copilot client (VS Code extension, JetBrains plugin, `gh copilot`, etc.) uses; per CLAUDE.md it lives only in that source file.
