# LLM Liberty

> Free your LLM subscription.

`llm-liberty` is a CLI that runs the OAuth flow used by official LLM provider CLIs (OpenAI, Anthropic, Google Gemini, GitHub Copilot, …) and prints the resulting access token, refresh token, and provider-specific request metadata as JSON — so you can use your existing subscription from any app you build, not just the vendor's CLI.

## Usage

```bash
npx llm-liberty@latest login <provider>
```

Output:

```json
{
  "provider": "anthropic",
  "access_token": "…",
  "refresh_token": "…",
  "expires_at": 1735689600,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "headers": { "x-app-platform": "cli" },
  "body": { "max_tokens": 4096 }
}
```

## How it works

LLM provider CLIs authenticate users via OAuth 2.1 with a `localhost` redirect URI. `llm-liberty` follows the same protocol: opens your default browser to the provider's auth page, runs a local HTTP server to catch the redirect, exchanges the auth code for tokens, and emits everything you need to call the provider's API directly.

## Supported providers

_(Bootstrap stage — providers being added.)_

## Status

Early development. Expect breakage.

## License

MIT — see [LICENSE](./LICENSE).

## Sister project

`llm-liberty` is a sibling of [Bodhi App](https://github.com/BodhiSearch/BodhiApp) — same mission (democratize access to LLMs), independent codebase.
