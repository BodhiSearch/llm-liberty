---
"llm-liberty": minor
---

Switch `google-gemini` envelope from the OAuth-library identity to the gemini-cli inference identity (matches what the official `gemini-cli` and the gemini-code-assist VS Code extension send on the wire). Adds `Client-Metadata: {"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}` and switches `User-Agent` to `google-cloud-sdk vscode_cloudshelleditor/0.1`. Adds top-level `userAgent: "bodhi-app"` and a per-envelope `requestId` to the request body, and `extra.stream_headers: { Accept: "text/event-stream" }` for streaming. Without this change Google's `cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` routes calls into a strict rate-limit bucket and 429s after a handful of requests. The `loadCodeAssist`/`onboardUser` discovery step continues to use the OAuth-library identity (correct for those endpoints).
