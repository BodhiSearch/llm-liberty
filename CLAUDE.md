# LLM Liberty — CLAUDE.md

## What this is

A Node CLI that runs the OAuth 2.1 flows used by official LLM provider CLIs (OpenAI, Anthropic, Google Gemini, GitHub Copilot, …) and emits the resulting credentials + provider-specific request metadata as JSON, so users can call the provider's API from their own apps using their existing subscription.

## Tech stack

- **Runtime**: Node ≥22, ESM-only (`"type": "module"`)
- **Language**: TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- **Bundler**: tsup (esbuild) → single-file `dist/cli.js` with `#!/usr/bin/env node` banner
- **CLI parsing**: commander · **Prompts**: @clack/prompts · **Browser launcher**: open
- **Test**: vitest · **Lint/format**: Biome · **Package manager**: pnpm
- **Release**: `just release` → git tag push → GitHub Actions → npm (`@bodhiapp/llm-liberty`). Changesets used for authoring change entries. Primary invocation: `npx @bodhiapp/llm-liberty@latest <args>`

## Repo layout

```
src/
  cli.ts              # entry point — commander + PROVIDERS registry
  errors.ts           # LibertyError
  output.ts           # JSON envelope shape, BEARER_AUTH, LoginOptions, emit()
  oauth/              # PKCE, localhost callback server, JWT decode, shared redirect flow, util
  providers/          # one file per provider (oauth flow + verify + curl example)
scripts/              # release pre-check scripts (zero-dep Node ESM, .mjs)
docs/                 # user-facing & developer docs (see docs/index.md)
dist/                 # tsup output, gitignored
justfile              # release recipe: just release
.github/workflows/    # publish.yml — triggered on v* tag push
```

Single package — not a workspace. If we later want to expose the OAuth flows as a library, split into `packages/core` + `packages/cli`. Don't pre-split.

## Critical conventions

- **ESM imports use explicit `.js` extensions** in source (NodeNext + verbatimModuleSyntax requirement).
- User-visible errors → throw `LibertyError`; `cli.ts` catches, prints to stderr, exits non-zero.
- **stdout** = machine output (JSON envelope, optional `---` + curl block). **stderr** = human progress (spinners, PASS/FAIL). Never `console.log` diagnostics — use `console.error` or @clack/prompts.
- No backwards-compatibility shims. No premature abstraction. Comments only for non-obvious _why_.
- **Never log tokens** outside the JSON envelope (and the deliberate `--example` curl block).

## Provider `client_id` policy

The `client_id` for each provider is the well-known one its official CLI uses. Embed it hex-encoded in `src/providers/<name>.ts` and reference it **nowhere else** — not README, not CLAUDE.md, not changelogs, not commit messages, not docs/. The source file is the single record. The user authenticating with their own provider account is what makes the flow legitimate; the client_id is just the public identifier the official CLI uses.

## Where to look next

Everything else lives under `docs/` — start at [docs/index.md](docs/index.md):

- `docs/development.md` — local dev workflow, scripts, adding a new provider
- `docs/output-contract.md` — the stable JSON envelope spec
- `docs/security.md` — security posture
- `docs/<provider>.md` — per-provider user documentation (one file per provider, flat under `docs/`)
