---
"llm-liberty": minor
---

Add `login google-antigravity` provider — runs the Antigravity IDE OAuth flow, discovers the user's Code Assist project via `loadCodeAssist`/`onboardUser`, and emits the standard JSON envelope plus a working curl for the unified gateway at `cloudcode-pa.googleapis.com/v1internal:generateContent` (Gemini + Claude + GPT-OSS via a single Gemini-style request shape). Also tightens `--verify` model selection across providers so it picks the cheapest available model — `nano > mini > haiku` for openai-codex, `nano > mini` for github-copilot, and `gemini-2.5-flash-lite` for google-gemini.
