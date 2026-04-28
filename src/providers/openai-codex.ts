import { randomBytes } from "node:crypto";
import { spinner } from "@clack/prompts";
import open from "open";
import { LibertyError } from "../errors.js";
import { waitForCallback } from "../oauth/callback-server.js";
import { decodeJwtPayload, jwtExpiresAt } from "../oauth/jwt.js";
import { generatePkce } from "../oauth/pkce.js";
import { type CurlExample, emit, type ProviderCredentials } from "../output.js";

const CLIENT_ID = Buffer.from(
  "6170705f454d6f616d45455a37336630436b58615870376872616e6e",
  "hex",
).toString();

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const API_BASE = "https://chatgpt.com/backend-api/codex";
const PKG_VERSION = "0.0.1";
const ORIGINATOR = "codex_cli_rs";
const USER_AGENT = `${ORIGINATOR}/${PKG_VERSION}`;
const OPENAI_BETA = "responses=experimental";

// namespace key for id_token claims carrying ChatGPT account info
const AUTH_CLAIM_NS = "https://api.openai.com/auth";

const SYSTEM_PROMPT = "You are Codex, OpenAI's coding agent.";
const VERIFY_PROMPT = "answer in one word, what day comes after Monday?";

const OAUTH_HEADERS: Record<string, string> = {
  originator: ORIGINATOR,
  "User-Agent": USER_AGENT,
  "OpenAI-Beta": OPENAI_BETA,
};

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

interface ModelsResponse {
  models?: Array<{ id?: string; slug?: string }>;
}

export interface LoginOptions {
  verify: boolean;
  example: boolean;
  clipboard: boolean;
}

export async function loginOpenAICodex(opts: LoginOptions): Promise<void> {
  const { verifier, challenge } = generatePkce(64);
  const state = base64urlRandom(32);

  const authUrl = buildAuthorizeUrl(verifier, challenge, state);
  const callback = waitForCallback({ port: CALLBACK_PORT, path: CALLBACK_PATH });

  const sp = spinner();
  sp.start("Waiting for browser login…");

  try {
    await open(authUrl);
  } catch (err) {
    sp.stop("Failed to open browser");
    throw new LibertyError(`Could not open the browser. Open this URL manually:\n${authUrl}`, err);
  }

  let redirectUrl: URL;
  try {
    redirectUrl = await callback;
  } catch (err) {
    sp.stop("OAuth callback failed");
    throw err;
  }

  const code = redirectUrl.searchParams.get("code");
  const returnedState = redirectUrl.searchParams.get("state");
  if (!code) {
    sp.stop("Missing authorization code");
    throw new LibertyError("OAuth redirect did not include an authorization code.");
  }
  if (!returnedState || returnedState !== state) {
    sp.stop("OAuth state mismatch");
    throw new LibertyError("OAuth state did not match — aborting.");
  }

  sp.message("Exchanging code for token…");
  const token = await exchangeCode(code, verifier);

  const idTokenClaims = decodeJwtPayload(token.id_token);
  const authClaims = idTokenClaims[AUTH_CLAIM_NS];
  const accountId =
    typeof authClaims === "object" && authClaims !== null
      ? ((authClaims as Record<string, unknown>).chatgpt_account_id as string | undefined)
      : undefined;
  if (!accountId) {
    throw new LibertyError("id_token is missing chatgpt_account_id claim.");
  }

  const creds = buildEnvelope(token, accountId);

  let pickedModel: string | null = null;
  if (opts.verify) {
    sp.message("Verifying token against Codex API…");
    pickedModel = await verifyToken(creds);
    sp.stop(`✓ Token verified (model: ${pickedModel})`);
  } else {
    sp.stop("✓ Token obtained (verification skipped)");
  }

  const example = opts.example ? buildCurlExample(creds, pickedModel) : null;
  await emit(creds, example, { clipboard: opts.clipboard });
}

