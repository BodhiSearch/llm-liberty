import { note, spinner } from "@clack/prompts";
import open from "open";
import { LibertyError } from "../errors.js";
import { type CurlExample, emit, type ProviderCredentials } from "../output.js";

const CLIENT_ID = Buffer.from("4976312e62353037613038633837656366653938", "hex").toString();

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const SESSION_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_API_BASE = "https://api.individual.githubcopilot.com";
const SCOPE = "read:user";

const VERIFY_MODEL = "gpt-4o-mini";
const VERIFY_PROMPT = "answer in one word, what day comes after Monday?";

const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

const DEVICE_FLOW_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "GitHubCopilotChat/0.35.0",
};

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

interface AccessTokenSuccess {
  access_token: string;
}

interface AccessTokenError {
  error: string;
  error_description?: string;
  interval?: number;
}

interface SessionTokenResponse {
  token: string;
  expires_at: number | string;
}

interface ModelEntry {
  id: string;
}

interface ModelListResponse {
  data?: ModelEntry[];
}

export interface LoginOptions {
  verify: boolean;
  example: boolean;
  clipboard: boolean;
}

export async function loginGitHubCopilot(opts: LoginOptions): Promise<void> {
  const device = await startDeviceFlow();

  note(
    `${device.user_code}\n\nOpen ${device.verification_uri} and paste the code above.`,
    "GitHub device login",
  );

  try {
    await open(device.verification_uri);
  } catch {
    // Browser auto-open is best-effort; the note above already shows the URL.
  }

  const sp = spinner();
  sp.start("Waiting for GitHub authorization…");

  let githubAccessToken: string;
  try {
    githubAccessToken = await pollForAccessToken(device);
  } catch (err) {
    sp.stop("GitHub authorization failed");
    throw err;
  }

  sp.message("Exchanging GitHub token for Copilot session token…");
  const session = await fetchCopilotSession(githubAccessToken);
  const apiBase = resolveApiBase(session.token);
  const isEnterprise = apiBase !== DEFAULT_API_BASE;

  const creds = buildEnvelope({
    sessionToken: session.token,
    githubToken: githubAccessToken,
    expiresAtSeconds: session.expiresAtSeconds,
    apiBase,
    isEnterprise,
  });

  let pickedModel: string | null = null;
  if (opts.verify) {
    sp.message("Verifying token against GitHub Copilot API…");
    pickedModel = await verifyToken(creds, apiBase);
    sp.stop(`✓ Token verified (model: ${pickedModel})`);
  } else {
    sp.stop("✓ Token obtained (verification skipped)");
  }

  const example = opts.example ? buildCurlExample(creds, pickedModel) : null;
  await emit(creds, example, { clipboard: opts.clipboard });
}

async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString();
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: DEVICE_FLOW_HEADERS,
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LibertyError(
      `Device code request failed: ${res.status} ${res.statusText} ${text}`.trim(),
    );
  }
  const data = (await res.json()) as Partial<DeviceCodeResponse>;
  if (
    typeof data.device_code !== "string" ||
    typeof data.user_code !== "string" ||
    typeof data.verification_uri !== "string" ||
    typeof data.interval !== "number" ||
    typeof data.expires_in !== "number"
  ) {
    throw new LibertyError("Device code response is missing required fields.");
  }
  return data as DeviceCodeResponse;
}

async function pollForAccessToken(device: DeviceCodeResponse): Promise<string> {
  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = Math.max(1000, device.interval * 1000);

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString();

    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: DEVICE_FLOW_HEADERS,
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LibertyError(
        `Access token poll failed: ${res.status} ${res.statusText} ${text}`.trim(),
      );
    }

    const data = (await res.json()) as Partial<AccessTokenSuccess & AccessTokenError>;
    if (typeof data.access_token === "string" && data.access_token.length > 0) {
      return data.access_token;
    }
    if (data.error === "authorization_pending") {
      continue;
    }
    if (data.error === "slow_down") {
      const next = typeof data.interval === "number" ? data.interval * 1000 : intervalMs + 5000;
      intervalMs = Math.max(intervalMs + 1000, next);
      continue;
    }
    if (typeof data.error === "string") {
      const desc = data.error_description ? `: ${data.error_description}` : "";
      throw new LibertyError(`Device flow failed: ${data.error}${desc}`);
    }
  }

  throw new LibertyError(
    "Device code expired before authorization completed. Re-run `login github-copilot`.",
  );
}

