#!/usr/bin/env node
// Long-running watcher daemon (spawned detached by start-watcher.mjs).
//
// Loop: load durable task manifests -> read each task-private
// .atomic/workflows/status.json -> reduce that exact task/run into short
// metadata tokens for its bound pane. Manually started sessions keep a
// compatibility path, but only when one pane owns a cwd.
//
// Managed tokens:
//   task      = issue/queue label
//   phase     = deterministic Atomic run/stage state
//   progress  = completed stages / total stages
//   attention = pending question, if any
//
// Legacy compatibility tokens:
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fmtCost, stagePrompt, taskLabel } from "../lib/display.mjs";
import { STATE_DIR } from "../lib/plugin-state.mjs";
import { appendEntry, loadIndex, saveIndex, usageOfRun, usageOfStage } from "../lib/ledger.mjs";
import { applyView, VIEW_MARKER } from "../lib/set-view.mjs";
import { subscribe } from "../lib/herdr-socket.mjs";
import {
  atomicWriteJson,
  isTerminalTask,
  listTasks,
  readCampaign,
  updateCampaign,
  updateTask,
} from "../lib/task-store.mjs";
import { liveness, rebindMovedTask, reduceTask, taskSummary } from "../lib/task-reducer.mjs";
import { claimOwner, ownerPath, stillOwner } from "../lib/watcher-owner.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const SOURCE = "plugin:atomic.workflows";
const POLL_MS = 2000; // reconciliation cadence while the event stream is down
const RECONCILE_MS = 10000; // cadence while events are flowing (also refreshes token TTLs)
const DEBOUNCE_MS = 150;
const TTL_MS = 15000; // > 2 poll intervals: refreshed continuously while alive
const ACTIVE = new Set(["pending", "running", "paused"]);
const RUN_TERMINAL = new Set(["completed", "skipped", "failed", "blocked", "killed", "cancelled"]);
const STAGE_TERMINAL = new Set(["completed", "failed", "skipped"]);

// Review F1: one watcher per state root, bound to one Herdr server.
// - The state dir must come from Herdr; a fallback dir would let watchers
//   from different servers collide invisibly.
// - Ownership: claim the owner file; if a newer watcher claims it, this one
//   exits within a pass. PIDs are never signalled unverified (start-watcher).
// - Server loss: when the owning server's socket stays gone, exit instead of
//   polling a dead server forever.
if (!process.env.HERDR_PLUGIN_STATE_DIR) {
  console.error("watcher requires HERDR_PLUGIN_STATE_DIR from Herdr; refusing the fallback state dir");
  process.exit(1);
}
mkdirSync(STATE_DIR, { recursive: true });
const boardPath = path.join(STATE_DIR, "board.json");
const OWNER_FILE = ownerPath(STATE_DIR);
const SERVER_SOCKET = process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), ".config", "herdr", "herdr.sock");
const SERVER_LOSS_EXIT_MS = 60_000;
claimOwner(OWNER_FILE, { pid: process.pid, startedAt: Date.now(), socket: SERVER_SOCKET, script: "watcher.mjs" });
let serverMissingSince = null;

function ownershipTick() {
  if (!stillOwner(OWNER_FILE, process.pid)) {
    console.error("a newer watcher claimed ownership; exiting");
    process.exit(0);
  }
  if (existsSync(SERVER_SOCKET)) {
    serverMissingSince = null;
  } else {
    serverMissingSince ??= Date.now();
    if (Date.now() - serverMissingSince > SERVER_LOSS_EXIT_MS) {
      console.error(`owning server socket ${SERVER_SOCKET} gone for ${SERVER_LOSS_EXIT_MS}ms; exiting`);
      process.exit(0);
    }
  }
}

// Review F10: per-task/pass failures are isolated and surfaced on the board
// instead of silently stopping every projection.
const health = [];
function recordHealth(scope, id, error) {
  health.push({ ts: Date.now(), scope, id, error: String(error?.message ?? error).slice(0, 200) });
  if (health.length > 20) health.splice(0, health.length - 20);
  try {
    appendFileSync(path.join(STATE_DIR, "watcher-health.log"), `${new Date().toISOString()} [${scope}] ${id}: ${String(error?.message ?? error).slice(0, 300)}\n`);
  } catch {
    // health logging must never take the watcher down
  }
}

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

