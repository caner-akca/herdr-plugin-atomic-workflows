#!/usr/bin/env node
// Long-running watcher daemon (spawned detached by start-watcher.mjs).
//
// Loop: list herdr agent panes -> group by cwd -> read each cwd's
// .atomic/workflows/status.json (written atomically by atomic when the
// workflow extension has { "statusFile": true }) -> fold active runs into
// two short metadata tokens per pane:
//   wf       = "<name>" or "N runs | <name>"
//   wf_stage = current running/awaiting stage
// Tokens carry a TTL as a dead-man's switch, so a dead watcher or crashed
// workflow can never leave stale sidebar text. An aggregate board state file
// is kept for the popup pane (board.mjs).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp/atomic-workflows-plugin";
const SOURCE = "plugin:atomic.workflows";
const POLL_MS = 2000;
const TTL_MS = 15000; // > 2 poll intervals: refreshed continuously while alive
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
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // torn reads are impossible (rename), but tolerate anyway
  }
}

function activeStage(run) {
  const stages = run.stages ?? [];
  return (
    stages.find((s) => s.status === "awaiting_input") ??
    stages.find((s) => s.status === "running") ??
    null
  );
}

function summarize(snapshot) {
  const active = (snapshot?.runs ?? []).filter((r) => ACTIVE.has(r.status));
  if (active.length === 0) return null;
  // Prefer a run that needs input; otherwise the most recently started.
  const needy = active.find((r) => (r.stages ?? []).some((s) => s.status === "awaiting_input"));
  const top =
    needy ?? [...active].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  const stage = activeStage(top);
  const prefix = active.length > 1 ? `${active.length} runs | ` : "";
  const wf = `${prefix}${top.name}`.slice(0, 78);
  const wfStage = stage
    ? `${stage.status === "awaiting_input" ? "needs input: " : ""}${stage.name} [${top.status}]`.slice(0, 78)
    : `[${top.status}]`.slice(0, 78);
  return { wf, wfStage, active };
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

function tick() {
  const panes = agentPanes();
  const byCwd = new Map();
  for (const p of panes) {
    const cwd = p.cwd || p.foreground_cwd;
    if (!cwd) continue;
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(p);
  }

  const board = { updatedAt: Date.now(), projects: [] };
  const live = new Set();

  for (const [cwd, cwdPanes] of byCwd) {
    const summary = summarize(readStatus(cwd));
    if (!summary) continue;
    board.projects.push({
      cwd,
      panes: cwdPanes.map((p) => p.pane_id),
      runs: summary.active.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        startedAt: r.startedAt,
        stages: (r.stages ?? []).map((s) => ({ name: s.name, status: s.status })),
      })),
    });
    for (const p of cwdPanes) {
      report(p.pane_id, summary.wf, summary.wfStage);
      live.add(p.pane_id);
    }
  }

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
