import clipboard from "clipboardy";

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

export async function emit(
  creds: ProviderCredentials,
  example: CurlExample | null,
  opts: { clipboard: boolean },
): Promise<void> {
  const json = JSON.stringify(creds, null, 2);
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
    process.stdout.write("json below is copied to clipboard\n");
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
