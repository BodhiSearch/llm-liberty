#!/usr/bin/env node

import { execSync } from "node:child_process";
import readline from "node:readline";

function executeGitCommand(command, suppressStderr = false) {
  try {
    const options = { encoding: "utf8" };
    if (suppressStderr) options.stdio = ["pipe", "pipe", "ignore"];
    return execSync(command, options).trim();
  } catch {
    return null;
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

function tagExists(tagName) {
  return executeGitCommand(`git rev-parse "${tagName}"`, true) !== null;
}

async function deleteTagIfExists(tagName) {
  console.log(`Checking for existing tag ${tagName}...`);

  if (!tagExists(tagName)) {
    console.log(`✓ Tag ${tagName} does not exist, continuing...`);
    process.exit(0);
  }

  console.log(`Warning: Tag ${tagName} already exists.`);
  const answer = await promptUser(`Delete and recreate tag ${tagName}? [y/N] `);

  if (answer === "y" || answer === "yes") {
    console.log(`Deleting existing tag ${tagName}...`);

    try {
      executeGitCommand(`git tag -d "${tagName}"`);
      console.log(`✓ Deleted local tag ${tagName}`);
    } catch {
      console.log(`Note: Local tag ${tagName} may not exist`);
    }

    try {
      executeGitCommand(`git push --delete origin "${tagName}"`);
      console.log(`✓ Deleted remote tag ${tagName}`);
    } catch {
      console.log(`Note: Remote tag ${tagName} may not exist`);
    }

    console.log(`✓ Tag ${tagName} cleaned up successfully`);
    process.exit(0);
  } else {
    console.log("Aborting release.");
    process.exit(1);
  }
}

function main() {
  const tagName = process.argv[2];
  if (!tagName) {
    console.error("Usage: node delete-tag-if-exists.mjs <tag-name>");
    process.exit(1);
  }
  deleteTagIfExists(tagName).catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
