import { LibertyError } from "../errors.js";
import { decodeJwtPayload, jwtExpiresAt } from "../oauth/jwt.js";
import { generatePkce } from "../oauth/pkce.js";
import { runRedirectFlow } from "../oauth/redirect-flow.js";
import { base64urlRandom } from "../oauth/util.js";
import {
  BEARER_AUTH,
  type CurlExample,
  emit,
  type LoginOptions,
  type ProviderCredentials,
} from "../output.js";

const CLIENT_ID = Buffer.from("YXBwX0VNb2FtRUVaNzNmMENrWGFYcDdocmFubg==", "base64").toString();

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";

const API_BASE = "https://chatgpt.com/backend-api/codex";
const RESPONSES_URL = `${API_BASE}/responses`;
const MODELS_URL = `${API_BASE}/models`;
const PKG_VERSION = "0.0.1";
const ORIGINATOR = "codex_cli_rs";
const USER_AGENT = `${ORIGINATOR}/${PKG_VERSION}`;
const OPENAI_BETA = "responses=experimental";

// id_token claim namespace carrying ChatGPT account info.
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

export async function loginOpenAICodex(opts: LoginOptions): Promise<void> {
  const { verifier, challenge } = generatePkce(64);
  const state = base64urlRandom(32);

  const { code, spinner: sp } = await runRedirectFlow({
    authUrl: buildAuthorizeUrl(challenge, state),
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    expectedState: state,
  });

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

function buildAuthorizeUrl(challenge: string, state: string): string {
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
    auth: BEARER_AUTH,
    oauth: {
      authorize_url: AUTHORIZE_URL,
      token_url: TOKEN_URL,
      revoke_url: null,
      client_id: CLIENT_ID,
    },
    api: {
      base_url: API_BASE,
      chat_url: RESPONSES_URL,
      models_url: MODELS_URL,
    },
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
    },
  };
}

async function verifyToken(creds: ProviderCredentials): Promise<string> {
  const headers = {
    Authorization: `Bearer ${creds.access_token}`,
    ...creds.headers,
  };

  const modelsRes = await fetch(`${MODELS_URL}?client_version=${PKG_VERSION}`, { headers });
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

  const responsesRes = await fetch(RESPONSES_URL, {
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
  // Cheapest-first cascade: nano < mini < haiku < anything.
  const nano = ids.find((id) => /nano/i.test(id));
  if (nano) return nano;
  const mini = ids.find((id) => /mini/i.test(id));
  if (mini) return mini;
  const haiku = ids.find((id) => /haiku/i.test(id));
  if (haiku) return haiku;
  return ids[0] ?? null;
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
    url: creds.api.chat_url,
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
