#!/usr/bin/env node
// Install (or remove) the OPTIONAL atomic integration: copies
// extensions/atomic-workflows-herdr.ts into ~/.atomic/agent/extensions/ so
// live atomic sessions can execute the board's workflow control verbs.
// Every monitor feature works without it. Takes effect for NEW atomic
// sessions only. `node bin/install-extension.mjs remove` uninstalls.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "ATOMIC_WORKFLOWS_BRIDGE=1";
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions", "atomic-workflows-herdr.ts");
const destDir = path.join(os.homedir(), ".atomic", "agent", "extensions");
const dest = path.join(destDir, "atomic-workflows-herdr.ts");

function isOurs(file) {
  try {
    return readFileSync(file, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

if (process.argv[2] === "remove") {
  if (!existsSync(dest)) {
    console.log("atomic integration not installed — nothing to remove");
  } else if (!isOurs(dest)) {
    console.error(`refusing to remove ${dest}: it is not this plugin's file`);
    process.exit(1);
  } else {
    rmSync(dest);
    console.log(`removed ${dest} (existing atomic sessions keep it until restarted)`);
  }
  process.exit(0);
}

if (!existsSync(src)) {
  console.error(`extension source missing: ${src}`);
  process.exit(1);
}
if (existsSync(dest) && !isOurs(dest)) {
  console.error(`refusing to overwrite ${dest}: it is not this plugin's file`);
  process.exit(1);
}
if (existsSync(dest) && readFileSync(dest, "utf8") === readFileSync(src, "utf8")) {
  console.log("atomic integration already installed and up to date");
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`installed ${dest}
takes effect for NEW atomic sessions (restart atomic panes to activate).
remove any time with: node bin/install-extension.mjs remove`);
