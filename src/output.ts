import clipboard from "clipboardy";

export interface LoginOptions {
  verify: boolean;
  example: boolean;
  clipboard: boolean;
}

export interface AuthSpec {
  in: "header" | "query";
  key: string;
  scheme: string;
}

export interface OauthEndpoints {
  authorize_url: string;
  token_url: string;
  // OAuth 2.0 token-revocation endpoint (RFC 7009). `null` when the provider
  // does not expose a user-callable revoke endpoint — token cleanup then
  // requires the user to remove the grant from the provider's web UI.
  revoke_url: string | null;
}

export interface ApiEndpoints {
  base_url: string;
  // Canonical chat/inference endpoint for this provider. Forward `headers` +
  // `body` and add provider-specific fields (`model`, `messages`, …) to call.
  chat_url: string;
  // Models-listing endpoint, when the provider exposes one. `null` when there
  // is no public listing endpoint (e.g. Google Code Assist).
  models_url: string | null;
}

export interface ProviderCredentials {
  provider: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  auth: AuthSpec;
  oauth: OauthEndpoints;
  api: ApiEndpoints;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface CurlExample {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export const BEARER_AUTH: AuthSpec = { in: "header", key: "Authorization", scheme: "Bearer" };

export async function emit(
  creds: ProviderCredentials,
  example: CurlExample | null,
  opts: { clipboard: boolean },
): Promise<void> {
  const json = JSON.stringify({ version: "1.0.0", ...creds }, null, 2);
  let copied = false;

  if (opts.clipboard) {
    try {
      await clipboard.write(json);
      copied = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Clipboard unavailable: ${reason}. Continuing without copying.\n`);
    }
  }

  if (copied) {
    process.stdout.write(
      "json below is copied to clipboard, you can use it in BodhiApp (https://getbodhi.app) to add it as an api model.\n",
    );
    process.stdout.write("---\n");
  } else {
    process.stdout.write(
      "you can use the json below in BodhiApp (https://getbodhi.app) to add it as an api model.\n",
    );
    process.stdout.write("---\n");
  }
  process.stdout.write(`${json}\n`);
  if (example) {
    process.stdout.write("---\n");
    process.stdout.write(`${renderCurl(example)}\n`);
  }
}

export function renderCurl(example: CurlExample): string {
  const lines: string[] = [`curl -X ${example.method} ${shellQuote(example.url)} \\`];
  for (const [name, value] of Object.entries(example.headers)) {
    lines.push(`  -H ${shellQuote(`${name}: ${value}`)} \\`);
  }
  lines.push("  --data-raw \\");
  lines.push(`  ${shellQuote(JSON.stringify(example.body, null, 2))}`);
  return lines.join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
