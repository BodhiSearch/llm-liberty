# Security posture

`llm-liberty` runs the documented OAuth flow of each provider's official CLI on the user's behalf and prints the resulting credentials. The user authenticates with their own provider account; the tokens belong to them. Our job is to extract them safely and get out of the way.

## Token handling

- **Never log tokens.** Tokens reach the user only via stdout — in the JSON envelope and (by design) in the `--example` curl block. They appear nowhere else: no log files, no error messages, no telemetry.
- **Don't persist tokens to disk by default.** The CLI does not cache, store, or write tokens anywhere. If we add caching later, it will be opt-in via an explicit flag with the file path documented.
- **Treat tokens as secrets in error paths.** Any code that touches a token must be careful not to leak it through exception messages, stack traces, or debug output. Redact before printing or reporting.

## Be explicit about what the tool does

- `--help` and the README describe the tool plainly: it runs the provider's documented OAuth flow on the user's behalf and prints the resulting credentials.
- The OAuth handshake happens in the user's own browser session against the provider's real authorize URL — we don't proxy or intercept it.

## What this tool is not

- Not a way to bypass a provider's terms — the user is authenticating with their own account and using the resulting tokens within whatever the provider's policy allows.
- Not a credential vault — see "Don't persist tokens" above. Pipe the JSON output into your own secret store.
