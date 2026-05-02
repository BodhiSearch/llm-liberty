# Align `google-gemini` with real gemini-cli wire protocol

## Context

`src/providers/google-gemini.ts` currently advertises an envelope that mixes
two identities: pi-mono's headers (`User-Agent: google-cloud-sdk
vscode_cloudshelleditor/0.1` + a `Client-Metadata` JSON header) and made-up
body fields (`userAgent: "bodhi-app"`, `requestId: <UUID>`). Sitegeist itself
inherits these from pi-mono — but neither matches what the upstream
`@google/gemini-cli` binary actually puts on the wire.

The user wants llm-liberty to *fully impersonate* gemini-cli so that
downstream callers (BodhiApp, etc.) reusing the envelope make requests that
are byte-for-byte indistinguishable from a fresh `gemini-cli` invocation.
The OAuth flow itself is already aligned with sitegeist (same client_id /
secret / scopes / port 8085 callback / loadCodeAssist + onboardUser
discovery) — only the headers and body identifiers need to change.

### What real gemini-cli sends (verified from local install)

Source: `@google/gemini-cli-core` v0.x at
`/opt/homebrew/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/`

**HTTP headers** (`src/core/contentGenerator.js:50-53` + google-auth-library
defaults inherited by `CodeAssistServer.requestPost`):

```
User-Agent: GeminiCLI/<version> (<platform>; <arch>)   # e.g. GeminiCLI/0.13.0 (darwin; arm64)
X-Goog-Api-Client: gl-node/<nodeVersion>               # auth-library default
Content-Type: application/json
Authorization: Bearer <token>
```

No `Client-Metadata` header. The same headers are used for discovery
(`loadCodeAssist`, `onboardUser`, LRO poll) and inference
(`streamGenerateContent`, `generateContent`).

**Body shape** for `streamGenerateContent` / `generateContent`
(`src/code_assist/converter.js:20-48`):

```json
{
  "model": "<model>",
  "project": "<projectId>",
  "user_prompt_id": "<random hex>",
  "request": {
    "contents": [...],
    "systemInstruction": {...},
    "tools": [...],
    "toolConfig": {...},
    "generationConfig": {...},
    "session_id": "<uuid>"
  }
}
```

`user_prompt_id` is generated as `Math.random().toString(16).slice(2)` for
non-interactive runs (`src/gemini.js:235`) and as
`<sessionId>########<count>` for interactive turns
(`src/ui/hooks/useGeminiStream.js:410`). Both are snake_case at the wire
level.

## Recommended approach

**Single-file change**: rewrite the header / body sections of
`src/providers/google-gemini.ts` to match real gemini-cli, and update the
companion changeset + provider doc. No new files, no framework changes.

### 1. HTTP headers — single identity for discovery + inference

Replace the two-header-set design (`OAUTH_HEADERS` for discovery,
`INFERENCE_HEADERS` for inference) with a single `GEMINI_CLI_HEADERS` used
everywhere:

```ts
const GEMINI_CLI_VERSION = "0.13.0"; // pin; bump when upstream releases
const GEMINI_CLI_HEADERS: Record<string, string> = {
  "User-Agent": `GeminiCLI/${GEMINI_CLI_VERSION} (${process.platform}; ${process.arch})`,
  "X-Goog-Api-Client": "gl-node/22.17.0",
};
```

Drop:
- `Client-Metadata` header (gemini-cli does not send it)
- The split between `OAUTH_HEADERS` and `INFERENCE_HEADERS`
- The `LOAD_METADATA` constant stays (it's a body field for loadCodeAssist /
  onboardUser, not a header)

### 2. Body identifiers — real gemini-cli fields

In `buildEnvelope` (`src/providers/google-gemini.ts:255-295`), replace the
top-level `userAgent`/`requestId` fields with `user_prompt_id`:

```ts
body: {
  project: projectId,
  // Mirrors gemini-cli's non-interactive prompt id
  // (src/gemini.js:235: Math.random().toString(16).slice(2)).
  // Placeholder for the curl example; BodhiApp regenerates per call
  // because extra.body_uuid_keys lists it.
  user_prompt_id: randomHex(),
},
```

Add a small helper near the top of the file:

```ts
function randomHex(): string {
  return Math.random().toString(16).slice(2);
}
```

Keep `randomUUID` import only if used elsewhere; otherwise drop it.

Update `extra.body_uuid_keys` → `["user_prompt_id"]` so BodhiApp regenerates
it per outbound request.

### 3. Verify + curl example — match new shape