function base64urlRandom(bytes: number): string {
  return randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildAuthorizeUrl(_verifier: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: ORIGINATOR,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LibertyError(`Token exchange failed: ${res.status} ${res.statusText} ${text}`.trim());
  }

  const data = (await res.json()) as Partial<TokenResponse>;
  if (
    typeof data.id_token !== "string" ||
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string"
  ) {
    throw new LibertyError("Token response is missing required fields.");
  }
  return data as TokenResponse;
}

function buildEnvelope(token: TokenResponse, accountId: string): ProviderCredentials {
  return {
    provider: "openai-codex",
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: jwtExpiresAt(token.access_token),
    auth: { in: "header", key: "Authorization", scheme: "Bearer" },
    authorize_url: AUTHORIZE_URL,
    token_url: TOKEN_URL,
    logout_url: null,
    headers: {
      "ChatGPT-Account-ID": accountId,
      ...OAUTH_HEADERS,
    },
    body: {
      instructions: SYSTEM_PROMPT,
      store: false,
      stream: true,
    },
    extra: {
      id_token: token.id_token,
      api_base: API_BASE,
      responses_url: `${API_BASE}/responses`,
      models_url: `${API_BASE}/models`,
    },
  };
}

async function verifyToken(creds: ProviderCredentials): Promise<string> {
  const headers = {
    Authorization: `Bearer ${creds.access_token}`,
    ...creds.headers,
  };

  const modelsRes = await fetch(`${API_BASE}/models?client_version=${PKG_VERSION}`, { headers });
  if (!modelsRes.ok) {
    const text = await modelsRes.text().catch(() => "");
    throw new LibertyError(
      `token verification failed: GET /models returned ${modelsRes.status} ${modelsRes.statusText} ${text}`.trim(),
    );
  }
  const modelsData = (await modelsRes.json()) as ModelsResponse;
  const model = pickModel(modelsData.models ?? []);
  if (!model) {
    throw new LibertyError("token verification failed: no models returned by /models.");
  }

  const responsesRes = await fetch(`${API_BASE}/responses`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      ...creds.body,
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: VERIFY_PROMPT }],
        },
      ],
    }),
  });
  if (!responsesRes.ok) {
    const text = await responsesRes.text().catch(() => "");
    throw new LibertyError(
      `token verification failed: POST /responses returned ${responsesRes.status} ${responsesRes.statusText} ${text}`.trim(),
    );
  }

  const sseBody = await responsesRes.text();
  const text = extractSseText(sseBody);
  if (!/tuesday/i.test(text)) {
    throw new LibertyError(
      `token verification failed: expected response to mention "tuesday", got: ${text || "<empty>"}`,
    );
  }
  return model;
}

function pickModel(models: Array<{ id?: string; slug?: string }>): string | null {
  const ids = models.map((m) => m.id ?? m.slug ?? "").filter(Boolean);
  if (ids.length === 0) return null;
  const small = ids.find((id) => /mini|nano|haiku/i.test(id));
  return small ?? ids[0] ?? null;
}

// Parse an SSE response from the Codex /responses endpoint and return the
// concatenated assistant text. Handles both `response.output_text.delta`
// (incremental) and `response.completed` (final snapshot) events; falls back
// to whichever is present.
function extractSseText(raw: string): string {
  const blocks = raw.split(/\r?\n\r?\n/);
  let delta = "";
  let final = "";
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const evt = parsed as Record<string, unknown>;
    const type = typeof evt.type === "string" ? evt.type : "";
    if (type === "response.output_text.delta" && typeof evt.delta === "string") {
      delta += evt.delta;
    } else if (type === "response.completed" && typeof evt.response === "object") {
      final = extractFinalText(evt.response);
    }
  }
  return (final || delta).trim();
}

function extractFinalText(response: unknown): string {
  if (typeof response !== "object" || response === null) return "";
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (typeof c !== "object" || c === null) continue;
      const text = (c as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join(" ");
}

function buildCurlExample(creds: ProviderCredentials, model: string | null): CurlExample {
  return {
    method: "POST",
    url: `${API_BASE}/responses`,
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      "content-type": "application/json",
      Accept: "text/event-stream",
      ...creds.headers,
    },
    body: {
      ...creds.body,
      model: model ?? "<model>",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: VERIFY_PROMPT }],
        },
      ],
    },
  };
}
