---
"@bodhiapp/llm-liberty": minor
---

Add `login github-copilot` provider — runs GitHub's OAuth device-code flow, exchanges the resulting GitHub App user token for a Copilot session token via `/copilot_internal/v2/token`, auto-detects individual vs Copilot Enterprise via the `proxy-ep` segment, and emits the standard JSON envelope plus a working streaming `curl` for `/chat/completions`.
