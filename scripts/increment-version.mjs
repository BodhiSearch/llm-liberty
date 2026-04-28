#!/usr/bin/env node

function incrementMinorVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid version format: ${version}. Expected format: x.y.z`);
  }
  const [, major, minor] = match;
  return `${major}.${parseInt(minor, 10) + 1}.0`;
}

function main() {
  const currentVersion = process.argv[2];
  if (!currentVersion) {
    console.error("Usage: node increment-version.mjs <version>");
    process.exit(1);
  }
  try {
    console.log(incrementMinorVersion(currentVersion));
    process.exit(0);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { incrementMinorVersion };
