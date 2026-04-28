export interface ProviderCredentials {
  provider: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  auth: { in: "header"; key: string; scheme: string };
  authorize_url: string;
  token_url: string;
  logout_url: string | null;
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

export function emit(creds: ProviderCredentials, example: CurlExample | null): void {
  process.stdout.write(`${JSON.stringify(creds, null, 2)}\n`);
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
