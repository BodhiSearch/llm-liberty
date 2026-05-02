---
"@bodhiapp/llm-liberty": minor
---

Switch `google-gemini` envelope to fully impersonate the upstream `@google/gemini-cli` binary on the wire so downstream callers (BodhiApp, etc.) reusing the envelope produce requests indistinguishable from a fresh `gemini-cli` invocation.

- **Headers** (single set used for both discovery and inference): `User-Agent` is now `GeminiCLI/<version> (<platform>; <arch>)` and `X-Goog-Api-Client: gl-node/22.17.0` is preserved. Drops the `Client-Metadata` JSON header — verified that real `gemini-cli` does not send it via `@google/gemini-cli-core/src/code_assist/server.js`.
- **Body**: replaces the fabricated top-level `userAgent` and `requestId` fields with `user_prompt_id` (snake_case random hex), matching `@google/gemini-cli-core/src/code_assist/converter.js` and `@google/gemini-cli/src/gemini.js`.
- `extra.body_uuid_keys` updated from `["requestId"]` to `["user_prompt_id"]`.

Verify continues to use `gemini-2.5-flash-lite` — the most generous free-tier bucket for a single one-shot verification call.

OAuth flow, project discovery, token shape, and refresh/revoke endpoints are unchanged. Envelope consumers only need to update body field names.