async function fetchCopilotSession(
  githubAccessToken: string,
): Promise<{ token: string; expiresAtSeconds: number }> {
  const res = await fetch(SESSION_TOKEN_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubAccessToken}`,
      ...COPILOT_HEADERS,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LibertyError(
      `Copilot session token request failed: ${res.status} ${res.statusText} ${text}`.trim(),
    );
  }
  const data = (await res.json()) as Partial<SessionTokenResponse>;
  if (typeof data.token !== "string" || data.token.length === 0) {
    throw new LibertyError("Copilot session response missing `token`.");
  }

  const expiresAtSeconds = parseExpiresAt(data.expires_at);
  if (expiresAtSeconds === null) {
    throw new LibertyError("Copilot session response missing or invalid `expires_at`.");
  }
  return { token: data.token, expiresAtSeconds };
}

function parseExpiresAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return null;
    return parsed > 1e11 ? Math.floor(parsed / 1000) : parsed;
  }
  return null;
}

function resolveApiBase(sessionToken: string): string {
  const match = sessionToken.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) return DEFAULT_API_BASE;
  const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  if (!host) return DEFAULT_API_BASE;
  return `https://${host}`;
}

interface BuildEnvelopeArgs {
  sessionToken: string;
  githubToken: string;
  expiresAtSeconds: number;
  apiBase: string;
  isEnterprise: boolean;
}

function buildEnvelope(args: BuildEnvelopeArgs): ProviderCredentials {
  return {
    provider: "github-copilot",
    access_token: args.sessionToken,
    refresh_token: args.githubToken,
    expires_at: args.expiresAtSeconds,
    auth: { in: "header", key: "Authorization", scheme: "Bearer" },
    authorize_url: DEVICE_CODE_URL,
    token_url: SESSION_TOKEN_URL,
    logout_url: null,
    headers: { ...COPILOT_HEADERS },
    body: { stream: true },
    extra: {
      github_token: args.githubToken,
      api_base: args.apiBase,
      models_url: `${args.apiBase}/models`,
      chat_completions_url: `${args.apiBase}/chat/completions`,
      is_enterprise: args.isEnterprise,
      session_token_url: SESSION_TOKEN_URL,
    },
  };
}

async function verifyToken(creds: ProviderCredentials, apiBase: string): Promise<string> {
  const headers = {
    Authorization: `Bearer ${creds.access_token}`,
    ...COPILOT_HEADERS,
  };

  const modelsRes = await fetch(`${apiBase}/models`, { headers });
  if (!modelsRes.ok) {
    const text = await modelsRes.text().catch(() => "");
    throw new LibertyError(
      `token verification failed: GET /models returned ${modelsRes.status} ${modelsRes.statusText} ${text}`.trim(),
    );
  }
  const models = (await modelsRes.json()) as ModelListResponse;
  const model = pickModel(models.data ?? []);
  if (!model) {
    throw new LibertyError(
      "token verification failed: /models returned no models for this account.",
    );
  }

  const completionRes = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      ...creds.body,
      model,
      messages: [{ role: "user", content: VERIFY_PROMPT }],
    }),
  });
  if (!completionRes.ok) {
    const text = await completionRes.text().catch(() => "");
    throw new LibertyError(
      `token verification failed: POST /chat/completions returned ${completionRes.status} ${completionRes.statusText} ${text}`.trim(),
    );
  }

  const text = await readSseContent(completionRes);
  if (!/tuesday/i.test(text)) {
    throw new LibertyError(
      `token verification failed: expected response to mention "tuesday", got: ${text || "<empty>"}`,
    );
  }
  return model;
}

function pickModel(models: ModelEntry[]): string | null {
  const ids = models.map((m) => m.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return null;
  const exact = ids.find((id) => id === VERIFY_MODEL);
  if (exact) return exact;
  const mini = ids.find((id) => /mini/i.test(id));
  if (mini) return mini;
  return ids[0] ?? null;
}

async function readSseContent(res: Response): Promise<string> {
  if (!res.body) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
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

function buildCurlExample(creds: ProviderCredentials, model: string | null): CurlExample {
  return {
    method: "POST",
    url: String(creds.extra?.chat_completions_url ?? `${DEFAULT_API_BASE}/chat/completions`),
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      "content-type": "application/json",
      Accept: "text/event-stream",
      ...creds.headers,
    },
    body: {
      ...creds.body,
      model: model ?? "<model>",
      messages: [{ role: "user", content: VERIFY_PROMPT }],
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
