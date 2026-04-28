# Output contract

Every successful `login` run prints a JSON object to stdout describing both the credentials and the request shape the provider expects. The shape is **stable across providers**:

```json
{
  "provider": "anthropic",
  "access_token": "…",
  "refresh_token": "…",
  "expires_at": 1735689600,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "authorize_url": "https://…/oauth/authorize",
  "token_url": "https://…/oauth/token",
  "logout_url": null,
  "headers": { "x-app-platform": "cli", "...": "..." },
  "body": { "max_tokens": 4096 }
}
```

## Field reference

- `provider` — short id matching the subcommand (`anthropic`, `openai`, …).
- `access_token` / `refresh_token` — tokens as returned by the provider's token endpoint.
- `expires_at` — Unix epoch seconds at which `access_token` becomes invalid.
- `auth` — how to attach the token to API calls. `in` is `"header"` or `"query"`; `key` is the header/parameter name; `scheme` is the prefix (e.g. `Bearer`).
- `authorize_url` / `token_url` — OAuth endpoints. `token_url` is what you POST to with `grant_type=refresh_token` to refresh.
- `logout_url` — `null` when the provider has no documented OAuth logout endpoint.
- `headers` — extra HTTP headers the provider's official CLI sends and the API filters on. Forward these verbatim on every request.
- `body` — request-body fields the API requires from CLI clients (e.g. system prompts, max_tokens defaults). Merge into your own request bodies.
- `extra` (optional) — anything provider-specific that doesn't fit the fields above.

## Stdout layout

By default `login` copies the JSON envelope to the system clipboard and writes:

```
json below is copied to clipboard
---
<JSON envelope>
---
<copy-pasteable curl block>
```

Pass `--no-clipboard` to skip the clipboard copy; the leading preamble is suppressed and stdout becomes:

```
<JSON envelope>
---
<copy-pasteable curl block>
```

Pass `--no-example` to suppress the `---` separator and curl block entirely.

Combining both (`--no-clipboard --no-example`) gives pure JSON for piping into `jq`, files, or downstream programs.

Human-readable progress (spinners, `✓ Token verified`, error messages) goes to **stderr** and never to stdout. If the clipboard is unavailable (e.g. Linux without xsel/xclip installed), a warning is printed to **stderr** and the preamble is omitted — the login still succeeds.

## Stability

Project is still evolving, so the contracts are not fixed and can break. Freeze at a given version if you find contract breaking in recent versions or update your parsing logic.
