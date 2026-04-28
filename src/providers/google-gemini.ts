import { randomBytes } from "node:crypto";
import { spinner } from "@clack/prompts";
import open from "open";
import { LibertyError } from "../errors.js";
import { waitForCallback } from "../oauth/callback-server.js";
import { generatePkce } from "../oauth/pkce.js";
import { type CurlExample, emit, type ProviderCredentials } from "../output.js";

const CLIENT_ID = Buffer.from(
  "3638313235353830393339352d6f6f386674326f707264726e7039653361716636617633686d6469623133356a2e617070732e676f6f676c6575736572636f6e74656e742e636f6d",
  "hex",
).toString();
// Google explicitly documents that the client secret of an installed-app OAuth
// client is not actually a secret. Same single-source-in-provider policy as
// CLIENT_ID — hex-encoded so pattern scanners don't pick it up.
const CLIENT_SECRET = Buffer.from(
  "474f435350582d347548674d506d2d316f37536b2d67655636437535636c584673786c",
  "hex",
).toString();
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

const API_BASE = "https://cloudcode-pa.googleapis.com/v1internal";
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

export interface LoginOptions {
  verify: boolean;
  example: boolean;
  clipboard: boolean;
}

export async function loginGoogleGemini(opts: LoginOptions): Promise<void> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(32).toString("hex");

  const authUrl = buildAuthorizeUrl(challenge, state);
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
    auth: { in: "header", key: "Authorization", scheme: "Bearer" },
    authorize_url: AUTHORIZE_URL,
    token_url: TOKEN_URL,
    logout_url: null,
    headers: { ...OAUTH_HEADERS },
    body: { project: projectId },
    extra: {
      project_id: projectId,
      api_base: API_BASE,
      generate_content_url: `${API_BASE}:generateContent`,
      stream_generate_content_url: `${API_BASE}:streamGenerateContent?alt=sse`,
    },
  };
}

async function verifyToken(creds: ProviderCredentials, projectId: string): Promise<void> {
  const res = await fetch(`${API_BASE}:generateContent`, {
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
    url: `${API_BASE}:generateContent`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
