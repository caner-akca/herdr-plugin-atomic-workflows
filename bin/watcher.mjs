#!/usr/bin/env node
// Long-running watcher daemon (spawned detached by start-watcher.mjs).
//
// Loop: list herdr agent panes -> group by cwd -> read each cwd's
// .atomic/workflows/status.json (written atomically by atomic when the
// workflow extension has { "statusFile": true }) -> fold active runs into
// two short metadata tokens per pane:
//   wf       = "<name>" or "N runs | <name>"
//   wf_stage = current running/awaiting stage (with the prompt text when
//              a stage awaits input, and a stale/dead marker when the
//              status file has stopped updating)
// Tokens carry a TTL as a dead-man's switch, so a dead watcher or crashed
// workflow can never leave stale sidebar text. An aggregate board state file
// is kept for the popup pane (board.mjs).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp/atomic-workflows-plugin";
const SOURCE = "plugin:atomic.workflows";
const POLL_MS = 2000;
const TTL_MS = 15000; // > 2 poll intervals: refreshed continuously while alive
// Liveness of the status file itself. Atomic writes it on every store
// mutation but carries no heartbeat: a SIGKILLed atomic leaves
// status:"running" on disk forever, so file age is the only staleness
// signal. Thresholds are generous because a long silent LLM turn can
// legitimately go quiet for a while.
const STALE_MS = 45_000;
const DEAD_MS = 300_000;
const ACTIVE = new Set(["pending", "running", "paused"]);

mkdirSync(STATE_DIR, { recursive: true });
const boardPath = path.join(STATE_DIR, "board.json");

function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) return null;
  return r.stdout;
}

function agentPanes() {
  const out = herdr(["agent", "list"]);
  if (!out) return [];
  try {
    return JSON.parse(out).result.agents ?? [];
  } catch {
    return [];
  }
}

function readStatus(cwd) {
  const file = path.join(cwd, ".atomic", "workflows", "status.json");
  if (!existsSync(file)) return null;
  try {
    const snap = JSON.parse(readFileSync(file, "utf8"));
    const mtimeMs = statSync(file).mtimeMs;
    return { snap, mtimeMs };
  } catch {
    return null; // torn reads are impossible (rename), but tolerate anyway
  }
}

function liveness(ageMs) {
  if (ageMs > DEAD_MS) return "dead";
  if (ageMs > STALE_MS) return "stale";
  return "fresh";
}

function activeStage(run) {
  const stages = run.stages ?? [];
  return (
    stages.find((s) => s.status === "awaiting_input") ??
    stages.find((s) => s.status === "running") ??
    null
  );
}

// The question a stage is actually asking, from pendingPrompt (kinds
// input|confirm|select|editor) or inputRequest (ask_user_question /
// readiness_gate). Falls back to the run-level pendingPrompt.
function stagePrompt(stage, run) {
  const p = stage?.pendingPrompt ?? run?.pendingPrompt;
  if (p?.message) return { kind: p.kind ?? "input", message: p.message, choices: p.choices ?? [] };
  const q = stage?.inputRequest?.questions?.[0];
  if (q?.question) {
    return {
      kind: stage.inputRequest.kind ?? "ask_user_question",
      message: q.question,
      choices: (q.options ?? []).map((o) => o.label).filter(Boolean),
    };
  }
  return null;
}

function summarize(snapshot, statusAgeMs) {
  const active = (snapshot?.runs ?? []).filter((r) => ACTIVE.has(r.status));
  if (active.length === 0) return null;
  // Prefer a run that needs input; otherwise the most recently started.
  const needy = active.find((r) => (r.stages ?? []).some((s) => s.status === "awaiting_input"));
  const top =
    needy ?? [...active].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  const stage = activeStage(top);
  // Staleness only means anything while some run claims to be actively
  // executing: paused runs and awaiting_input stages legitimately stop all
  // store writes, so an old mtime there is expected quiet, not death.
  const expectsWrites = active.some(
    (r) => r.status === "running" && (r.stages ?? []).some((s) => s.status === "running"),
  );
  const live = expectsWrites ? liveness(statusAgeMs) : "fresh";
  const prefix = active.length > 1 ? `${active.length} runs | ` : "";
  const wf = `${prefix}${top.name}`.slice(0, 78);
  let wfStage;
  if (live === "dead") {
    // Phantom-running guard: the file claims a live run but nothing has
    // written it for a long time — do not present it as running.
    wfStage = `[dead? no writes ${Math.round(statusAgeMs / 60000)}m]`.slice(0, 78);
  } else {
    if (stage && stage.status === "awaiting_input") {
      const prompt = stagePrompt(stage, top);
      wfStage = `needs input: ${stage.name}${prompt ? ` — ${prompt.message}` : ""}`;
    } else if (stage) {
      wfStage = `${stage.name} [${top.status}]`;
    } else {
      wfStage = `[${top.status}]`;
    }
    if (live === "stale") wfStage = `${wfStage.slice(0, 68)} (stale?)`;
    wfStage = wfStage.slice(0, 78);
  }
  return { wf, wfStage, active, live };
}