function allPanes() {
  const out = herdr(["pane", "list"]);
  if (!out) return null;
  try {
    return JSON.parse(out).result.panes ?? [];
  } catch {
    return null;
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


function activeStage(run) {
  const stages = run.stages ?? [];
  return (
    stages.find((s) => s.status === "awaiting_input") ??
    stages.find((s) => s.status === "running") ??
    null
  );
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
  if (stage && stage.status === "awaiting_input") {
    const prompt = stagePrompt(stage, top);
    wfStage = `needs input: ${stage.name}${prompt ? ` — ${prompt.message}` : ""}`;
  } else if (stage) {
    wfStage = `${stage.name} [${top.status}]`;
  } else {
    wfStage = `[${top.status}]`;
  }
  // Review F2: age is only ever "quiet", never death.
  if (live === "stale") wfStage = `${wfStage.slice(0, 62)} (quiet ${Math.max(1, Math.round(statusAgeMs / 60000))}m?)`;
  wfStage = wfStage.slice(0, 78);
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

function reportTask(paneId, task) {
  const label = taskLabel(task);
  const attention = task.attention ? `INPUT: ${task.attention}` : "";
  herdr([
    "pane", "report-metadata", paneId,
    "--source", SOURCE,
    "--token", `task=${label}`,
    "--token", `phase=${String(task.phase ?? task.status).slice(0, 78)}`,
    "--token", `progress=${task.progress ?? ""}`,
    "--token", `attention=${attention.slice(0, 78)}`,
    // Keep the existing tokens useful for configurations from v0.7.
    "--token", `wf=${label}`,
    "--token", `wf_stage=${attention ? attention.slice(0, 78) : String(task.phase ?? task.status).slice(0, 78)}`,
    "--token", `wf_cost=${fmtCost(task.cost)}`,
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
    "--clear-token", "task",
    "--clear-token", "phase",
    "--clear-token", "progress",
    "--clear-token", "attention",
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
    }
    // Review F2: no synthetic "dead" verdicts from file age — quiet running
    // work stays running. Synthetic ends remain only for runs that actually
    // vanished from their file ("lost", below).
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

let cachedByCwd = new Map();
let cachedPaneIds = null;
const dirWatchers = new Map(); // cwd -> fs watcher on <cwd>/.atomic/workflows

// Watch each known project's workflows DIRECTORY (atomic writes status.json
// by temp+rename, so the file inode changes — the directory is the stable
// thing to watch). Errors drop the watcher; the next full pass recreates it.
function updateDirWatchers(byCwd) {
  for (const cwd of byCwd.keys()) {
    if (dirWatchers.has(cwd)) continue;
    const dir = path.join(cwd, ".atomic", "workflows");
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, () => scheduleQuick());
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
          // already closed
        }
        dirWatchers.delete(cwd);
      });
      dirWatchers.set(cwd, watcher);
    } catch {
      // dir vanished between check and watch; reconciliation retries
    }
  }
  for (const [cwd, watcher] of dirWatchers) {
    if (byCwd.has(cwd)) continue;
    try {
      watcher.close();
    } catch {
      // already closed
    }
    dirWatchers.delete(cwd);
  }
}

// Full pass: re-list agent panes (the expensive part), refresh watchers,
// then process. Quick pass: reprocess with the cached pane map — used for
// sub-second reaction to a status.json write.
function fullPass() {
  const panes = agentPanes();
  const tasks = listTasks();
  const managedPaneIds = new Set(tasks.map((task) => task.pane_id).filter(Boolean));
  const managedProjectDirs = new Set(tasks.map((task) => task.project_dir));
  const byCwd = new Map();
  for (const p of panes) {
    const cwd = p.cwd || p.foreground_cwd;
    if (!cwd) continue;
    // Managed task panes have their own identity/status path and are folded
    // below. Never let them fall back to the old cwd fan-out path.
    if (managedPaneIds.has(p.pane_id) || managedProjectDirs.has(cwd)) continue;
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd).push(p);
  }
  cachedByCwd = byCwd;
  const panesNow = allPanes();
  cachedPaneIds = panesNow ? new Set(panesNow.map((pane) => pane.pane_id)) : null;
  const watchedDirs = new Map(byCwd);
  for (const task of tasks) watchedDirs.set(task.project_dir, []);
  updateDirWatchers(watchedDirs);
  processPanes(byCwd, cachedPaneIds);
}

function quickPass() {
  processPanes(cachedByCwd, cachedPaneIds);
}

