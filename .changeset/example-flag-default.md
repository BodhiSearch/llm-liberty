---
"llm-liberty": minor
---

Flip the `curl` example from opt-out to opt-in. The default `login` output is now just the JSON envelope (plus the clipboard preamble when applicable). Pass the new `--example` flag to additionally print the `---` separator and a copy-pasteable `curl`. The legacy `--no-example` flag is removed; if you were already passing it, simply drop it.
