#!/usr/bin/env node
// One-shot launcher: kill any previous watcher, spawn a fresh detached one.
// Used as the plugin [[startup]] hook and as the "restart watcher" action.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR } from "./plugin-state.mjs";

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try {
  chmodSync(STATE_DIR, 0o700);
} catch {
  // Best effort on filesystems that do not support POSIX modes.
}
const pidFile = path.join(STATE_DIR, "watcher.pid");

try {
  const oldPid = Number(readFileSync(pidFile, "utf8").trim());
  if (oldPid > 0) process.kill(oldPid, "SIGTERM");
} catch {
  // no previous watcher, or already gone
}

// v0.7 exposed a dormant Atomic command bridge. v0.8 has no command socket;
// controls stay in the task pane, so remove only that obsolete socket file.
rmSync(path.join(STATE_DIR, "bridge.sock"), { force: true });

const watcher = path.join(path.dirname(fileURLToPath(import.meta.url)), "watcher.mjs");
const child = spawn(process.execPath, [watcher], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});
child.unref();
writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
console.log(`atomic.workflows watcher started (pid ${child.pid})`);
