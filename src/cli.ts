import { Command } from "commander";
import { LibertyError } from "./errors.js";
import { loginAnthropic } from "./providers/anthropic.js";

interface LoginFlags {
  verify: boolean;
  example: boolean;
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
      await loginAnthropic({ verify: flags.verify, example: flags.example });
      return;
    default:
      throw new LibertyError(`Unknown provider: ${provider}. Supported providers: anthropic.`);
  }
}

await program.parseAsync();
process.exit(process.exitCode ?? 0);
