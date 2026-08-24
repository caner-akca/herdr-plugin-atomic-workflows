#!/usr/bin/env node
// One-shot launcher: kill any previous watcher, spawn a fresh detached one.
// Used as the plugin [[startup]] hook and as the "restart watcher" action.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp/atomic-workflows-plugin";
mkdirSync(STATE_DIR, { recursive: true });
const pidFile = path.join(STATE_DIR, "watcher.pid");

try {
  const oldPid = Number(readFileSync(pidFile, "utf8").trim());
  if (oldPid > 0) process.kill(oldPid, "SIGTERM");
} catch {
  // no previous watcher, or already gone
}

const watcher = path.join(path.dirname(fileURLToPath(import.meta.url)), "watcher.mjs");
const child = spawn(process.execPath, [watcher], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
child.unref();
writeFileSync(pidFile, String(child.pid));
console.log(`atomic.workflows watcher started (pid ${child.pid})`);