function patchDiffers(task, patch) {
  return Object.entries(patch).some(([key, value]) => JSON.stringify(task[key]) !== JSON.stringify(value));
}

function processPanes(byCwd, paneIds) {
  const now = Date.now();
  const board = { updatedAt: now, mode: eventsConnected ? "events" : "polling", tasks: [], projects: [], health: [...health] };
  const live = new Set();
  const awaitingNow = new Set();
  const wsAgg = new Map(); // workspace id -> {active, needy}

  // Durable tasks are reduced by task identity. Each has a private project
  // directory, so two runs against the same repository cannot overwrite one
  // another's status file.
  for (const original of listTasks()) {
    try {
    const paneExists = !original.pane_id || paneIds === null || paneIds.has(original.pane_id);
    const status = readStatus(original.project_dir);
    const reduced = reduceTask(original, status?.snap ?? null, { paneExists, statusMtimeMs: status?.mtimeMs, nowMs: now });
    if (status) ledgerTick(original.project_dir, status.snap.runs ?? [], reduced.liveness);
    let task = original;
    if (patchDiffers(original, reduced.patch)) task = updateTask(original.task_id, reduced.patch);

    if (task.kind === "issue-queue" && task.campaign_id && task.shortlist?.length) {
      try {
        const campaign = readCampaign(task.campaign_id);
        if (campaign.status === "ranking") updateCampaign(campaign.campaign_id, { status: "selecting" });
      } catch {
        // A missing campaign does not hide an otherwise recoverable task.
      }
    }

    board.tasks.push(taskSummary(task, reduced.run));
    if (!task.pane_id || !paneExists) continue;
    reportTask(task.pane_id, task);
    live.add(task.pane_id);
    if (!isTerminalTask(task)) {
      const agg = wsAgg.get(task.workspace_id) ?? { active: 0, needy: 0 };
      agg.active += 1;
      if (task.status === "needs-input") agg.needy += 1;
      wsAgg.set(task.workspace_id, agg);
    }
    if (task.status === "needs-input" && reduced.run) {
      notifyAwaiting(task.repo_root, [reduced.run], awaitingNow);
    }
    } catch (error) {
      recordHealth("task", original.task_id, error);
    }
  }

  for (const [cwd, cwdPanes] of byCwd) {
    try {
    // Legacy cwd monitoring remains available for manually started Atomic
    // sessions, but one status file cannot safely identify multiple panes.
    if (cwdPanes.length !== 1) continue;
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
    } catch (error) {
      recordHealth("project", cwd, error);
    }
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
  atomicWriteJson(boardPath, board);
}

// ── Scheduler ──────────────────────────────────────────────────────────────
// herdr pane events and fs.watch hits coalesce through one debounced timer;
// a full pass supersedes a queued quick pass. The reconciliation loop is the
// backstop for missed events AND the thing that refreshes token TTLs and
// re-evaluates wall-clock staleness — 10s while the event stream is up
// (TTL is 15s), 2s (the classic poll) while it is down.
let eventsConnected = false;
let pendingTimer = null;
let pendingFull = false;

function schedulePass(full) {
  if (full) pendingFull = true;
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const wasFull = pendingFull;
    pendingFull = false;
    try {
      if (wasFull) fullPass();
      else quickPass();
    } catch (error) {
      recordHealth("pass", wasFull ? "full" : "quick", error);
    }
  }, DEBOUNCE_MS);
}
const scheduleQuick = () => schedulePass(false);

function reconcileLoop() {
  ownershipTick();
  try {
    fullPass();
  } catch (error) {
    recordHealth("pass", "reconcile", error);
  }
  setTimeout(reconcileLoop, eventsConnected ? RECONCILE_MS : POLL_MS);
}

reconcileLoop();

subscribe(
  ["pane.created", "pane.closed", "pane.exited", "pane.agent_detected", "pane.moved"].map((type) => ({ type })),
  (event) => {
    if (event?.type === "pane.moved") {
      try {
        rebindMovedTask(listTasks(), event, updateTask);
      } catch (error) {
        recordHealth("event", "pane.moved", error);
      }
    }
    schedulePass(true);
  },
  (state) => {
    eventsConnected = state === "connected";
    schedulePass(true);
  },
);

// The workflows-only agent view is transient (dies with the herdr server):
// if the user had it on, reapply it every watcher start. Fail soft.
if (existsSync(VIEW_MARKER)) applyView().catch(() => {});
