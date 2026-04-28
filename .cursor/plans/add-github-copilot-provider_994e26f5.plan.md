---
name: add-github-copilot-provider
overview: Add a `login github-copilot` provider that runs GitHub's OAuth device-code flow, exchanges the resulting GitHub App user token for a Copilot session token, auto-detects individual vs enterprise via `proxy-ep`, and verifies end-to-end with a streaming `/chat/completions` round-trip.
todos:
  - id: provider_file
    content: Create `src/providers/github-copilot.ts` with device-code flow, polling, session-token exchange, proxy-ep resolution, streaming SSE verify, and curl-example builder.
    status: completed
  - id: wire_cli
    content: Wire `github-copilot` into `src/cli.ts` dispatcher and unknown-provider error message.
    status: completed
  - id: user_docs
    content: Add `docs/github-copilot.md`; link from `docs/index.md` and add to `README.md` (drop the "more coming" parenthetical).
    status: completed
  - id: changeset
    content: Add a minor-bump changeset describing the new `github-copilot` provider.
    status: completed
  - id: validate
    content: Run `pnpm typecheck` + `pnpm lint` + `pnpm test`; smoke-test `pnpm cli login github-copilot` (and `--no-verify` / `--no-example --no-clipboard` variants) against a real Copilot account.
    status: completed
isProject: false
---

# Add GitHub Copilot provider

## Background

GitHub Copilot's auth pipeline is unlike the other three providers we already support: there is **no localhost callback** (it's an OAuth 2.0 *device* flow, not authorization-code) and the OAuth token exchange yields a **`ghu_*` GitHub App user token** which is itself swapped for a short-lived **`tid=...` Copilot session token** before any chat request will succeed. Both tokens are needed at runtime, so we map them onto our standard envelope as:

- `access_token` → session token (~30 min, paste-and-curl ready)
- `refresh_token` → `ghu_*` token (long-lived; refresh = `GET token_url` with `Authorization: Bearer <ghu>`, *not* the standard `grant_type=refresh_token`)

Copilot Enterprise tokens additionally carry a `proxy-ep=<host>` segment; requests must go to that proxy host (with `proxy.* → api.*` swap) and **must use `stream: true`** on `/chat/completions`. Per the user's choice, we always stream — single SSE-parsing code path for both individual and enterprise.

