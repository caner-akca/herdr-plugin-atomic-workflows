#!/usr/bin/env node
// One-shot launcher: kill any previous Telegram daemon, spawn a fresh
// detached one. Used as a plugin [[startup]] hook and the restart action.
// Exits quietly (code 0) when Telegram is simply not configured yet.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR } from "./plugin-state.mjs";
import { configDir } from "./telegram-config.mjs";

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const pidFile = path.join(STATE_DIR, "telegram.pid");

try {
  const oldPid = Number(readFileSync(pidFile, "utf8").trim());
  if (oldPid > 0) process.kill(oldPid, "SIGTERM");
} catch {
  // no previous daemon, or already gone
}

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
writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
console.log(`atomic.workflows telegram daemon started (pid ${child.pid}); log: ${logFile}`);
