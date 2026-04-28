---
"llm-liberty": minor
---

Add `login anthropic` — runs the Claude Code OAuth flow, prints the access/refresh tokens plus all required headers and body fields as JSON, and (by default) verifies the token end-to-end against Anthropic's API and emits a copy-pasteable `curl` snippet. Skip checks with `--no-verify` and `--no-example`.
