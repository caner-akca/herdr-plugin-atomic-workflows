#!/usr/bin/env node
// Plugin-pane entrypoint for one managed task. Atomic owns the terminal;
// this wrapper only fixes its task/session identity and initial workflow.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { resolveTaskFromEnvironment, TASK_SESSION_LEASH, taskKickoff } from "../lib/task-launcher.mjs";

// Pre-resolve diagnostics: if resolution fails the pane dies before anyone
// can read it, so record the observable environment first.
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const bootLog = (line) => {
  if (!stateDir) return;
  try { appendFileSync(path.join(stateDir, "task-runner-boot.log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {}
};
bootLog(`boot task=${process.env.ATOMIC_WORKFLOWS_TASK_ID ?? "(unset)"} cwd=${process.cwd()} stateDir=${stateDir ?? "(unset)"} tty=${process.stdout.isTTY === true}`);
let task;
try {
  task = resolveTaskFromEnvironment();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  bootLog(`resolve failed: ${message}`);
  console.error(`atomic task runner: ${message}`);
  process.exit(1);
}
bootLog(`resolved ${task.task_id}`);

mkdirSync(task.sessions_dir, { recursive: true, mode: 0o700 });
mkdirSync(task.atomic_artifact_dir, { recursive: true, mode: 0o700 });

const atomic = process.env.ATOMIC_BIN_PATH || "atomic";
const args = [
  "--approve",
  "--session-dir", task.sessions_dir,
  "--session-id", task.atomic_session_id,
  "--name", task.title,
  // Governance leash: the pane's main-chat session must never launch
  // follow-up workflows on its own (observed: an autonomous builtin `goal`
  // run after a workflow failure).
  "--append-system-prompt", TASK_SESSION_LEASH,
];
// Reopening an already-bound task must never launch a duplicate workflow.
if (!task.run_id) args.push(taskKickoff(task));

// Diagnostics: the pane can die before anyone reads it, so persist runner
// lifecycle and Atomic's stderr in the task control dir (runner.log).
const runnerLog = path.join(task.control_dir, "runner.log");
const log = (line) => {
  try { appendFileSync(runnerLog, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {}
};
log(`spawn ${atomic} ${JSON.stringify(args)} cwd=${task.project_dir} tty=${process.stdout.isTTY === true}`);
let stderrFd;
try { stderrFd = openSync(path.join(task.control_dir, "runner-stderr.log"), "a", 0o600); } catch {}
const child = spawn(atomic, args, {
  cwd: task.project_dir,
  env: {
    ...process.env,
    ATOMIC_WORKFLOW_ARTIFACT_DIR: task.atomic_artifact_dir,
  },
  stdio: ["inherit", "inherit", stderrFd ?? "inherit"],
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGHUP", () => forward("SIGHUP"));
child.on("error", (error) => {
  log(`spawn error: ${error.message}`);
  console.error(`could not start Atomic: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  log(`atomic exited code=${code} signal=${signal}`);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

