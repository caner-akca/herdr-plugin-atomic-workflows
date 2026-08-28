#!/usr/bin/env node
// One-shot launcher: kill any previous watcher, spawn a fresh detached one.
// Used as the plugin [[startup]] hook and as the "restart watcher" action.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR } from "./plugin-state.mjs";
import { ownerPath, terminateVerifiedOwner } from "./watcher-owner.mjs";

// Review F1: never run against the fallback state dir, and never signal a
// PID whose live command line is not verifiably our watcher.
if (!process.env.HERDR_PLUGIN_STATE_DIR) {
  console.error("start-watcher requires HERDR_PLUGIN_STATE_DIR from Herdr; refusing the fallback state dir");
  process.exit(1);
}
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try {
  chmodSync(STATE_DIR, 0o700);
} catch {
  // Best effort on filesystems that do not support POSIX modes.
}
const pidFile = ownerPath(STATE_DIR);
const previous = terminateVerifiedOwner(pidFile, "watcher.mjs");
if (previous.action === "skipped-unverified") {
  console.error(`previous watcher pid ${previous.pid} no longer looks like our watcher; not signalling it`);
}

// v0.7 exposed a dormant Atomic command bridge. v0.8 has no command socket;
// controls stay in the task pane, so remove only that obsolete socket file.
rmSync(path.join(STATE_DIR, "bridge.sock"), { force: true });

const watcher = path.join(path.dirname(fileURLToPath(import.meta.url)), "watcher.mjs");
const log = openSync(path.join(STATE_DIR, "watcher.log"), "a");
const child = spawn(process.execPath, [watcher], {
  detached: true,
  stdio: ["ignore", log, log],
  env: process.env,
});
child.unref();
// The watcher re-claims this with its full identity on boot; writing it here
// closes the window where a crash before claim leaves no owner record.
writeFileSync(pidFile, `${JSON.stringify({ pid: child.pid, startedAt: Date.now(), script: "watcher.mjs" })}\n`, { mode: 0o600 });
console.log(`atomic.workflows watcher started (pid ${child.pid})`);
