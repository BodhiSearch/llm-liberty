# Plan — `login openai-codex` + clipboard support

## Context

Two changes in one pass:

1. **Add `login openai-codex`.** Anthropic's OAuth flow already ships; the next provider on the roadmap is OpenAI's "Sign in with ChatGPT" flow that the open-source `codex` CLI uses. Authenticated users can then call the ChatGPT-backed Responses API at `https://chatgpt.com/backend-api/codex` from their own apps with their existing ChatGPT Plus/Pro subscription.

2. **Copy the JSON envelope to the clipboard by default**, with an opt-out flag. The most common downstream action after `login` is "paste this token somewhere" — putting it on the clipboard saves a step. Add `--no-clipboard` for users who want to keep stdout pristine for piping.

The two are bundled because both touch the same emit path and the same CLI flag surface.

---

## Part 1 — Codex OAuth provider

### New file: `src/providers/openai-codex.ts`

Mirrors the structure of `src/providers/anthropic.ts`:

```
export async function loginOpenAICodex(opts: LoginOptions, emitOpts: EmitOptions): Promise<void>
```

OAuth parameters (sourced from `codex-rs/login/src/{server,pkce,auth/manager}.rs`; full notes in `ai-docs/plans/we-have-implemented-oauth-parsed-glacier-agent-a2d454f272bbeed4a.md`):

| Field            | Value                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `client_id`      | `app_EMoamEEZ73f0CkXaXp7hrann` — store base64-encoded inline per CLAUDE.md policy                                                |
| `authorize_url`  | `https://auth.openai.com/oauth/authorize`                                                                                        |
| `token_url`      | `https://auth.openai.com/oauth/token`                                                                                            |
| `redirect_uri`   | `http://localhost:1455/auth/callback`                                                                                            |
| `port` / `path`  | `1455` / `/auth/callback`                                                                                                        |
| `scope`          | `openid profile email offline_access api.connectors.read api.connectors.invoke`                                                  |
| Extra authorize params | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=codex_cli_rs`                              |
| `state`          | base64url-nopad of 32 random bytes — **separate from PKCE verifier** (anthropic re-uses verifier as state; codex does not)       |
| PKCE             | S256, `code_verifier` from 64 random bytes (codex uses 64, not 32 — keep parity)                                                 |

Token exchange differs from anthropic — **form-encoded**, not JSON:

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=…&redirect_uri=…&client_id=…&code_verifier=…
```

Response: `{ id_token, access_token, refresh_token }`. There is **no `expires_in`** — `expires_at` must be parsed from the access_token JWT's `exp` claim.

`account_id` (used as `ChatGPT-Account-ID` request header) is read from the `id_token` JWT's `"https://api.openai.com/auth".chatgpt_account_id` claim.

### New file: `src/oauth/jwt.ts`

