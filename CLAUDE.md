# LLM Liberty — CLAUDE.md

## What this is

A CLI that runs the OAuth 2.1 flow used by official LLM provider CLIs (OpenAI, Anthropic, Google Gemini, GitHub Copilot, …) and emits the resulting credentials + provider-specific request metadata as JSON, so users can call the provider's API from their own apps using their existing subscription.

`llm-liberty` follows the documented OAuth protocol the provider's CLI uses and surfaces the full request shape (tokens, headers, body fields) the provider's API expects from that client. The user authenticates with their own provider account and uses the resulting credentials in software they own.

## Tech stack

- **Runtime**: Node ≥22, ESM-only (`"type": "module"`)
- **Language**: TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- **Bundler**: tsup (esbuild) → single-file `dist/cli.js` with `#!/usr/bin/env node` banner
- **CLI parsing**: commander
- **Interactive prompts**: @clack/prompts
- **Browser launcher**: open
- **Test**: vitest
- **Lint/format**: Biome (single tool, no ESLint/Prettier)
- **Package manager**: pnpm (`pnpm-lock.yaml`)
- **Release**: Changesets + GitHub Actions → npm
- **Distribution**: npm only. Primary invocation: `npx llm-liberty@latest <args>`

## Commands

```bash
pnpm install              # bootstrap
pnpm build                # tsup → dist/cli.js
pnpm dev                  # tsup --watch
pnpm start                # node dist/cli.js
pnpm test                 # vitest run
pnpm test:watch           # vitest
pnpm typecheck            # tsc --noEmit
pnpm lint                 # biome check .
pnpm format               # biome format --write .
pnpm changeset            # add a changeset for the next release
pnpm release              # build + changeset publish (CI uses this)
```

Smoke test after install:

```bash
pnpm build && node dist/cli.js --help
```

## Repo layout

```
src/
  cli.ts              # entry point — commander setup, subcommand dispatch
  providers/          # one file per provider: openai.ts, anthropic.ts, gemini.ts, copilot.ts
  oauth/              # generic OAuth 2.1 PKCE flow + localhost callback server
  output.ts           # JSON envelope shape (see "Output contract" below)
dist/                 # tsup output, gitignored
```

Single package — not a workspace. If we later want to expose the OAuth flows as a library, split into `packages/core` + `packages/cli`. Don't pre-split.

## Output contract

Every successful `login` run prints a JSON object to stdout describing both the credentials and the request shape the provider expects. Stable shape across providers:

```json
{
  "provider": "anthropic",
  "access_token": "…",
  "refresh_token": "…",
  "expires_at": 1735689600,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "headers": { "x-app-platform": "cli", "...": "..." },
  "body": { "max_tokens": 4096 }
}
```

- `auth` describes how to attach the token (header vs query, scheme).
- `headers` lists extra request headers the provider's CLI sends and the API filters on.
- `body` lists request-body fields the API requires/expects from CLI clients.
- Anything provider-specific that doesn't fit goes under `extra`.

Keep this shape stable. Breaking it breaks every downstream user of the JSON output.

## Provider notes (capture as we implement)

Each provider gets a short note here when added: client_id used, scopes, redirect URI, required headers the CLI client sends, body fields, refresh-token semantics, gotchas.

## Conventions

- ESM imports use explicit `.js` extensions in source (NodeNext + verbatimModuleSyntax requirement).
- Errors that the user should see → throw `LibertyError` (define in `src/errors.ts`); commander prints message + exits non-zero.
- Logs go to stderr; only the JSON envelope goes to stdout. Users will pipe the output.
- No `console.log` for diagnostics — use `console.error` or @clack/prompts.
- No backwards-compatibility shims, improve the architecture, bump versions.
- Comments only for non-obvious *why*. Don't restate the code.

## Security posture

- Never log tokens. Tokens go to stdout in the JSON envelope and nowhere else.
- Don't persist tokens to disk by default. If we add caching later, make it opt-in with an explicit flag and document the file path.
- Treat tokens as secrets in any error path — redact before printing or reporting.
- README and `--help` should describe the tool plainly: it runs the provider's documented OAuth flow on the user's behalf and prints the resulting credentials.
