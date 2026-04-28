# LLM Liberty

> Free your LLM subscription.

`llm-liberty` is a CLI that runs the OAuth flow used by official LLM provider CLIs (OpenAI, Anthropic, Google Gemini, GitHub Copilot, …) and prints the resulting access token, refresh token, and provider-specific request metadata as JSON — so you can use your existing subscription from any app you build, not just the vendor's CLI.

## Quick start

```bash
npx llm-liberty@latest login <provider>
```

Opens your default browser to the provider's OAuth page, runs a local HTTP server to catch the redirect, exchanges the auth code for tokens, and prints everything you need to call the provider's API directly.

## Supported providers

- **Anthropic** (Claude / Claude Code) — see [`docs/anthropic.md`](docs/anthropic.md)
- **OpenAI Codex** (ChatGPT / Codex CLI) — see [`docs/openai-codex.md`](docs/openai-codex.md)

_(More coming — Google Gemini, GitHub Copilot.)_

## Documentation

Full docs live under [`docs/`](docs/index.md):

- [`docs/output-contract.md`](docs/output-contract.md) — the stable JSON envelope every `login` run emits
- [`docs/development.md`](docs/development.md) — local dev workflow & adding a new provider
- [`docs/security.md`](docs/security.md) — what we do and don't do with tokens

## Status

Early development. Expect breakage.

## License

MIT — see [LICENSE](./LICENSE).

## Sister project

`llm-liberty` is a sibling of [Bodhi App](https://github.com/BodhiSearch/BodhiApp) — same mission (democratize access to LLMs), independent codebase.
