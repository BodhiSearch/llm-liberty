# GitHub Copilot

```bash
npx @bodhiapp/llm-liberty@latest login github-copilot
```

Runs GitHub's [OAuth device-code flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) under the well-known Copilot GitHub App, exchanges the resulting GitHub App user token (`ghu_…`) for a short-lived Copilot session token (`tid=…`) via `https://api.github.com/copilot_internal/v2/token`, auto-detects individual vs Copilot Enterprise from the session token's `proxy-ep` segment, then verifies end-to-end by streaming a one-word completion through `/chat/completions`. On success, copies the JSON envelope to the clipboard and prints it to stdout. Pass `--example` to also append a copy-pasteable streaming `curl`.

## How it differs from the other providers

- **No localhost callback.** The device flow uses a _user code_ you paste into a browser page on `github.com/login/device`. There is no localhost redirect and no port that needs to be free.
- **Two tokens at runtime.** The `access_token` in the envelope is the **Copilot session token** (~30 min, what goes on `Authorization: Bearer …` for `/chat/completions`). The `refresh_token` is the **`ghu_…` GitHub App user token** — long-lived, but refreshed via a non-standard `GET token_url` (see "Refresh" below) rather than the usual `grant_type=refresh_token`.
- **Always streaming.** Copilot Enterprise tokens **require** `stream: true` on `/chat/completions` (non-streaming returns `400`). For consistency we also stream on individual subscriptions, so `body.stream` is `true` in every envelope and the `curl` example demonstrates SSE.

## Example output

With `--example` you'll also see a streaming `curl` block appended after the JSON envelope:

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
  "oauth": {
    "authorize_url": "https://github.com/login/device/code",
    "token_url": "https://api.github.com/copilot_internal/v2/token",
    "revoke_url": null
  },
  "api": {
    "base_url": "https://api.individual.githubcopilot.com",
    "chat_url": "https://api.individual.githubcopilot.com/chat/completions",
    "models_url": "https://api.individual.githubcopilot.com/models"
  },
  "headers": {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat"
  },
  "body": { "stream": true },
  "extra": { "is_enterprise": false }
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

For Copilot Enterprise users, `api.base_url` will instead be `https://api.<tenant>.githubcopilot.com` (derived from the `proxy-ep=…` segment of the session token by swapping `proxy.` → `api.`) and `extra.is_enterprise` will be `true`. The `curl` example, `chat_url`, and `models_url` all point at the same resolved host.

## Flags

- `--no-verify` — skip the post-login streaming `/chat/completions` smoke test (offline / CI use). The device flow + session-token exchange still run, since both are needed to produce the credential.
- `--example` — also print a `---` separator and a copy-pasteable streaming `curl` example after the JSON envelope. Off by default.
- `--no-clipboard` — skip copying the JSON envelope to the system clipboard; stdout becomes the plain JSON envelope (or `{…}\n---\ncurl` when combined with `--example`).

## Calling the API with the resulting token

POST to `api.chat_url` (`<base_url>/chat/completions`) with:

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

Response is an SSE stream — each `data: {…}` line carries `choices[0].delta.content`, terminated by `data: [DONE]`. The list of available models for your account is at `api.models_url`.

## Refresh

The `access_token` (session token) expires roughly every 30 minutes. To mint a new one, **GET** `oauth.token_url` (= `https://api.github.com/copilot_internal/v2/token`) with:

- `Authorization: Bearer <refresh_token>` — the long-lived `ghu_…` GitHub token (this is the same value as `refresh_token` at the top level)
- `Accept: application/json`
- The same four Copilot headers (`User-Agent`, `Editor-Version`, `Editor-Plugin-Version`, `Copilot-Integration-Id`)

The response is `{ token, expires_at, … }` — drop in as your new `access_token` / `expires_at`. Note: this is **not** the standard `grant_type=refresh_token` POST; envelope readers that assume OAuth-standard refresh semantics for every provider will need a Copilot-specific branch.

## Revoke

`oauth.revoke_url` is `null` for GitHub Copilot. GitHub's [token-revocation API](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token) (`DELETE /applications/{client_id}/token`) requires HTTP Basic auth using the OAuth app's `client_id` + `client_secret` — public clients like the Copilot app don't expose a usable `client_secret`, so end users can't call it directly. To revoke, sign in to GitHub and remove the **GitHub Copilot** entry under [Settings → Applications → Authorized OAuth Apps](https://github.com/settings/applications).

## Operational notes

- **No port required.** Unlike the other providers, this flow has no localhost callback server.
- **Subscription required.** A Copilot Free, Pro, Business, or Enterprise subscription is needed. Without one, the session-token request returns `403`.
- **Device-code expiry.** GitHub gives the user roughly 15 minutes to enter the user code in the browser before the device code expires; the CLI will report `Device code expired before authorization completed` and you can simply re-run.
- **SAML SSO orgs.** If your account is in a SAML-protected org, GitHub will prompt you to authorize each org during the device-flow consent screen — the same flow as `gh auth login`.
- **Enterprise routing.** When the session token includes `proxy-ep=proxy.<tenant>.githubcopilot.com`, requests are auto-routed to `https://api.<tenant>.githubcopilot.com`. Both individual (`api.individual.…`) and enterprise hosts use the same path layout (`/models`, `/chat/completions`).
- The `client_id` is the public GitHub App identifier baked into [`src/providers/github-copilot.ts`](../src/providers/github-copilot.ts) — the same one every official Copilot client (VS Code extension, JetBrains plugin, `gh copilot`, etc.) uses; per CLAUDE.md it lives only in that source file.
