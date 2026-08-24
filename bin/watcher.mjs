#!/usr/bin/env node
// Long-running watcher daemon (spawned detached by start-watcher.mjs).
//
// Loop: list herdr agent panes -> group by cwd -> read each cwd's
// .atomic/workflows/status.json (written atomically by atomic when the
// workflow extension has { "statusFile": true }) -> fold active runs into
// short metadata tokens per pane:
//   wf       = "<name>" or "N runs | <name>"
//   wf_stage = current running/awaiting stage (with the prompt text when
//              a stage awaits input, and a stale/dead marker when the
//              status file has stopped updating)
//   wf_cost  = accumulated USD cost of the top run (from modelAttempts usage)
// plus workspace-level rollups (wf_active / wf_needy) on Space rows.
// Tokens carry a TTL as a dead-man's switch, so a dead watcher or crashed
// workflow can never leave stale sidebar text. An aggregate board state file
// is kept for the popup pane (board.mjs), and every run's lifecycle is
// journaled to the NDJSON ledger (ledger.mjs) before atomic's session_start
// wipe can destroy it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendEntry, loadIndex, saveIndex, usageOfRun, usageOfStage } from "./ledger.mjs";
import { applyView, VIEW_MARKER } from "./set-view.mjs";

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
const ACTIVE = new Set(["pending", "running", "paused", "blocked"]);
const RUN_TERMINAL = new Set(["completed", "failed", "killed", "cancelled"]);
const STAGE_TERMINAL = new Set(["completed", "failed", "skipped"]);

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

function fmtCost(cost) {
  if (!Number.isFinite(cost) || cost <= 0) return "";
  return cost >= 10 ? `$${cost.toFixed(0)}` : `$${cost.toFixed(2)}`;
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
  const needyCount = active.filter((r) => (r.stages ?? []).some((s) => s.status === "awaiting_input")).length;
  const cost = fmtCost(usageOfRun(top).cost);
  return { wf, wfStage, cost, active, live, needyCount };
}

function report(paneId, summary) {
  herdr([
    "pane", "report-metadata", paneId,
    "--source", SOURCE,
    "--token", `wf=${summary.wf}`,
    "--token", `wf_stage=${summary.wfStage}`,
    // Empty value clears the key, so a run without usage drops the row.
    "--token", `wf_cost=${summary.cost}`,
    "--ttl-ms", String(TTL_MS),
  ]);
}

function clear(paneId) {
  herdr([
    "pane", "report-metadata", paneId,
    "--source", SOURCE,
    "--clear-token", "wf",
    "--clear-token", "wf_stage",
    "--clear-token", "wf_cost",
  ]);
}

function reportWorkspace(wsId, agg) {
  herdr([
    "workspace", "report-metadata", wsId,
    "--source", SOURCE,
    "--token", `wf_active=${agg.active} active wf`,
    "--token", `wf_needy=${agg.needy > 0 ? `${agg.needy} need input` : ""}`,
    "--ttl-ms", String(TTL_MS),
  ]);
}

function clearWorkspace(wsId) {
  herdr([
    "workspace", "report-metadata", wsId,
    "--source", SOURCE,
    "--clear-token", "wf_active",
    "--clear-token", "wf_needy",
  ]);
}

const reported = new Set(); // pane ids currently carrying our tokens
const reportedWs = new Set(); // workspace ids currently carrying rollup tokens
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

// ── Ledger tracking ────────────────────────────────────────────────────────
// tracked: runId -> { cwd, lastRun (full snapshot), stageStatus: Map,
// lastSeen }. ledgerIndex (persisted) dedupes run.start/run.end across
// watcher restarts. Stage-end entries are only journaled for transitions
// this watcher actually witnessed — run.end carries the aggregate anyway.
const tracked = new Map();
const ledgerIndex = loadIndex();
let indexDirty = false;

function runEndEntry(run, status, extra = {}) {
  const stages = { completed: 0, failed: 0, skipped: 0 };
  for (const s of run.stages ?? []) if (stages[s.status] !== undefined) stages[s.status] += 1;
  return {
    t: "run.end",
    runId: run.id,
    status,
    endedAt: run.endedAt ?? Date.now(),
    durationMs: run.durationMs ?? (Number.isFinite(run.startedAt) ? Date.now() - run.startedAt : null),
    usage: usageOfRun(run),
    stages,
    ...(run.failureKind ? { failureKind: run.failureKind } : {}),
    ...(run.error ? { error: String(run.error).slice(0, 300) } : {}),
    ...extra,
  };
}

function markEnded(run, cwd, status, extra = {}) {
  appendEntry(cwd, runEndEntry(run, status, extra));
  ledgerIndex[run.id] = { phase: "ended", ts: Date.now() };
  indexDirty = true;
  tracked.delete(run.id);
}

