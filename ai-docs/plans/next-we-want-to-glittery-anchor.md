# Flip `--example` from opt-out to opt-in

## Context

Today every successful `login` run prints the JSON envelope **and** a copy-pasteable `curl` block separated by `---`. Users who only want the JSON envelope (the credential) must remember to pass `--no-example`. The curl block is a convenience for first-time exploration but is rarely needed in scripted/programmatic use, and printing the access token a second time inside a shell-quoted curl line increases the surface area for accidental token leakage in terminal history, screenshots, and pasted output.

We want the JSON envelope to be the default minimal output and treat the curl example as an explicit opt-in. After this change:

- `npx llm-liberty@latest login <provider>` → JSON envelope only (plus the clipboard preamble when applicable).
- `npx llm-liberty@latest login <provider> --example` → JSON envelope **followed by** `---` and the curl block (current default behavior).

`--no-verify` and `--no-clipboard` are unaffected — they remain opt-out because their defaults (verify on, clipboard on) are what most users want.

## Scope of change

This is a CLI flag flip plus a docs sweep. No provider logic changes — every provider already gates `buildCurlExample(...)` behind `opts.example`, so flipping the default at the commander layer is sufficient.

## Code change

### `src/cli.ts`

Replace the `--no-example` option with an `--example` option that defaults to `false`:

```ts
.option("--example", "Also print a copy-pasteable curl example after the JSON envelope.", false)
```

Notes:

- The third arg `false` is commander's explicit default — keeps `LoginOptions.example: boolean` strict (no need to widen to `boolean | undefined`).
- No change to `src/output.ts`'s `LoginOptions` interface, no change to `emit()` — provider files at `src/providers/*.ts` already call `opts.example ? buildCurlExample(...) : null` and continue to work.
- Re-order the option list so `--example` sits next to the existing opt-out flags (just below `--no-verify`) for readability.

## Docs updates

All five provider docs follow the same template (a "Flags" section with three bullets) so the per-file change is mechanical.

### Per-provider docs (`docs/anthropic.md`, `docs/openai-codex.md`, `docs/google-gemini.md`, `docs/github-copilot.md`, `docs/google-antigravity.md`)

1. **Opening paragraph** — every provider doc currently says "…prints it to stdout followed by `---` and a copy-pasteable `curl`." Change the trailing clause to "…prints the JSON envelope to stdout. Pass `--example` to also append a copy-pasteable `curl`."
2. **Flags section** — replace
   ```
   - `--no-example` — suppress the `---` separator and `curl` block; stdout becomes pure JSON for piping.
   ```
   with
   ```
   - `--example` — also print a `---` separator and a copy-pasteable `curl` example after the JSON envelope. Off by default.
   ```
3. **Example output block** — keep the existing combined JSON+curl block, but prefix it with a sentence: "With `--example` you'll see:" so the doc still demonstrates what the curl looks like without misrepresenting the default.
4. **Companion bullet** — the `--no-clipboard` bullet currently says "stdout reverts to the plain `{…}\n---\ncurl` layout." Update to "stdout becomes the plain JSON envelope (or `{…}\n---\ncurl` when combined with `--example`)."

### `docs/output-contract.md`

Rewrite the **Stdout layout** section (lines 57–79):

- Default layout is now **clipboard preamble + JSON envelope** (no trailing `---`/curl).
- Document `--example` as the opt-in that appends `---` + curl.
- Update the "combining flags" sentence: pure JSON for piping is now the default; you only need `--no-clipboard` to drop the preamble.
- Drop the `--no-clipboard --no-example` example pairing; replace with a single `--no-clipboard` example for piping into `jq`.

### `docs/index.md`

Line 5 currently says "the `---` curl block emitted by default." Change to "the optional `---` curl block emitted when `--example` is passed."

### `docs/development.md`

Line 48 currently says "The `--no-example` flag skips it." Change to "The curl block is gated behind the `--example` flag (off by default)."
Line 37 ("optional curl block") is already accurate — leave alone.

### `docs/security.md`

Line 7 already references "the `--example` curl block" — leave alone.

### `CLAUDE.md`

Line 37 already references the deliberate `--example` curl block — leave alone.

## Changeset

Add `.changeset/example-flag-default.md`:

```
---
"llm-liberty": minor
---

Flip the `curl` example from opt-out to opt-in. The default `login` output is now just the JSON envelope (plus the clipboard preamble when applicable). Pass the new `--example` flag to additionally print the `---` separator and a copy-pasteable `curl`. The legacy `--no-example` flag is removed; if you were already passing it, simply drop it.
```

(Marked `minor` to match the existing changesets in this repo and signal a user-visible CLI change. Pre-1.0 so technically allowed under semver, and the project's stability docs already note the contract may break.)

## Critical files

- `src/cli.ts` — the only source change (flip option).
- `src/output.ts` — read-only verify; no change needed.
- `src/providers/{anthropic,openai-codex,google-gemini,google-antigravity,github-copilot}.ts` — read-only verify that each still uses `opts.example ?` and doesn't assume default-true; no change needed.
- `docs/{anthropic,openai-codex,google-gemini,google-antigravity,github-copilot}.md` — flag bullet + opening paragraph + example-section preface.
- `docs/output-contract.md` — Stdout layout rewrite.
- `docs/index.md`, `docs/development.md` — one-line touch-ups.
- `.changeset/example-flag-default.md` — new file.

## Verification

1. `pnpm typecheck && pnpm lint` — ensures the option change doesn't break the `LoginOptions` contract.
2. `pnpm format` — Biome + Prettier on the touched files.
3. Smoke test the new default and the opt-in against one provider that's already logged in (e.g. anthropic):
   - `pnpm cli login anthropic --no-clipboard` — stdout should be **just the JSON envelope** (no `---`, no curl).
   - `pnpm cli login anthropic --no-clipboard --example` — stdout should be JSON envelope, then `---`, then curl block.
   - `pnpm cli login anthropic --no-clipboard --no-example` — should fail with commander's "unknown option" error (confirms the old flag is gone).
4. Pipe-into-jq sanity: `pnpm cli login anthropic --no-clipboard | jq .provider` should print `"anthropic"` without any prior `--no-example` needed.
5. Skim the rendered docs (`docs/anthropic.md` and `docs/output-contract.md`) to confirm the opt-in framing reads naturally and the example-output block still makes sense with its new "With `--example` you'll see:" preface.
