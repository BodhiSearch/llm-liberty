import { Command } from "commander";
import { LibertyError } from "./errors.js";
import type { LoginOptions } from "./output.js";
import { loginAnthropic } from "./providers/anthropic.js";
import { loginGitHubCopilot } from "./providers/github-copilot.js";
import { loginGoogleAntigravity } from "./providers/google-antigravity.js";
import { loginGoogleGemini } from "./providers/google-gemini.js";
import { loginOpenAICodex } from "./providers/openai-codex.js";

const PROVIDERS: Record<string, (opts: LoginOptions) => Promise<void>> = {
  anthropic: loginAnthropic,
  "openai-codex": loginOpenAICodex,
  "google-gemini": loginGoogleGemini,
  "google-antigravity": loginGoogleAntigravity,
  "github-copilot": loginGitHubCopilot,
};

const program = new Command();

program
  .name("llm-liberty")
  .description("Free your LLM subscription — extract OAuth tokens from provider CLIs.")
  .version("0.0.1");

program
  .command("login <provider>")
  .description(
    `Run the OAuth flow for <provider> and print credentials as JSON. Providers: ${Object.keys(PROVIDERS).join(", ")}.`,
  )
  .option("--no-verify", "Skip the post-login API check that confirms the token works.")
  .option("--no-example", "Skip the curl example printed after the JSON envelope.")
  .option("--no-clipboard", "Skip copying the JSON envelope to the system clipboard.")
  .action(async (provider: string, flags: LoginOptions) => {
    try {
      const handler = PROVIDERS[provider];
      if (!handler) {
        throw new LibertyError(
          `Unknown provider: ${provider}. Supported providers: ${Object.keys(PROVIDERS).join(", ")}.`,
        );
      }
      await handler({
        verify: flags.verify,
        example: flags.example,
        clipboard: flags.clipboard,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      if (err instanceof LibertyError && err.cause instanceof Error) {
        process.stderr.write(`  caused by: ${err.cause.message}\n`);
      }
      process.exitCode = 1;
    }
  });

await program.parseAsync();
process.exit(process.exitCode ?? 0);
