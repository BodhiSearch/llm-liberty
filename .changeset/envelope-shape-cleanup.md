---
"@bodhiapp/llm-liberty": minor
---

Restructure the JSON envelope for clarity and consistency across providers:

- Group OAuth lifecycle fields under `oauth` (`authorize_url`, `token_url`, `revoke_url`).
- Group API endpoints under `api` (`base_url`, `chat_url`, `models_url`) — every provider now exposes the same canonical chat/models URLs at the top level instead of the previous mix of `extra.api_base` / `extra.responses_url` / `extra.generate_content_url` / `extra.chat_completions_url`.
- Replace the always-`null` `logout_url` with `revoke_url` (RFC 7009 token-revocation endpoint), populated for `google-gemini` (`https://oauth2.googleapis.com/revoke`) and `null` elsewhere where no user-callable revoke endpoint is exposed.
- Drop duplicated fields from `extra`: `google-gemini.extra.project_id` (use `body.project`), `github-copilot.extra.github_token` (use `refresh_token`), `github-copilot.extra.session_token_url` (use `oauth.token_url`).

Internal cleanup:

- Extract the redirect-flow boilerplate (PKCE → open browser → wait callback → validate state) into `src/oauth/redirect-flow.ts`, removing ~80 lines of duplication across the three redirect-based providers.
- Move `LoginOptions` and a shared `BEARER_AUTH` constant into `src/output.ts`.
- Add `src/oauth/util.ts` for shared `base64urlRandom` and `sleep` helpers.
- Replace the hand-written `dispatch` switch in `src/cli.ts` with a registry.
- Add unit tests for `renderCurl`, JWT decoding, and PKCE generation.
