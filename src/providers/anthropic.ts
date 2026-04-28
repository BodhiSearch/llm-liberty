import { spinner } from "@clack/prompts";
import open from "open";
import { LibertyError } from "../errors.js";
import { waitForCallback } from "../oauth/callback-server.js";
import { generatePkce } from "../oauth/pkce.js";
import { type CurlExample, emit, type ProviderCredentials } from "../output.js";

const CLIENT_ID = Buffer.from(
  "39643163323530612d653631622d343464392d383865642d353934346431393632663565",
  "hex",
).toString();
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "http://localhost:53692/callback";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const API_BASE = "https://api.anthropic.com";
const SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const VERIFY_PROMPT = "answer in one word, what day comes after Monday?";

const OAUTH_HEADERS: Record<string, string> = {
  "anthropic-beta": "oauth-2025-04-20",
  "anthropic-version": "2023-06-01",
};

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface ModelEntry {
  id: string;
}

interface ModelListResponse {
  data: ModelEntry[];
}

interface MessagesResponse {
  content: Array<{ type: string; text?: string }>;
}

export interface LoginOptions {
  verify: boolean;
  example: boolean;
  clipboard: boolean;
}

export async function loginAnthropic(opts: LoginOptions): Promise<void> {
  const { verifier, challenge } = generatePkce();

  const authUrl = buildAuthorizeUrl(verifier, challenge);
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
  const state = redirectUrl.searchParams.get("state");
  if (!code) {
    sp.stop("Missing authorization code");
    throw new LibertyError("OAuth redirect did not include an authorization code.");
  }
  if (!state || state !== verifier) {
    sp.stop("OAuth state mismatch");
    throw new LibertyError("OAuth state did not match the PKCE verifier — aborting.");
  }

  sp.message("Exchanging code for token…");
  const token = await exchangeCode(code, state, verifier);

  const creds = buildEnvelope(token);

  let pickedModel: string | null = null;
  if (opts.verify) {
    sp.message("Verifying token against Anthropic API…");
    pickedModel = await verifyToken(creds);
    sp.stop(`✓ Token verified (model: ${pickedModel})`);
  } else {
    sp.stop("✓ Token obtained (verification skipped)");
  }

  const example = opts.example ? buildCurlExample(creds, pickedModel) : null;
  await emit(creds, example, { clipboard: opts.clipboard });
}

function buildAuthorizeUrl(verifier: string, challenge: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCode(code: string, state: string, verifier: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LibertyError(`Token exchange failed: ${res.status} ${res.statusText} ${text}`.trim());
  }

  const data = (await res.json()) as Partial<TokenResponse>;
  if (
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    typeof data.expires_in !== "number"
  ) {
    throw new LibertyError("Token response is missing required fields.");
  }
  return data as TokenResponse;
}

function buildEnvelope(token: TokenResponse): ProviderCredentials {
  return {
    provider: "anthropic",
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
    auth: { in: "header", key: "Authorization", scheme: "Bearer" },
    authorize_url: AUTHORIZE_URL,
    token_url: TOKEN_URL,
    logout_url: null,
    headers: { ...OAUTH_HEADERS },
    body: {
      system: SYSTEM_PROMPT,
      max_tokens: 256,
    },
  };
}

async function verifyToken(creds: ProviderCredentials): Promise<string> {
  const headers = {
    Authorization: `Bearer ${creds.access_token}`,
    ...OAUTH_HEADERS,
  };

  const modelsRes = await fetch(`${API_BASE}/v1/models`, { headers });
  if (!modelsRes.ok) {
    const text = await modelsRes.text().catch(() => "");
    throw new LibertyError(
      `token verification failed: GET /v1/models returned ${modelsRes.status} ${modelsRes.statusText} ${text}`.trim(),
    );
  }
  const models = (await modelsRes.json()) as ModelListResponse;
  const haiku = pickLatestHaiku(models.data ?? []);
  if (!haiku) {
    throw new LibertyError(
      "token verification failed: no Haiku model returned by /v1/models for this account.",
    );
  }

  const completionRes = await fetch(`${API_BASE}/v1/messages`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      ...creds.body,
      model: haiku,
      messages: [{ role: "user", content: VERIFY_PROMPT }],
    }),
  });
  if (!completionRes.ok) {
    const text = await completionRes.text().catch(() => "");
    throw new LibertyError(
      `token verification failed: POST /v1/messages returned ${completionRes.status} ${completionRes.statusText} ${text}`.trim(),
    );
  }
  const completion = (await completionRes.json()) as MessagesResponse;
  const text = (completion.content ?? [])
    .map((part) => part.text ?? "")
    .join(" ")
    .trim();
  if (!/tuesday/i.test(text)) {
    throw new LibertyError(
      `token verification failed: expected response to mention "tuesday", got: ${text || "<empty>"}`,
    );
  }
  return haiku;
}

function pickLatestHaiku(models: ModelEntry[]): string | null {
  const haikus = models.map((m) => m.id).filter((id) => /haiku/i.test(id));
  if (haikus.length === 0) return null;
  haikus.sort();
  return haikus[haikus.length - 1] ?? null;
}

function buildCurlExample(creds: ProviderCredentials, model: string | null): CurlExample {
  return {
    method: "POST",
    url: `${API_BASE}/v1/messages`,
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      "content-type": "application/json",
      ...creds.headers,
    },
    body: {
      ...creds.body,
      model: model ?? "<model>",
      messages: [{ role: "user", content: VERIFY_PROMPT }],
    },
  };
}
