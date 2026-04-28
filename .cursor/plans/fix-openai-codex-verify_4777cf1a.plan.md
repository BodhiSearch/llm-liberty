---
name: fix-openai-codex-verify
overview: Fix `login openai-codex` verification by sending a Codex-shaped request to `/backend-api/codex/responses` (required `instructions`, array-form `input`, `store:false`, `stream:true`) and parsing the SSE response. Bake the API-required defaults into the envelope's `body` so downstream callers don't have to relearn them.
todos:
  - id: fix-verify-and-envelope
    content: "Update src/providers/openai-codex.ts: add SYSTEM_PROMPT, populate envelope body with required defaults, rewrite verifyToken to send Codex-shaped payload and parse SSE, regenerate curl example."
    status: completed
  - id: update-docs
    content: "Update docs/openai-codex.md: refreshed envelope example, SSE curl block, rewritten 'Calling the API' section explaining array input + SSE."
    status: completed
  - id: smoke-test
    content: Re-run `npm run cli login openai-codex` and confirm verification succeeds end-to-end.
    status: completed
isProject: false
---

# Fix `login openai-codex` verification

## Root cause

`verifyToken` in [src/providers/openai-codex.ts](src/providers/openai-codex.ts) sends a payload shaped for the public OpenAI Responses API:

```215:219:src/providers/openai-codex.ts
  const responsesRes = await fetch(`${API_BASE}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model, input: VERIFY_PROMPT, stream: false }),
  });
```

But `https://chatgpt.com/backend-api/codex/responses` with subscription OAuth requires:

- `instructions`: non-empty string — **missing today, hence the 400 "Instructions are required"**
- `input`: array of message objects (`{ type: "message", role, content: [{ type: "input_text", text }] }`)
- `store: false`
- `stream: true` (SSE only)
- Client must consume SSE (`response.output_text.delta` … `response.completed`)

Cross-referenced sources:
- `openai/codex` — `codex-rs/core/src/client.rs:871-893` (canonical request shape)
- `openclaw/openclaw` Issue #67740 (`store:true`/`stream:false` mismatch documents the same 400)
- `badlogic/pi-mono` Issue #1828 (header conventions: `originator`, UA, `ChatGPT-Account-ID` PascalCase)
- [`nanobot`](https://mintlify.com/HKUDS/nanobot/advanced/oauth-providers) — Python production library; sends `OpenAI-Beta: responses=experimental` + `accept: text/event-stream`
- [`langchainjs-codex-oauth`](https://www.npmjs.com/package/langchainjs-codex-oauth) — Node/TS library doing the same OAuth flow (PKCE, `localhost:1455/auth/callback`)
- [Ben Vargas minimal gist](https://gist.github.com/ben-vargas/1ce34c877c077527bde1f75a270359ff) — confirms array `input` + `store:false` + `stream:true`
- [InnomightLabs write-up](https://www.bemyaficionado.com/openai-oauth-chatgpt-codex-integration-in-innomightlabs/) — explicit "instructions must be present, store false, stream true"

OAuth/token-exchange/header parts (originator, UA, ChatGPT-Account-ID) are already correct.

## Changes

### 1. [src/providers/openai-codex.ts](src/providers/openai-codex.ts)

- Add `SYSTEM_PROMPT = "You are Codex, OpenAI's coding agent."` — minimal Codex-flavored, non-empty (Ben Vargas's gist uses `""` but our reproducer's 400 explicitly says "Instructions are required", so we play it safe with a non-empty value matching the rest of the ecosystem).
- Add `OpenAI-Beta: responses=experimental` to the envelope `headers` (carried verbatim into every downstream call, mirroring `nanobot`'s production header set; defends against clusters still gating Responses behind the beta opt-in).
- `buildEnvelope`: change `body: {}` to the API-mandatory defaults so downstream callers can merge them with their `model` + `input` and the request just works:
  ```ts
  body: {
    instructions: SYSTEM_PROMPT,
    store: false,
    stream: true,
  }
  ```
- `verifyToken`: rewrite the `/responses` call to:
  - Send `Accept: text/event-stream` plus the existing auth/identity headers (note: `Accept` is request-shape-specific, so it's added at the call site, not embedded in `creds.headers`).
  - Request body = `{ ...creds.body, model, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: VERIFY_PROMPT }] }] }`.
  - Read `await res.text()` (response is short), then parse SSE: split on `\n\n`, for each `event: <name>\n` + `data: <json>` block, accumulate `response.output_text.delta` `delta` strings, stop at `response.completed` or `response.failed`. Reuse the existing `/tuesday/i.test(text)` assertion.
  - Drop `ResponsesOutput` interface; replace with a tiny SSE parser (helper `extractSseText(rawSse: string): string`).
- `buildCurlExample`: regenerate to match the new shape — `instructions` + array `input` + `store:false` + `stream:true`, and include `Accept: text/event-stream` in headers. Inline the merged body so the example is copy-pasteable.

### 2. [docs/openai-codex.md](docs/openai-codex.md)

- Update the example envelope so `headers` includes `OpenAI-Beta: responses=experimental` and `body` shows the three required defaults.
- Replace the curl block with the SSE-shaped POST (array `input`, `instructions`, `store:false`, `stream:true`, `Accept: text/event-stream`).
- Rewrite the "Calling the API" section to spell out:
  - Subscription OAuth is SSE-only; client must parse `response.output_text.delta` / `response.completed`.
  - `input` is an array of message objects, not a plain string.
  - `body` defaults must be merged into every request.
  - `OpenAI-Beta: responses=experimental` is forwarded verbatim from `headers`.

## Out of scope

- No changes to [src/cli.ts](src/cli.ts), [src/output.ts](src/output.ts), [src/oauth/](src/oauth), or [src/oauth/jwt.ts](src/oauth/jwt.ts) — OAuth + token exchange + envelope plumbing are already correct.
- No new dependencies; SSE parsing is a few lines of string handling on the already-fetched body.
- No changelog/changeset entry unless you ask for one.

## Verification

After the change, re-run `npm run cli login openai-codex`. Expected stderr: `✓ Token verified (model: <id>)`. Expected stdout: JSON envelope with `body.instructions`/`body.store`/`body.stream`, followed by an SSE-flavored curl example.