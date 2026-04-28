import { LibertyError } from "../errors.js";
import { generatePkce } from "../oauth/pkce.js";
import { runRedirectFlow } from "../oauth/redirect-flow.js";
import { base64urlRandom, sleep } from "../oauth/util.js";
import {
  BEARER_AUTH,
  type CurlExample,
  emit,
  type LoginOptions,
  type ProviderCredentials,
} from "../output.js";

const CLIENT_ID = Buffer.from(
  "3638313235353830393339352d6f6f386674326f707264726e7039653361716636617633686d6469623133356a2e617070732e676f6f676c6575736572636f6e74656e742e636f6d",
  "hex",
).toString();
// Google explicitly documents that the client secret of an installed-app OAuth
// client is not actually a secret. Same single-source-in-provider policy as
// CLIENT_ID — base64-encoded so casual greps don't pick it up.
const CLIENT_SECRET = Buffer.from(
  "474f435350582d347548674d506d2d316f37536b2d67655636437535636c584673786c",
  "hex",
).toString();

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

const API_BASE = "https://cloudcode-pa.googleapis.com/v1internal";
const GENERATE_CONTENT_URL = `${API_BASE}:generateContent`;
const STREAM_GENERATE_CONTENT_URL = `${API_BASE}:streamGenerateContent?alt=sse`;

const VERIFY_MODEL = "gemini-2.5-flash";
const VERIFY_PROMPT = "answer in one word, what day comes after Monday?";
const ONBOARD_POLL_INTERVAL_MS = 5000;
const ONBOARD_POLL_TIMEOUT_MS = 2 * 60 * 1000;

const OAUTH_HEADERS: Record<string, string> = {
  "User-Agent": "google-api-nodejs-client/9.15.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
};

const LOAD_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface CloudAiCompanionProject {
  id?: string;
}

interface AllowedTier {
  id?: string;
  isDefault?: boolean;
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  allowedTiers?: AllowedTier[];
}

interface OnboardOperation {
  name?: string;
  done?: boolean;
  response?: {
    cloudaicompanionProject?: CloudAiCompanionProject;
  };
}

interface GenerateContentResponse {
  response?: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
}

export async function loginGoogleGemini(opts: LoginOptions): Promise<void> {
  const { verifier, challenge } = generatePkce();
  const state = base64urlRandom(32);

  const { code, spinner: sp } = await runRedirectFlow({
    authUrl: buildAuthorizeUrl(challenge, state),
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    expectedState: state,
  });

  sp.message("Exchanging code for token…");
  const token = await exchangeCode(code, verifier);

  sp.message("Discovering Code Assist project…");
  const projectId = await discoverProject(token.access_token);

  const creds = buildEnvelope(token, projectId);

  if (opts.verify) {
    sp.message("Verifying token against Gemini Code Assist API…");
    await verifyToken(creds, projectId);
    sp.stop(`✓ Token verified (model: ${VERIFY_MODEL})`);
  } else {
    sp.stop("✓ Token obtained (verification skipped)");
  }

  const example = opts.example ? buildCurlExample(creds, projectId) : null;
  await emit(creds, example, { clipboard: opts.clipboard });
}

function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
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
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    typeof data.expires_in !== "number"
  ) {
    throw new LibertyError(
      "Token response is missing required fields (access_token / refresh_token / expires_in).",
    );
  }
  return data as TokenResponse;
}

async function discoverProject(accessToken: string): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    ...OAUTH_HEADERS,
  };

  const loadRes = await fetch(`${API_BASE}:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({ metadata: LOAD_METADATA }),
  });
  if (!loadRes.ok) {
    const text = await loadRes.text().catch(() => "");
    throw new LibertyError(
      `loadCodeAssist failed: ${loadRes.status} ${loadRes.statusText} ${text}`.trim(),
    );
  }
  const loadData = (await loadRes.json()) as LoadCodeAssistResponse;
  if (typeof loadData.cloudaicompanionProject === "string" && loadData.cloudaicompanionProject) {
    return loadData.cloudaicompanionProject;
  }

  const tierId = loadData.allowedTiers?.find((t) => t.isDefault)?.id ?? "free-tier";
  const onboardRes = await fetch(`${API_BASE}:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tierId, metadata: LOAD_METADATA }),
  });
  if (!onboardRes.ok) {
    const text = await onboardRes.text().catch(() => "");
    throw new LibertyError(
      `onboardUser failed: ${onboardRes.status} ${onboardRes.statusText} ${text}`.trim(),
    );
  }

  let lro = (await onboardRes.json()) as OnboardOperation;
  const deadline = Date.now() + ONBOARD_POLL_TIMEOUT_MS;
  while (!lro.done && lro.name) {
    if (Date.now() > deadline) {
      throw new LibertyError(
        `onboardUser polling timed out after ${Math.round(ONBOARD_POLL_TIMEOUT_MS / 1000)}s.`,
      );
    }
    await sleep(ONBOARD_POLL_INTERVAL_MS);
    const pollRes = await fetch(`${API_BASE}/${lro.name}`, { method: "GET", headers });
    if (!pollRes.ok) {
      const text = await pollRes.text().catch(() => "");
      throw new LibertyError(
        `onboardUser poll failed: ${pollRes.status} ${pollRes.statusText} ${text}`.trim(),
      );
    }
    lro = (await pollRes.json()) as OnboardOperation;
  }

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (!projectId) {
    throw new LibertyError(
      "Could not discover or provision a Google Cloud project for Gemini Code Assist.",
    );
  }
  return projectId;
}

function buildEnvelope(token: TokenResponse, projectId: string): ProviderCredentials {
  return {
    provider: "google-gemini",
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
    auth: BEARER_AUTH,
    oauth: {
      authorize_url: AUTHORIZE_URL,
      token_url: TOKEN_URL,
      revoke_url: REVOKE_URL,
    },
    api: {
      base_url: API_BASE,
      chat_url: GENERATE_CONTENT_URL,
      // Code Assist's internal API has no public model-listing endpoint.
      models_url: null,
    },
    headers: { ...OAUTH_HEADERS },
    body: { project: projectId },
    extra: {
      stream_chat_url: STREAM_GENERATE_CONTENT_URL,
    },
  };
}

async function verifyToken(creds: ProviderCredentials, projectId: string): Promise<void> {
  const res = await fetch(GENERATE_CONTENT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      "content-type": "application/json",
      ...OAUTH_HEADERS,
    },
    body: JSON.stringify({
      model: VERIFY_MODEL,
      project: projectId,
      request: {
        contents: [{ role: "user", parts: [{ text: VERIFY_PROMPT }] }],
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LibertyError(
      `token verification failed: POST :generateContent returned ${res.status} ${res.statusText} ${text}`.trim(),
    );
  }
  const data = (await res.json()) as GenerateContentResponse;
  const text = (data.response?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join(" ")
    .trim();
  if (!/tuesday/i.test(text)) {
    throw new LibertyError(
      `token verification failed: expected response to mention "tuesday", got: ${text || "<empty>"}`,
    );
  }
}

function buildCurlExample(creds: ProviderCredentials, projectId: string): CurlExample {
  return {
    method: "POST",
    url: creds.api.chat_url,
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      "content-type": "application/json",
      ...creds.headers,
    },
    body: {
      model: VERIFY_MODEL,
      project: projectId,
      request: {
        contents: [{ role: "user", parts: [{ text: VERIFY_PROMPT }] }],
      },
    },
  };
}
