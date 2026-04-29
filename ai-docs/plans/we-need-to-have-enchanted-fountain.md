# Expose `client_id` / `client_secret` in the JSON envelope

## Context

Downstream apps that consume the envelope (e.g. BodhiApp) need to refresh tokens on their own without re-running `llm-liberty login`. Today the envelope gives them `oauth.token_url` and a `refresh_token`, but every provider's refresh request also requires the OAuth client identifiers — which we currently keep hidden inside the provider source files. Apps end up either hardcoding the same hex constants we ship or scraping our source.

By emitting `client_id` (always) and `client_secret` (when the provider has one) inside the envelope's `oauth` block, refresh becomes a self-contained operation against the values we already produce. The literal hex constants stay in `src/providers/<name>.ts` per the CLAUDE.md policy — only the runtime-decoded values flow into the envelope, which is the natural extension of how the values already flow into outbound HTTP requests today.

## Per-provider credential survey

| Provider | `client_id` source | `client_secret` |
|---|---|---|
| `anthropic` | `src/providers/anthropic.ts:12-15` (hex) | none |
| `github-copilot` | `src/providers/github-copilot.ts:13` (hex) | none |
| `google-antigravity` | `src/providers/google-antigravity.ts:14-19` (hex) | `src/providers/google-antigravity.ts:21-24` (hex) |
| `google-gemini` | `src/providers/google-gemini.ts:13-18` (hex) | `src/providers/google-gemini.ts:20-23` (hex) |
| `openai-codex` | `src/providers/openai-codex.ts:14` (base64) | none |

GitHub Copilot's refresh is a non-standard `GET` with the `ghu_…` token in `Authorization` and does **not** consume `client_id`, but we still emit `client_id` for consistency (and because `authorize_url` / device-code flows use it).

## Design decisions (confirmed with user)

- **`client_secret` is omitted from `oauth` when the provider has none** (not `null`). Only the two Google providers will carry the field. Consumers should branch on `'client_secret' in oauth`.
- **`client_id` is always present** as a required string in `oauth`.
- **Envelope `version` stays at `"1.0.0"`** — these additions are folded into the initial schema version rather than minor-bumped.

## Target envelope shape

```jsonc
{
  "version": "1.0.0",
  "provider": "google-gemini",
  "...": "...",
  "oauth": {
    "authorize_url": "...",
    "token_url": "...",
    "revoke_url": "...",
    "client_id": "<decoded value>",
    "client_secret": "<decoded value>"   // only for google-* providers
  }
}
```

## Files to modify

### 1. `src/output.ts`
Extend the `OauthEndpoints` interface (`src/output.ts:15-22`) with:
- `client_id: string`
- `client_secret?: string` (optional — omit when absent)

No change to `emit` or to the `version` constant.

### 2. `src/providers/anthropic.ts`
In the `oauth` object the provider hands back to `emit`, add `client_id: CLIENT_ID`. No `client_secret`.

### 3. `src/providers/github-copilot.ts`
Add `client_id: CLIENT_ID` to the `oauth` block. No `client_secret`.

### 4. `src/providers/google-antigravity.ts`
Add `client_id: CLIENT_ID` and `client_secret: CLIENT_SECRET` to the `oauth` block.

### 5. `src/providers/google-gemini.ts`
Add `client_id: CLIENT_ID` and `client_secret: CLIENT_SECRET` to the `oauth` block.

### 6. `src/providers/openai-codex.ts`
Add `client_id: CLIENT_ID` to the `oauth` block. No `client_secret`.

> Implementation note: each provider already constructs the `oauth` object that flows into `ProviderCredentials`. The change is one or two new keys per file — reuse the existing `CLIENT_ID` / `CLIENT_SECRET` constants directly; do **not** duplicate the hex literals or move them anywhere else (CLAUDE.md policy).

### 7. `docs/output-contract.md`
- Update the example JSON block to include `client_id` (and `client_secret` for the Google example, or add a note that `client_secret` appears only for Google providers).
- Extend the `oauth` field reference (lines 38-42 of the current file) with `client_id` and `client_secret` entries. State that `client_secret` is omitted when the provider does not use one.
- No change to the Stability section or `version` value.

### 8. Per-provider docs (`docs/anthropic.md`, `docs/google-gemini.md`, `docs/google-antigravity.md`, `docs/openai-codex.md`, `docs/github-copilot.md`)
Where the refresh sections currently say things like "client_id is baked into the provider source", reword to point at `oauth.client_id` (and `oauth.client_secret` for Google) in the envelope. Keep the provider-specific request shape (JSON vs form-encoded, GET vs POST) intact. **Do not include the literal hex or decoded values** in the docs — the source file remains the single record per CLAUDE.md.

## Out of scope

- No envelope `version` bump.
- No changes under `src/oauth/` — providers continue to construct their own token exchanges; we are only widening what the envelope reports.
- No new tests beyond the existing smoke flow.

## Verification

1. `pnpm build` — confirm tsup compiles with the new optional field on `OauthEndpoints`.
2. `pnpm lint` and `pnpm typecheck` (or whichever Biome / tsc tasks the repo wires up) — must pass clean.
3. `pnpm test` — existing vitest suite should still pass; the change is additive.
4. End-to-end smoke for at least one provider with a secret and one without:
   - `node dist/cli.js login anthropic --no-clipboard | jq '.oauth | has("client_id"), has("client_secret")'` → expect `true`, `false`.
   - `node dist/cli.js login google-gemini --no-clipboard | jq '.oauth | has("client_id"), has("client_secret")'` → expect `true`, `true`.
   - Use the emitted `oauth.client_id` (+ `client_secret` for Google) plus `refresh_token` to manually `curl` the documented refresh request and confirm a fresh `access_token` comes back. This proves the envelope is now self-sufficient for refresh.
5. Spot-check stdout: `version` is still the first key, `oauth.client_id` follows `revoke_url`, and `client_secret` only appears for the Google providers.