function report(paneId, wf, wfStage) {
  herdr([
    "pane", "report-metadata", paneId,
    "--source", SOURCE,
    "--token", `wf=${wf}`,
    "--token", `wf_stage=${wfStage}`,
    "--ttl-ms", String(TTL_MS),
  ]);
}

function clear(paneId) {
  herdr([
    "pane", "report-metadata", paneId,
    "--source", SOURCE,
    "--clear-token", "wf",
    "--clear-token", "wf_stage",
  ]);
}

const reported = new Set(); // pane ids currently carrying our tokens
const notified = new Set(); // "runId:stage" keys already toasted while still awaiting input

// System toast (routed through herdr's configured notification delivery) the
// first tick a stage is seen awaiting input, carrying the actual question so
// "can I ignore this?" is answerable from the toast. Keys re-arm when the
// stage moves on. In-memory only: a watcher restart re-toasts still-waiting
// stages once, which is a feature. Suppressed for stale/dead status files —
// old news must not ping.
function notifyAwaiting(cwd, activeRuns, awaitingNow) {
  for (const run of activeRuns) {
    for (const stage of run.stages ?? []) {
      if (stage.status !== "awaiting_input") continue;
      const key = `${run.id}:${stage.name}`;
      awaitingNow.add(key);
      if (notified.has(key)) continue;
      notified.add(key);
      const prompt = stagePrompt(stage, run);
      const detail = prompt ? ` — ${prompt.message}` : "";
      herdr([
        "notification", "show", "workflow needs input",
        "--body", `${run.name}: ${stage.name}${detail} (${path.basename(cwd)})`.slice(0, 220),
        "--sound", "request",
      ]);
    }
  }
}

function tick() {
  const panes = agentPanes();
  const byCwd = new Map();
  for (const p of panes) {
    const cwd = p.cwd || p.foreground_cwd;
    if (!cwd) continue;
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(p);
  }

  const now = Date.now();
  const board = { updatedAt: now, projects: [] };
  const live = new Set();
  const awaitingNow = new Set();

  for (const [cwd, cwdPanes] of byCwd) {
    const status = readStatus(cwd);
    if (!status) continue;
    const statusAgeMs = Math.max(0, now - status.mtimeMs);
    const summary = summarize(status.snap, statusAgeMs);
    if (!summary) continue;
    board.projects.push({
      cwd,
      panes: cwdPanes.map((p) => p.pane_id),
      liveness: summary.live,
      statusAgeMs,
      // Full run snapshots: board v2 renders stage timing, models, prompts,
      // and failure taxonomy straight from atomic's StoreSnapshot fields.
      runs: summary.active,
      notices: status.snap.notices ?? [],
    });
    for (const p of cwdPanes) {
      report(p.pane_id, summary.wf, summary.wfStage);
      live.add(p.pane_id);
    }
    if (summary.live === "fresh") notifyAwaiting(cwd, summary.active, awaitingNow);
  }
  for (const key of notified) if (!awaitingNow.has(key)) notified.delete(key);

  // Explicitly clear panes whose workflows just went quiet (faster than TTL).
  for (const paneId of reported) if (!live.has(paneId)) clear(paneId);
  reported.clear();
  for (const paneId of live) reported.add(paneId);

  writeFileSync(boardPath, JSON.stringify(board, null, 2));
}

setInterval(() => {
  try {
    tick();
  } catch {
    // keep the daemon alive; next tick retries
  }
}, POLL_MS);
tick();
