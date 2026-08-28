// Watcher ownership (review F1): exactly one watcher may serve one state
// root. Ownership is a JSON owner file; the newest claimant wins and every
// older watcher notices within one pass and exits. PIDs are never signalled
// without verifying their command line still names our script, so a reused
// PID can never receive our SIGTERM.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function ownerPath(stateDir, name = "watcher.pid") {
  return path.join(stateDir, name);
}

/** Parse the owner file; tolerates the legacy bare-PID format. */
export function readOwner(file) {
  try {
    const raw = readFileSync(file, "utf8").trim();
    if (/^\d+$/.test(raw)) return { pid: Number(raw), legacy: true };
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? { ...parsed, pid } : null;
  } catch {
    return null;
  }
}

export function claimOwner(file, identity) {
  writeFileSync(file, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
}

/** True while the owner file still names this process. */
export function stillOwner(file, pid) {
  return readOwner(file)?.pid === pid;
}

export function processCommand(pid) {
  if (!Number.isInteger(pid) || pid < 1) return "";
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

/** Decide whether a recorded PID may be signalled: its live command line
 * must still name the expected script. */
export function verifiedPid(pid, scriptBasename) {
  const command = processCommand(pid);
  return command.includes(scriptBasename) ? { pid, command } : null;
}

/** TERM a previous owner only after verification; never guess. */
export function terminateVerifiedOwner(file, scriptBasename) {
  const owner = readOwner(file);
  if (!owner) return { action: "none" };
  const verified = verifiedPid(owner.pid, scriptBasename);
  if (!verified) return { action: "skipped-unverified", pid: owner.pid };
  try {
    process.kill(owner.pid, "SIGTERM");
    return { action: "terminated", pid: owner.pid };
  } catch {
    return { action: "already-gone", pid: owner.pid };
  }
}
