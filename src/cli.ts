import { Command } from "commander";
import { LibertyError } from "./errors.js";
import { loginAnthropic } from "./providers/anthropic.js";
import { loginOpenAICodex } from "./providers/openai-codex.js";

interface LoginFlags {
  verify: boolean;
  example: boolean;
  clipboard: boolean;
}

const program = new Command();

program
  .name("llm-liberty")
  .description("Free your LLM subscription — extract OAuth tokens from provider CLIs.")
  .version("0.0.1");

program
  .command("login <provider>")
  .description("Run the OAuth flow for <provider> and print credentials as JSON.")
  .option("--no-verify", "Skip the post-login API check that confirms the token works.")
  .option("--no-example", "Skip the curl example printed after the JSON envelope.")
  .option("--no-clipboard", "Skip copying the JSON envelope to the system clipboard.")
  .action(async (provider: string, flags: LoginFlags) => {
    try {
      await dispatch(provider, flags);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      if (err instanceof LibertyError && err.cause instanceof Error) {
        process.stderr.write(`  caused by: ${err.cause.message}\n`);
      }
      process.exitCode = 1;
    }
  });

async function dispatch(provider: string, flags: LoginFlags): Promise<void> {
  switch (provider) {
    case "anthropic":
      await loginAnthropic({
        verify: flags.verify,
        example: flags.example,
        clipboard: flags.clipboard,
      });
      return;
    case "openai-codex":
      await loginOpenAICodex({
        verify: flags.verify,
        example: flags.example,
        clipboard: flags.clipboard,
      });
      return;
    default:
      throw new LibertyError(
        `Unknown provider: ${provider}. Supported providers: anthropic, openai-codex.`,
      );
  }
}

await program.parseAsync();
process.exit(process.exitCode ?? 0);
