import { LibertyError } from "../errors.js";
import { generatePkce } from "../oauth/pkce.js";
import { runRedirectFlow } from "../oauth/redirect-flow.js";
import {
  BEARER_AUTH,
  type CurlExample,
  emit,
  type LoginOptions,
  type ProviderCredentials,
} from "../output.js";

const CLIENT_ID = Buffer.from(
  "39643163323530612d653631622d343464392d383865642d353934346431393632663565",
  "hex",
).toString();

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const API_BASE = "https://api.anthropic.com";
const MODELS_URL = `${API_BASE}/v1/models`;
const MESSAGES_URL = `${API_BASE}/v1/messages`;

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

export async function loginAnthropic(opts: LoginOptions): Promise<void> {
  const { verifier, challenge } = generatePkce();

  const { code, spinner: sp } = await runRedirectFlow({
    authUrl: buildAuthorizeUrl(verifier, challenge),
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    expectedState: verifier,
  });

  sp.message("Exchanging code for token…");
  const token = await exchangeCode(code, verifier);

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

async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state: verifier,
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
    auth: BEARER_AUTH,
    oauth: {
      authorize_url: AUTHORIZE_URL,
      token_url: TOKEN_URL,
      revoke_url: null,
      client_id: CLIENT_ID,
    },
    api: {
      base_url: API_BASE,
      chat_url: MESSAGES_URL,
      models_url: MODELS_URL,
    },
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

  const modelsRes = await fetch(MODELS_URL, { headers });
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

  const completionRes = await fetch(MESSAGES_URL, {
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
    url: creds.api.chat_url,
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