`verifyToken` (lines 297-338) and `buildCurlExample` (lines 340-359) both
embed a sample inference body. Update both to:

```ts
{
  model: VERIFY_MODEL,
  project: projectId,
  user_prompt_id: randomHex(),
  request: {
    contents: [{ role: "user", parts: [{ text: VERIFY_PROMPT }] }],
  },
}
```

(Drop `userAgent: "bodhi-app"` and `requestId: randomUUID()`.)

The verify call should keep the same `:generateContent` URL and the same
single-call free-tier-quota strategy already documented inline.

### 4. Discovery still uses the same headers

`discoverProject` (lines 191-253) currently builds headers as
`{ Authorization, content-type, ...OAUTH_HEADERS }`. After the rename it
becomes `{ Authorization, content-type, ...GEMINI_CLI_HEADERS }` — no
behavioural change other than the User-Agent string moving from
`google-api-nodejs-client/9.15.1` to `GeminiCLI/0.13.0 (darwin; arm64)`.

Real gemini-cli uses these same headers for loadCodeAssist / onboardUser
(verified at `code_assist/server.js:54-67` — `requestPost` spreads
`httpOptions.headers` which contains only the GeminiCLI User-Agent).

### 5. Changeset & docs

**`.changeset/google-gemini-cli-headers.md`** — rewrite to describe the
new direction:

```
"@bodhiapp/llm-liberty": minor

Switch `google-gemini` envelope to fully impersonate the upstream
@google/gemini-cli binary on the wire:

- Headers: User-Agent now "GeminiCLI/<ver> (<platform>; <arch>)" and
  X-Goog-Api-Client preserved. Drops Client-Metadata header (gemini-cli
  does not send it).
- Body: replaces fabricated `userAgent`/`requestId` fields with
  gemini-cli's actual `user_prompt_id` (random hex, top-level).
- extra.body_uuid_keys updated to ["user_prompt_id"].

Same OAuth flow / project discovery / token shape — envelope consumers
need only update the body field names.
```

**`docs/google-gemini.md`** — update the headers table and request-body
example to reflect the new shape. Specifically the section at lines 88-93
that documents the required headers, and any body example that still
references `userAgent` / `requestId`.

### Files to modify

| File | Why |
|------|-----|
| `src/providers/google-gemini.ts` | All header + body changes |
| `.changeset/google-gemini-cli-headers.md` | Describe the new direction |
| `docs/google-gemini.md` | User-facing doc must match new envelope |

No other files (`src/cli.ts`, `src/output.ts`, `src/oauth/*`, other
providers) need changes — the framework already supports everything.

### Existing utilities reused

- `generatePkce()` from `src/oauth/pkce.ts:8` — unchanged
- `runRedirectFlow()` from `src/oauth/redirect-flow.ts:20` — unchanged
- `base64urlRandom()` / `sleep()` from `src/oauth/util.ts` — unchanged
- `BEARER_AUTH`, `emit()`, `LoginOptions`, `ProviderCredentials`,
  `CurlExample` from `src/output.ts` — unchanged

## Verification

1. **Type check / build**: `pnpm tsc --noEmit` and `pnpm build` (tsup) — no
   new types, no API changes outside the one provider.
2. **Smoke test the OAuth flow** (per the `feedback_testing.md` memory:
   real e2e over unit tests):
   ```
   pnpm dev login google-gemini --example
   ```
   Confirm:
   - Browser opens to `accounts.google.com/o/oauth2/v2/auth?...`
   - After consent, project discovery succeeds (loadCodeAssist or onboard
     LRO poll).
   - `--verify` makes a `:generateContent` call with the new body and
     headers, gets a response mentioning "tuesday", and the spinner shows
     `✓ Token verified`.
   - The emitted JSON envelope shows `headers["User-Agent"]` of the form
     `GeminiCLI/0.13.0 (darwin; arm64)` and `body.user_prompt_id` is a
     hex string.
   - The `--example` curl block compiles and, when copy-pasted with a
     fresh `user_prompt_id`, returns 200 from `:generateContent`.
3. **Wire-trace sanity check** (optional but recommended): run the real
   `gemini` CLI with `NODE_DEBUG=http` and compare the request line +
   headers + body shape against an llm-liberty `--verify` run captured the
   same way. The two should differ only in `user_prompt_id` value and
   `Authorization` token.

## Open follow-up

The pinned `GEMINI_CLI_VERSION = "0.13.0"` will drift from upstream over
time. If/when Google rejects requests for stale User-Agent strings, bump
the constant. A small future task could fetch the version from npm
registry at build time, but that's out of scope here — pin is fine.
