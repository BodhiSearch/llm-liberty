#!/usr/bin/env node

import { execSync } from "node:child_process";

function checkClean() {
  const status = execSync("git status --porcelain", { encoding: "utf8" }).trim();

  if (status) {
    console.error("Error: You have uncommitted changes:");
    console.error(status);
    console.error("Please commit or stash your changes before releasing.");
    process.exit(1);
  }

  console.log("✓ No uncommitted changes");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkClean();
}