References
- sitegeist [`src/oauth/github-copilot.ts`](../../badlogic/sitegeist/src/oauth/github-copilot.ts) (device flow + session-token exchange we're cloning)
- Issue [`anomalyco/opencode#19338`](https://github.com/anomalyco/opencode/issues/19338) (proves session-token exchange is required for preview models, and `Editor-Version` / `Editor-Plugin-Version` / `Copilot-Integration-Id` are mandatory)
- Issue [`moltis-org/moltis#352`](https://github.com/moltis-org/moltis/issues/352) (proves enterprise needs `stream: true`; `proxy-ep` field shape)
- [`CLAUDE.md`](CLAUDE.md) `client_id` policy (base64-inline; single source of truth)

## Files

### New: [src/providers/github-copilot.ts](src/providers/github-copilot.ts)

`loginGitHubCopilot({ verify, example, clipboard }: LoginOptions): Promise<void>`. Mirrors the structural conventions of [src/providers/anthropic.ts](src/providers/anthropic.ts) and [src/providers/google-gemini.ts](src/providers/google-gemini.ts) but **does not** import `pkce.ts` or `callback-server.ts` (no PKCE, no localhost callback in device flow).

Constants:
- `CLIENT_ID` = `Buffer.from("SXYxLmI1MDdhMDhjODdlY2ZlOTg=", "base64").toString()` (resolves to the GitHub App id used by every official Copilot client; base64-inline per CLAUDE.md policy)
- `DEVICE_CODE_URL` = `"https://github.com/login/device/code"`
- `ACCESS_TOKEN_URL` = `"https://github.com/login/oauth/access_token"`
- `SESSION_TOKEN_URL` = `"https://api.github.com/copilot_internal/v2/token"`
- `DEFAULT_API_BASE` = `"https://api.individual.githubcopilot.com"`
- `SCOPE` = `"read:user"`
- `VERIFY_MODEL` = `"gpt-4o-mini"` (cheap, broadly available; fallback to the first model returned by `/models` if not present)
- `VERIFY_PROMPT` = `"answer in one word, what day comes after Monday?"` (matches anthropic/gemini)
- `COPILOT_HEADERS` = `{ "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" }` (mirrors sitegeist; verified to satisfy preview-model auth check per opencode#19338)
- `DEVICE_FLOW_USER_AGENT` = `"GitHubCopilotChat/0.35.0"` (used on the two GitHub.com endpoints)

Flow:
1. **Device code request.** `POST DEVICE_CODE_URL` with `application/x-www-form-urlencoded` body `client_id=…&scope=read:user`. Validate response shape `{ device_code, user_code, verification_uri, interval, expires_in }`.
2. **Display + open.** Use `note(\`${user_code}\\n${verification_uri}\`, "Enter this code in your browser")` from `@clack/prompts` (writes to stderr — stdout stays JSON-clean). Best-effort `open(verification_uri)`. Do **not** auto-copy the user code to the clipboard — that would clobber the post-success envelope copy users already expect; the `note` boxed display is enough, and we tell users to type the code in.
3. **Poll for access token.** `POST ACCESS_TOKEN_URL` every `interval` seconds (`Math.max(1000, interval*1000)` to clamp pathological values), body `client_id=…&device_code=…&grant_type=urn:ietf:params:oauth:grant-type:device_code`, `Accept: application/json`. Handle:
   - `data.access_token` present → return.
   - `data.error === "authorization_pending"` → continue.
   - `data.error === "slow_down"` → bump interval per the spec.
   - any other `data.error` → throw `LibertyError`.
   - `Date.now() > deadline` (deadline = start + `expires_in*1000`) → throw "device code expired, re-run login".
4. **Session-token exchange.** `GET SESSION_TOKEN_URL` with `Authorization: Bearer <gh_token>`, `Accept: application/json`, `...COPILOT_HEADERS`. Response shape: `{ token: "tid=…;exp=…;proxy-ep=…;…", expires_at: <unix-seconds-or-string> }`. Defensively parse `expires_at` as either number or string; treat as seconds (no `*1000`) since envelope `expires_at` is already in seconds (per [docs/output-contract.md](docs/output-contract.md)).
5. **Resolve API base.** Regex the session token `/(?:^|;)\s*proxy-ep=([^;\s]+)/i`. If present, `apiBase = "https://" + proxyHost.replace(/^proxy\./, "api.")`; else `DEFAULT_API_BASE`. Track `isEnterprise = !!proxyEp`.
6. **Build envelope** (see shape below).
7. **Verify (always streaming).** When `opts.verify`:
   - `GET ${apiBase}/models` with `Authorization: Bearer <session_token>` + `COPILOT_HEADERS` to confirm auth + pick a model.
   - Choose `gpt-4o-mini` if listed; else first id matching `/mini/i`; else first model in the list. Throw if zero.
   - `POST ${apiBase}/chat/completions` with `stream: true` body, parse SSE: read `res.body` as `AsyncIterable<Uint8Array>`, buffer-by-newline, accumulate `choices[0].delta.content` from each `data: {…}` line, halt on `data: [DONE]`. Assert `/tuesday/i` against the accumulated text.
8. **Emit.** `buildCurlExample(creds, model)` produces a streaming POST to `/chat/completions` (since envelope's `body.stream === true`); pass to `emit()`.

SSE reader (private helper, ~25 lines) inlined in the same file — no new module needed:

```ts
async function readSseContent(res: Response): Promise<string> {
  if (!res.body) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return out;
      try {
        const obj = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string") out += delta;
      } catch {
        // ignore non-JSON keep-alives
      }
    }
  }
  return out;
}
```

Envelope shape:

```ts
{
  provider: "github-copilot",
  access_token: sessionToken,                    // tid=…;exp=…;proxy-ep=…
  refresh_token: githubAccessToken,              // ghu_…
  expires_at: parsedExpiresAtSeconds,            // unix seconds
  auth: { in: "header", key: "Authorization", scheme: "Bearer" },
  authorize_url: DEVICE_CODE_URL,                // closest analogue
  token_url: SESSION_TOKEN_URL,                  // GET this with Bearer <refresh_token> to mint a new access_token
  logout_url: null,
  headers: { ...COPILOT_HEADERS },
  body: { stream: true },                        // single SSE code path; user merges in `model` + `messages`
  extra: {
    github_token: githubAccessToken,             // explicit alias for refresh_token
    api_base: apiBase,
    models_url: `${apiBase}/models`,
    chat_completions_url: `${apiBase}/chat/completions`,
    is_enterprise: isEnterprise,
    session_token_url: SESSION_TOKEN_URL,        // explicit, in case future envelope readers don't conflate token_url with this
  },
}
```

### Edit: [src/cli.ts](src/cli.ts)

Add the import and a `case "github-copilot"` branch, update the unknown-provider error to list `github-copilot`. The current dispatcher block is:

```37:67:src/cli.ts
async function dispatch(provider: string, flags: LoginFlags): Promise<void> {
  switch (provider) {
    case "anthropic":
      …
    case "openai-codex":
      …
    case "google-gemini":
      …
    default:
      throw new LibertyError(
        `Unknown provider: ${provider}. Supported providers: anthropic, openai-codex, google-gemini.`,
      );
  }
}
```

→ add `case "github-copilot": await loginGitHubCopilot({...flags}); return;` and append `, github-copilot` to the error message.

### New: [docs/github-copilot.md](docs/github-copilot.md)

Mirrors [docs/anthropic.md](docs/anthropic.md) and [docs/google-gemini.md](docs/google-gemini.md). Sections:

- Header + `npx llm-liberty@latest login github-copilot` invocation.
- **Why it's different from the others** — one paragraph explaining the device-code UX (user_code typed in browser, no localhost callback) and the two-token model (`access_token` = short-lived session, `refresh_token` = long-lived `ghu_`).
- **Example output** — full envelope + curl block (with `stream: true` so the curl example actually works on enterprise tokens too).
- **Flags** — `--no-verify` / `--no-example` / `--no-clipboard`, identical semantics.
- **Calling the API** — required headers, that `model` + `messages` are merged into `body`, that `stream: true` is mandatory for enterprise and harmless for individual.
- **Refresh** — explicit `GET token_url` with `Authorization: Bearer <refresh_token>` + `Editor-Version` / `Editor-Plugin-Version` / `Copilot-Integration-Id`. Calls out that this is **not** the standard `grant_type=refresh_token` flow, since envelope readers might assume it is.
- **Operational notes** — that no port needs to be free (no callback server), Copilot subscription required (Free/Pro/Business/Enterprise), enterprise → `proxy-ep` auto-routing, `expires_at` semantics (~30 min), and the device-code expiry window (~15 min before the user must re-run login).

### Edit: [docs/index.md](docs/index.md)

Add a bullet under the google-gemini one:

```md
- [**github-copilot.md**](github-copilot.md) — `login github-copilot`: GitHub Copilot.
```

### Edit: [README.md](README.md)

Replace the existing supported-providers block:

```5:9:README.md
- **Anthropic** (Claude / Claude Code) — see [`docs/anthropic.md`](docs/anthropic.md)
- **OpenAI Codex** (ChatGPT / Codex CLI) — see [`docs/openai-codex.md`](docs/openai-codex.md)
- **Google Gemini** (gemini-cli / Code Assist) — see [`docs/google-gemini.md`](docs/google-gemini.md)

_(More coming — GitHub Copilot.)_
```

→ add `- **GitHub Copilot** — see [`docs/github-copilot.md`](docs/github-copilot.md)` and drop the parenthetical entirely (no more "more coming" since this completes the four providers in CLAUDE.md's tagline).

### New: `.changeset/<auto>-github-copilot-provider.md`

Minor bump:

```md
---
"llm-liberty": minor
---

Add `login github-copilot` provider — runs GitHub's OAuth device-code flow, exchanges the resulting GitHub App user token for a Copilot session token, auto-detects individual vs enterprise via `proxy-ep`, and emits the standard JSON envelope plus a working streaming curl for `/chat/completions`.
```

## Flow diagram

```mermaid
sequenceDiagram
  autonumber
  participant CLI as llm-liberty
  participant Browser
  participant GH as github.com
  participant API as api.github.com
  participant Copilot as api.individual.githubcopilot.com / proxy.<tenant>

  CLI->>GH: POST /login/device/code (client_id, scope=read:user)
  GH-->>CLI: device_code, user_code, verification_uri, interval, expires_in
  CLI->>Browser: open(verification_uri); print user_code via @clack note
  Browser->>GH: user signs in + types user_code + authorizes
  loop every `interval`s, until expires_in
    CLI->>GH: POST /login/oauth/access_token (device_code)
    alt authorization_pending
      GH-->>CLI: { error: "authorization_pending" }
    else slow_down
      GH-->>CLI: { error: "slow_down", interval: N }
    else success
      GH-->>CLI: { access_token: ghu_… }
    end
  end
  CLI->>API: GET /copilot_internal/v2/token (Bearer ghu_…)
  API-->>CLI: { token: "tid=…;proxy-ep=…", expires_at }
  CLI->>CLI: parse proxy-ep -> resolve apiBase
  opt --verify
    CLI->>Copilot: GET {apiBase}/models (Bearer tid=…)
    Copilot-->>CLI: model list
    CLI->>Copilot: POST {apiBase}/chat/completions (stream:true, "what day comes after Monday?")
    Copilot-->>CLI: SSE chunks (data: {...delta.content})
    CLI->>CLI: assert accumulated text matches /tuesday/i
  end
  CLI->>CLI: emit JSON envelope (+ optional streaming curl)
```

## Validation

1. `pnpm typecheck && pnpm lint` clean.
2. Manual: `pnpm cli login github-copilot` against a real Copilot subscription → JSON envelope + streaming curl printed; copy-paste curl actually returns SSE.
3. `pnpm cli login github-copilot --no-verify` skips only the SSE round-trip (device flow + session exchange still run, since both produce the credential).
4. `pnpm cli login github-copilot --no-example --no-clipboard` produces parseable JSON on stdout, nothing else.
5. If the user is on Copilot Enterprise (`proxy-ep` present), the printed `extra.api_base` should be `https://api.<tenant>.githubcopilot.com` and `extra.is_enterprise` should be `true`.

## Out of scope

- No GitHub Enterprise Server (self-hosted GHES) hostnames — only `github.com` + `api.github.com`. We can add `--enterprise <hostname>` later if needed.
- No model auto-discovery beyond a small fallback list — users wanting other Copilot models edit the `model` field in the curl body. The envelope's `extra.models_url` already tells them where to look.
- No automatic session-token refresh inside this CLI — same posture as our other providers (refresh is documented for users to perform themselves).
- No SAML SSO automation — covered by GitHub's own consent screen on the verification page.