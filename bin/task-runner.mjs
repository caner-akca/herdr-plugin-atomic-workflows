#!/usr/bin/env node
// Plugin-pane entrypoint for one managed task. Atomic owns the terminal;
// this wrapper only fixes its task/session identity and initial workflow.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolveTaskFromEnvironment, taskKickoff } from "../lib/task-launcher.mjs";

let task;
try {
  task = resolveTaskFromEnvironment();
} catch (error) {
  console.error(`atomic task runner: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

mkdirSync(task.sessions_dir, { recursive: true, mode: 0o700 });
mkdirSync(task.atomic_artifact_dir, { recursive: true, mode: 0o700 });

const atomic = process.env.ATOMIC_BIN_PATH || "atomic";
const args = [
  "--approve",
  "--session-dir", task.sessions_dir,
  "--session-id", task.atomic_session_id,
  "--name", task.title,
];
// Reopening an already-bound task must never launch a duplicate workflow.
if (!task.run_id) args.push(taskKickoff(task));

const child = spawn(atomic, args, {
  cwd: task.project_dir,
  env: {
    ...process.env,
    ATOMIC_WORKFLOW_ARTIFACT_DIR: task.atomic_artifact_dir,
  },
  stdio: "inherit",
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGHUP", () => forward("SIGHUP"));
child.on("error", (error) => {
  console.error(`could not start Atomic: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

