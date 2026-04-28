# Development

## Setup

```bash
pnpm install
```

Requires Node ≥22 and pnpm.

## Scripts

| Command              | What it does                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm cli -- <args>` | Run the CLI from source via tsx — no build needed. Example: `pnpm cli login anthropic --no-verify`. |
| `pnpm build`         | Bundle to `dist/cli.js` via tsup (esbuild).                                                         |
| `pnpm dev`           | tsup in watch mode.                                                                                 |
| `pnpm start`         | Run the built bundle (`node dist/cli.js`).                                                          |
| `pnpm test`          | vitest run.                                                                                         |
| `pnpm test:watch`    | vitest in watch mode.                                                                               |
| `pnpm typecheck`     | `tsc --noEmit`.                                                                                     |
| `pnpm lint`          | `biome check .`.                                                                                    |
| `pnpm format`        | `biome format --write .`.                                                                           |
| `pnpm changeset`     | Add a changeset for the next release.                                                               |
| `pnpm release`       | Build + publish (CI uses this).                                                                     |

Smoke test after install:

```bash
pnpm build && node dist/cli.js --help
```

## Conventions

- **ESM imports use explicit `.js` extensions** in source (NodeNext + `verbatimModuleSyntax` requirement).
- User-visible errors → throw `LibertyError` from `src/errors.ts`; `cli.ts` catches, prints to stderr, exits non-zero.
- **stdout** = machine output (JSON envelope + optional curl block). **stderr** = human progress (spinners, PASS/FAIL). Never `console.log` diagnostics — use `console.error` or `@clack/prompts`.
- Biome formatting: 2-space indent, double quotes, trailing commas, 100-char line width.
- No backwards-compat shims. No premature abstraction. Comments only for non-obvious _why_.

## Adding a new provider

1. Create `src/providers/<name>.ts` exporting `loginXyz(opts: LoginOptions): Promise<void>` (`LoginOptions` lives in `src/output.ts`).
2. Embed the provider's well-known `client_id` **base64-encoded inline**; reference it nowhere else (not in README, docs, changelogs, or commits — see the policy in [`CLAUDE.md`](../CLAUDE.md)).
3. For redirect-based flows, call `runRedirectFlow` from `src/oauth/redirect-flow.ts` — it bundles PKCE, browser launch, the localhost callback server, and code+state validation. Use `src/oauth/pkce.ts`, `src/oauth/util.ts` (`base64urlRandom`, `sleep`), and `src/oauth/jwt.ts` as needed.
4. Build the envelope conforming to [`docs/output-contract.md`](output-contract.md). Use the `BEARER_AUTH` constant from `src/output.ts` for the `auth` field and populate the structured `oauth` and `api` groups. Populate `headers` and `body` with whatever the provider's API filters on; only put truly provider-specific fields in `extra`.
5. Implement a `verify` step that proves the token works end-to-end — for chat providers, list models (via `api.models_url` if exposed), pick a small/cheap one, send a one-word prompt, assert the response. The `--no-verify` flag skips it.
6. Build a `curl` example with `buildCurlExample(creds, model | null)` so users can copy-paste a working request. Always pull the URL from `creds.api.chat_url` so the example stays in sync with the envelope. The `--no-example` flag skips it.
7. Wire the new provider into the `PROVIDERS` registry in `src/cli.ts`.
8. Add user docs at `docs/<name>.md` and link it from `docs/index.md` and `README.md`'s "Supported providers" list.
9. `pnpm changeset` — minor bump, summary "Add `<name>` OAuth login provider".
