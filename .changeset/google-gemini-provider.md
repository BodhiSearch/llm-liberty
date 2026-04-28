---
"@bodhiapp/llm-liberty": minor
---

Add `login google-gemini` provider — runs the gemini-cli OAuth flow, discovers the user's Code Assist project via `loadCodeAssist`/`onboardUser`, and emits the standard JSON envelope plus a working curl for `cloudcode-pa.googleapis.com/v1internal:generateContent`.
