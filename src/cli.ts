import { Command } from "commander";

const program = new Command();

program
  .name("llm-liberty")
  .description("Free your LLM subscription — extract OAuth tokens from provider CLIs.")
  .version("0.0.1");

program
  .command("login <provider>")
  .description("Run the OAuth flow for <provider> and print credentials as JSON.")
  .action((provider: string) => {
    // TODO: dispatch to providers/<provider>.ts
    console.log(JSON.stringify({ provider, status: "not implemented" }, null, 2));
  });

program.parse();
