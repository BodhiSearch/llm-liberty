import { spinner } from "@clack/prompts";
import open from "open";
import { LibertyError } from "../errors.js";
import { waitForCallback } from "./callback-server.js";

export interface RedirectFlowOptions {
  authUrl: string;
  port: number;
  path: string;
  expectedState: string;
  startMessage?: string;
  spinnerInstance?: ReturnType<typeof spinner>;
}

export interface RedirectFlowResult {
  code: string;
  spinner: ReturnType<typeof spinner>;
}

// Shared boilerplate for the three providers that use a localhost redirect:
// - start a spinner, launch the browser, wait for the OAuth callback
// - validate that an authorization `code` is present
// - validate that returned `state` matches what we sent
// Returns the code (caller exchanges it for tokens) and the live spinner so
// the caller can keep updating its message through token exchange + verify.
export async function runRedirectFlow(opts: RedirectFlowOptions): Promise<RedirectFlowResult> {
  const sp = opts.spinnerInstance ?? spinner();
  sp.start(opts.startMessage ?? "Waiting for browser login…");

  const callback = waitForCallback({ port: opts.port, path: opts.path });

  try {
    await open(opts.authUrl);
  } catch (err) {
    sp.stop("Failed to open browser");
    throw new LibertyError(
      `Could not open the browser. Open this URL manually:\n${opts.authUrl}`,
      err,
    );
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
  if (!state || state !== opts.expectedState) {
    sp.stop("OAuth state mismatch");
    throw new LibertyError("OAuth state did not match — aborting.");
  }

  return { code, spinner: sp };
}
