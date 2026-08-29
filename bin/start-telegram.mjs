#!/usr/bin/env node
// One-shot launcher: kill any previous Telegram daemon, spawn a fresh
// detached one. Used as a plugin [[startup]] hook and the restart action.
// Exits quietly (code 0) when Telegram is simply not configured yet.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR } from "../lib/plugin-state.mjs";
import { configDir } from "../lib/telegram-config.mjs";
import { ownerPath, terminateVerifiedOwner } from "../lib/watcher-owner.mjs";

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const pidFile = ownerPath(STATE_DIR, "telegram.pid");
// Review F1 discipline applies here too: only signal a verified daemon.
terminateVerifiedOwner(pidFile, "telegram.mjs");

if (!existsSync(path.join(configDir(), ".env"))) {
  console.log(`telegram cockpit not configured (no .env in ${configDir()}); skipping`);
  process.exit(0);
}

const daemon = path.join(path.dirname(fileURLToPath(import.meta.url)), "telegram.mjs");
const logFile = path.join(STATE_DIR, "telegram.log");
const log = openSync(logFile, "a");
const child = spawn(process.execPath, [daemon], {
  detached: true,
  stdio: ["ignore", log, log],
  env: process.env,
});
child.unref();
writeFileSync(pidFile, `${JSON.stringify({ pid: child.pid, startedAt: Date.now(), script: "telegram.mjs" })}\n`, { mode: 0o600 });
console.log(`atomic.workflows telegram daemon started (pid ${child.pid}); log: ${logFile}`);
