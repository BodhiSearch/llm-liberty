import { isCancel, select } from "@clack/prompts";
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
  .command("login [provider]")
  .description(
    `Run the OAuth flow for <provider> and print credentials as JSON. Providers: ${Object.keys(PROVIDERS).join(", ")}. Omit <provider> to pick interactively.`,
  )
  .option("--no-verify", "Skip the post-login API check that confirms the token works.")
  .option("--example", "Also print a copy-pasteable curl example after the JSON envelope.", false)
  .option("--no-clipboard", "Skip copying the JSON envelope to the system clipboard.")
  .action(async (provider: string | undefined, flags: LoginOptions) => {
    try {
      if (provider === undefined) {
        if (!process.stdin.isTTY) {
          throw new LibertyError(
            `No provider specified. Supported providers: ${Object.keys(PROVIDERS).join(", ")}.`,
          );
        }
        const chosen = await select({
          message: "Choose a provider",
          options: Object.keys(PROVIDERS).map((p) => ({ value: p, label: p })),
        });
        if (isCancel(chosen)) {
          process.stderr.write("Cancelled.\n");
          process.exitCode = 1;
          return;
        }
        provider = chosen;
      }
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