Tiny util — no dep, no signature verification (we only just received this token and don't need to trust it; we read its claims for header values and expiry):

```ts
export function decodeJwtPayload(jwt: string): Record<string, unknown>
export function jwtExpiresAt(jwt: string): number   // unix seconds
```

Implementation: split on `.`, base64url-decode middle segment, `JSON.parse`. Throw `LibertyError` if the structure is invalid.

### Envelope shape for openai-codex

Conforms to `docs/output-contract.md`:

```json
{
  "provider": "openai-codex",
  "access_token": "<jwt>",
  "refresh_token": "…",
  "expires_at": 1735689600,
  "auth": { "in": "header", "key": "Authorization", "scheme": "Bearer" },
  "authorize_url": "https://auth.openai.com/oauth/authorize",
  "token_url": "https://auth.openai.com/oauth/token",
  "logout_url": null,
  "headers": {
    "ChatGPT-Account-ID": "<from id_token claims>",
    "originator": "codex_cli_rs",
    "User-Agent": "codex_cli_rs/<our-pkg-version>"
  },
  "body": {},
  "extra": {
    "id_token": "<jwt>",
    "api_base": "https://chatgpt.com/backend-api/codex",
    "responses_url": "https://chatgpt.com/backend-api/codex/responses",
    "models_url": "https://chatgpt.com/backend-api/codex/models"
  }
}
```

Rationale:
- `ChatGPT-Account-ID`, `originator`, and a codex-style `User-Agent` are what the upstream backend sees from the real codex CLI; sending them keeps requests indistinguishable.
- `body` is empty because Responses API has no global "must-merge" fields the way anthropic's `system` prompt is mandated. Per-request `model` + `input` is left to the caller.
- `id_token` lives under `extra` (it's not part of the standard envelope, but Responses-API-specific tooling may want it).

### Verify step

Two-stage to actually exercise inference (matches the anthropic pattern and the user's e2e-smoke preference):

1. `GET https://chatgpt.com/backend-api/codex/models?client_version=<our-pkg-version>` — confirms auth + account binding. Pick a small/cheap model id from the response (prefer one matching `/gpt-5.*mini|nano|haiku/i`, fall back to `data[0]`).
2. `POST https://chatgpt.com/backend-api/codex/responses` with:
   ```json
   { "model": "<picked>", "input": "answer in one word, what day comes after Monday?", "stream": false }
   ```
   Assert the response text contains `tuesday` (case-insensitive). Read text from `output_text` if present, else walk `output[].content[].text`.

Headers on both calls: `Authorization: Bearer …`, `ChatGPT-Account-ID: …`, `originator: codex_cli_rs`, `User-Agent: codex_cli_rs/<ver>`, plus `content-type: application/json` on the POST.

If the Responses POST returns 4xx because of body-shape drift, throw a `LibertyError` with the upstream status/body so the user can see what went wrong; iterate the body shape during implementation if needed. `--no-verify` skips this entirely.

### Curl example

`POST /responses` with the same body the verify step uses, model substituted to whatever `verify` picked (or `<model>` if `--no-verify`).

### Reusable plumbing already in tree

- `src/oauth/pkce.ts:8` — `generatePkce()` works as-is (S256, base64url-nopad). Codex uses 64 random bytes for the verifier; anthropic uses 32. Extend `generatePkce(bytes = 32)` to take an optional length, default 32 to keep anthropic untouched.
- `src/oauth/callback-server.ts:30` — `waitForCallback({ port, path })` reusable. **One small refactor:** the `EADDRINUSE` error message at `src/oauth/callback-server.ts:67` is anthropic-specific ("Anthropic's OAuth client has this port hard-coded"). Replace with provider-agnostic wording, e.g. _"Port X is already in use. The provider's OAuth client has this port hard-coded — free it (e.g. `lsof -i :X`) and retry."_
- `src/output.ts` — see Part 2; gets a new clipboard-aware signature both providers use.
- `src/errors.ts` — `LibertyError` reused.

### Wire into dispatcher

`src/cli.ts:35` — add a case for `"openai-codex"` in `dispatch()`; update the "Supported providers" line in the unknown-provider error to include `openai-codex`.

---

## Part 2 — Clipboard support

### New dep

`clipboardy@^4` (ESM, ~6kb, the de-facto cross-platform clipboard module — pbcopy / xsel / xclip / wl-copy / clip.exe shellouts under the hood). Add to `package.json` `dependencies`.

### CLI surface

`src/cli.ts:18-21` — add a third commander option:

```ts
.option("--no-clipboard", "Skip copying the JSON envelope to the system clipboard.")
```

Default = clipboard enabled (commander's `--no-` convention sets `flags.clipboard = true` by default).

`LoginFlags` interface gains `clipboard: boolean`.

Pass `{ clipboard: flags.clipboard }` through to each provider's `emit(...)` call.

### Output contract change

`src/output.ts:22` — `emit()` becomes async and takes a third arg:

```ts
export async function emit(
  creds: ProviderCredentials,
  example: CurlExample | null,
  opts: { clipboard: boolean },
): Promise<void>
```

Behavior:

| `--clipboard` (default) | `--no-clipboard`        |
| ----------------------- | ----------------------- |
| Try `clipboardy.write(JSON.stringify(creds, null, 2))`. On success, prepend a preamble.<br>Layout:<br>`json below is copied to clipboard`<br>`---`<br>`<JSON>`<br>`---` (only if `example`)<br>`<curl>` | Current layout, unchanged.<br>`<JSON>`<br>`---` (only if `example`)<br>`<curl>` |

If `clipboardy.write` throws (Linux without xsel/xclip, headless container, sandboxed shell): write a single-line warning to **stderr** (`Clipboard unavailable: <reason>. Continuing without copying.`), then fall back to the no-clipboard layout. **Never fail the login on a clipboard error** — the token is the user's primary goal.

The token never appears in stderr or any error path (matches the rule in `docs/security.md`). The clipboard write itself is a deliberate, user-visible token egress on par with the existing `--example` curl block.

### Provider call sites

Both `loginAnthropic` and `loginOpenAICodex` switch from `emit(creds, example)` to `await emit(creds, example, { clipboard })`.

---

## Files to create / modify

**New**
- `src/providers/openai-codex.ts`
- `src/oauth/jwt.ts`
- `docs/openai-codex.md` (mirror `docs/anthropic.md` structure: usage, example output, flags, calling notes, operational notes)
- `.changeset/<name>.md` — minor bump, `Add openai-codex provider; copy envelope to clipboard by default (--no-clipboard to opt out)`.

**Modify**
- `src/cli.ts` — dispatcher case + `--no-clipboard` flag + `LoginFlags` shape
- `src/output.ts` — async `emit()` with clipboard handling + preamble
- `src/providers/anthropic.ts` — `LoginOptions` extended with `clipboard`; pass through to `emit`
- `src/oauth/pkce.ts` — `generatePkce(bytes = 32)` parameterized
- `src/oauth/callback-server.ts` — provider-agnostic EADDRINUSE message
- `package.json` — add `clipboardy`
- `docs/output-contract.md` — document clipboard preamble + `--no-clipboard`
- `docs/index.md` — link `docs/openai-codex.md`
- `docs/anthropic.md` — note the `--no-clipboard` flag
- `README.md` — bump "Supported providers" to include OpenAI (Codex / ChatGPT)

---

## Verification

End-to-end (manual; the user's saved feedback prefers real provider calls over unit tests):

1. **Codex happy path**
   ```
   pnpm cli login openai-codex
   ```
   Browser opens → sign in with ChatGPT → terminal shows `✓ Token verified (model: …)` → stdout starts with `json below is copied to clipboard\n---\n`, then the JSON envelope, then `---` and a `curl POST /responses` block. Pasting from the clipboard yields the bare JSON object. Re-running the printed curl returns a one-word "tuesday" response.

2. **`--no-clipboard`**
   ```
   pnpm cli login openai-codex --no-clipboard
   ```
   No preamble, current layout. Clipboard untouched.

3. **`--no-clipboard --no-example`**
   ```
   pnpm cli login openai-codex --no-clipboard --no-example | jq .provider
   ```
   Pipes pure JSON. Output is `"openai-codex"`.

4. **`--no-verify`**
   ```
   pnpm cli login openai-codex --no-verify
   ```
   Skips `/models` + `/responses`; envelope still emitted; curl example uses `<model>` placeholder.

5. **Anthropic regression**
   ```
   pnpm cli login anthropic
   ```
   Identical behavior to today, plus clipboard preamble. `--no-clipboard` reproduces today's exact output byte-for-byte.

6. **Clipboard graceful degradation**
   On a Linux box without xsel/xclip/wl-copy installed: same command succeeds, stderr shows `Clipboard unavailable: …`, stdout falls back to no-preamble layout. Login still exits 0.

7. **Build + typecheck + lint**
   ```
   pnpm build && pnpm typecheck && pnpm lint && node dist/cli.js --help
   ```
   `--help` lists `--no-clipboard`; `dispatch` accepts `openai-codex`.

---

## Open uncertainties (call out during implementation, not now)

- Whether `ChatGPT-Account-ID`, `originator`, and the `codex_cli_rs/<ver>` `User-Agent` are strictly enforced by the chatgpt.com edge or are telemetry-only. Codex always sends them — we will too. If a future error message says otherwise, drop the unneeded one.
- The Responses-API body shape for the verify call. The minimal `{ model, input, stream:false }` is the documented public contract; codex sends a richer payload (`instructions`, `tools`, etc.). If the minimal body is rejected, copy more fields from `codex-rs/codex-api/src/requests/responses.rs`.