function ledgerTick(cwd, runs, live) {
  const present = new Set();
  for (const run of runs) {
    if (!run?.id) continue;
    present.add(run.id);
    let t = tracked.get(run.id);
    if (!t) {
      t = { cwd, lastRun: run, stageStatus: new Map(), lastSeen: Date.now() };
      for (const s of run.stages ?? []) t.stageStatus.set(s.id ?? s.name, s.status);
      tracked.set(run.id, t);
      const phase = ledgerIndex[run.id]?.phase;
      if (phase === undefined || (phase === "ended" && ACTIVE.has(run.status))) {
        appendEntry(cwd, {
          t: "run.start",
          runId: run.id,
          name: run.name,
          startedAt: run.startedAt,
          origin: run.origin,
          ...(phase === "ended" ? { reobserved: true } : {}),
        });
        ledgerIndex[run.id] = { phase: "started", ts: Date.now() };
        indexDirty = true;
      }
      continue; // first sight: don't emit stage.end for history we didn't witness
    }
    t.lastSeen = Date.now();
    t.lastRun = run;
    for (const s of run.stages ?? []) {
      const key = s.id ?? s.name;
      const prev = t.stageStatus.get(key);
      if (STAGE_TERMINAL.has(s.status) && prev !== undefined && !STAGE_TERMINAL.has(prev)) {
        appendEntry(cwd, {
          t: "stage.end",
          runId: run.id,
          stage: s.name,
          stageId: s.id,
          status: s.status,
          durationMs: s.durationMs ?? null,
          model: s.model ?? null,
          cost: usageOfStage(s).cost,
          sessionFile: s.sessionFile ?? null,
          ...(s.error ? { error: String(s.error).slice(0, 300) } : {}),
        });
      }
      t.stageStatus.set(key, s.status);
    }
    if (RUN_TERMINAL.has(run.status) && ledgerIndex[run.id]?.phase !== "ended") {
      markEnded(run, cwd, run.status);
    } else if (live === "dead" && run.status === "running" && ledgerIndex[run.id]?.phase !== "ended") {
      // F1's verdict as a synthetic terminal state: the file stopped
      // updating while claiming to run. If it later resumes, the run
      // reappears active and gets a reobserved run.start.
      markEnded(run, cwd, "dead", { synthetic: true });
    }
  }
  // Runs that vanished from this cwd's file (session_start wipe or same-cwd
  // clobber): journal what we last saw as a synthetic "lost" end.
  for (const [runId, t] of tracked) {
    if (t.cwd !== cwd || present.has(runId)) continue;
    if (ledgerIndex[runId]?.phase !== "ended" && ACTIVE.has(t.lastRun.status)) {
      markEnded(t.lastRun, cwd, "lost", { synthetic: true });
    } else {
      tracked.delete(runId);
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
  const wsAgg = new Map(); // workspace id -> {active, needy}

  for (const [cwd, cwdPanes] of byCwd) {
    const status = readStatus(cwd);
    if (!status) continue;
    const statusAgeMs = Math.max(0, now - status.mtimeMs);
    const summary = summarize(status.snap, statusAgeMs);
    // Ledger sees every run in the file — including freshly-terminal ones
    // that no longer count as active for tokens/board.
    ledgerTick(cwd, status.snap.runs ?? [], summary?.live ?? "fresh");
    if (!summary) continue;
    board.projects.push({
      cwd,
      panes: cwdPanes.map((p) => p.pane_id),
      liveness: summary.live,
      statusAgeMs,
      // Full run snapshots: board v2 renders stage timing, models, prompts,
      // failure taxonomy, and cost straight from atomic's StoreSnapshot.
      runs: summary.active,
      notices: status.snap.notices ?? [],
    });
    for (const p of cwdPanes) {
      report(p.pane_id, summary);
      live.add(p.pane_id);
    }
    // Roll up once per cwd into each workspace that shows it (a cwd with two
    // panes in one workspace counts once; two projects in one workspace sum).
    const wsIds = new Set(cwdPanes.map((p) => String(p.pane_id).split(":")[0]).filter(Boolean));
    for (const wsId of wsIds) {
      const agg = wsAgg.get(wsId) ?? { active: 0, needy: 0 };
      agg.active += summary.active.length;
      agg.needy += summary.needyCount;
      wsAgg.set(wsId, agg);
    }
    if (summary.live === "fresh") notifyAwaiting(cwd, summary.active, awaitingNow);
  }
  for (const key of notified) if (!awaitingNow.has(key)) notified.delete(key);

  // Explicitly clear panes/workspaces whose workflows just went quiet
  // (faster than TTL).
  for (const paneId of reported) if (!live.has(paneId)) clear(paneId);
  reported.clear();
  for (const paneId of live) reported.add(paneId);

  for (const [wsId, agg] of wsAgg) reportWorkspace(wsId, agg);
  for (const wsId of reportedWs) if (!wsAgg.has(wsId)) clearWorkspace(wsId);
  reportedWs.clear();
  for (const wsId of wsAgg.keys()) reportedWs.add(wsId);

  if (indexDirty) {
    saveIndex(ledgerIndex);
    indexDirty = false;
  }
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

// The workflows-only agent view is transient (dies with the herdr server):
// if the user had it on, reapply it every watcher start. Fail soft.
if (existsSync(VIEW_MARKER)) applyView().catch(() => {});
