#!/usr/bin/env node

import { execSync } from "node:child_process";
import readline from "node:readline";

function executeGitCommand(command) {
  try {
    return execSync(command, { encoding: "utf8" }).trim();
  } catch (error) {
    console.error(`Error executing: ${command}`);
    console.error(error.message);
    process.exit(1);
  }
}

function promptUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase());
    });
  });
}

async function checkPushed() {
  console.log("Checking remote sync...");
  executeGitCommand("git fetch origin main");

  const unpushedCommits = executeGitCommand("git log origin/main..HEAD --oneline");
  if (unpushedCommits) {
    console.error("Error: You have unpushed commits:");
    console.error(unpushedCommits);
    console.error("Please push your commits before releasing.");
    process.exit(1);
  }
  console.log("✓ No unpushed commits");

  const unpulledCommits = executeGitCommand("git log HEAD..origin/main --oneline");
  if (unpulledCommits) {
    console.log("Warning: There are unpulled commits from origin/main:");
    console.log(unpulledCommits);
    const answer = await promptUser("Continue anyway? [y/N] ");
    if (answer === "y" || answer === "yes") {
      console.log("Continuing with unpulled commits...");
    } else {
      console.log("Aborting release.");
      process.exit(1);
    }
  } else {
    console.log("✓ Branch is in sync with origin/main");
  }

  console.log("✓ Git repository is ready for release");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkPushed().catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
  });
}
