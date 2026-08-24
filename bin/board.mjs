#!/usr/bin/env node
// Popup board v2: renders the watcher's aggregate state with per-stage
// timing, models, prompts, and failure details.
// q / esc / ctrl+c closes; j/k or arrows scroll; g/G jump.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readHistory, usageOfRun, usageOfStage } from "./ledger.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const RUNS_ROOT = path.join(
  process.env.ATOMIC_WORKFLOW_ARTIFACT_DIR || path.join(os.homedir(), ".atomic", "workflows"),
  "runs",
);

// Deep-link targets ([1]..[9]): stage session transcripts and run transcript
// files, rebuilt on every active-view render. Digit keys open them in a
// viewer pane (new tab) via `herdr plugin pane open`.
let linkTargets = [];

// ── Control verbs (need the optional atomic integration installed) ────────
// Selected run gets a ▸ cursor (n cycles); p/r/i/Q send pause/resume/
// interrupt/quit through the watcher's bridge socket to the atomic session
// owning that project. Destructive verbs ask for the key twice.
let controlRuns = []; // {runId, name, cwd, status} in render order
let selIdx = 0;
let pendingVerb = null; // {verb, runId, until}
let statusMsg = "";

const BRIDGE_PATH = path.join(
  process.env.HERDR_PLUGIN_STATE_DIR || "/tmp/atomic-workflows-plugin",
  "bridge.sock",
);

function sendControl(verb, run) {
  const id = `board:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
  const sock = net.createConnection(BRIDGE_PATH);
  let buf = "";
  const done = (msg) => {
    statusMsg = msg;
    sock.destroy();
    render();
  };
  const timer = setTimeout(() => done(`${verb}: watcher not answering`), 7000);
  sock.on("error", () => {
    clearTimeout(timer);
    done(`${verb}: bridge socket unavailable — is the watcher running?`);
  });
  sock.on("connect", () =>
    sock.write(`${JSON.stringify({ type: "control", id, verb, runId: run.runId, cwd: run.cwd })}\n`),
  );
  sock.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    clearTimeout(timer);
    try {
      const msg = JSON.parse(buf.slice(0, nl));
      done(`${verb} ${run.name}: ${msg.ok ? "✓ " : "✗ "}${msg.message}`);
    } catch {
      done(`${verb}: bad bridge reply`);
    }
  });
}

function requestVerb(verb, destructive) {
  const run = controlRuns[selIdx];
  if (!run) return;
  if (destructive && !(pendingVerb?.verb === verb && pendingVerb.runId === run.runId && Date.now() < pendingVerb.until)) {
    pendingVerb = { verb, runId: run.runId, until: Date.now() + 3000 };
    statusMsg = `press ${verb === "quit" ? "Q" : "i"} again to confirm ${verb} of ${run.name}`;
    render();
    return;
  }
  pendingVerb = null;
  statusMsg = `${verb} ${run.name}…`;
  render();
  sendControl(verb, run);
}

function latestRunTranscript(runId) {
  const dir = path.join(RUNS_ROOT, String(runId).replace(/[^A-Za-z0-9._-]/g, "_"), "transcripts");
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    if (!files.length) return null;
    files.sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs);
    return path.join(dir, files[0]);
  } catch {
    return null;
  }
}

function linkMark(targets, file) {
  if (!file || targets.length >= 9) return "";
  targets.push(file);
  return DIM(` [${targets.length}]`);
}

function openViewer(file) {
  spawnSync(HERDR, [
    "plugin", "pane", "open",
    "--plugin", "atomic.workflows",
    "--entrypoint", "viewer",
    "--env", `VIEW_TARGET=${file}`,
  ], { timeout: 10000 });
}

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp/atomic-workflows-plugin";
const boardPath = path.join(STATE_DIR, "board.json");

const GLYPH = {
  running: "▶",
  awaiting_input: "⏸?",
  paused: "⏸",
  pending: "…",
  completed: "✓",
  failed: "✗",
  blocked: "⛔",
  killed: "✗",
  cancelled: "✗",
  skipped: "-",
};

const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function fmtModel(model) {
  if (!model) return "";
  return model.includes("/") ? model.split("/").pop() : model;
}

function fmtCost(cost) {
  if (!Number.isFinite(cost) || cost <= 0) return "";
  return cost >= 10 ? `$${cost.toFixed(0)}` : `$${cost.toFixed(2)}`;
}

// Elapsed for a run/stage: final duration when ended, wall-clock since start
// while live (atomic's own duration fields are authoritative once present).
function elapsed(x, now) {
  if (Number.isFinite(x?.durationMs)) return x.durationMs;
  if (Number.isFinite(x?.startedAt)) return now - x.startedAt;
  return NaN;
}

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

function failureLine(x) {
  const bits = [];
  if (x.failureKind) bits.push(x.failureCode ? `${x.failureKind}/${x.failureCode}` : x.failureKind);
  if (x.error) bits.push(String(x.error).slice(0, 100));
  if (Number.isFinite(x.retryAfterMs)) bits.push(`retry in ${fmtDur(x.retryAfterMs)}`);
  if (x.resumable) bits.push("resumable");
  return bits.length ? bits.join(" · ") : null;
}

function projectLines(project, now, width, targets, runsOut) {
  const lines = [];
  lines.push(`${BOLD(` ${path.basename(project.cwd)}`)}  ${DIM(project.cwd)}`);
  lines.push(DIM(`   panes: ${project.panes.join(", ")}`));
  if (project.liveness === "dead") {
    lines.push(RED(`   ⚠ dead? status file untouched for ${fmtDur(project.statusAgeMs)} — the runs below are the file's last words, not live state`));
  } else if (project.liveness === "stale") {
    lines.push(YELLOW(`   ⚠ stale? no status write for ${fmtDur(project.statusAgeMs)} (long silent turn, or a killed atomic)`));
  }
  for (const notice of project.notices ?? []) {
    const color = notice.level === "error" ? RED : notice.level === "warning" ? YELLOW : DIM;
    lines.push(color(`   ${notice.requiresAck && !notice.ackedAt ? "!" : "·"} ${String(notice.message).slice(0, width - 6)}`));
  }
  for (const run of project.runs) {
    const dur = fmtDur(elapsed(run, now));
    const origin = run.origin === "agent" ? DIM(" (agent-launched)") : "";
    const usage = usageOfRun(run);
    const cost = usage.cost > 0 ? DIM(` · ${fmtCost(usage.cost)} · ${usage.turns} turns`) : "";
    const runLink = linkMark(targets, latestRunTranscript(run.id));
    const runIdx = runsOut.length;
    runsOut.push({ runId: run.id, name: run.name, cwd: project.cwd, status: run.status });
    const cursor = runIdx === selIdx ? "▸" : " ";
    lines.push(` ${cursor} ${GLYPH[run.status] ?? "?"} ${BOLD(run.name)} [${run.status}] ${DIM(dur)}${cost}${origin}${runLink}`);
    const runFailed =
      run.failureKind || run.error || ["failed", "blocked", "killed", "cancelled"].includes(run.status);
    const runFailure = runFailed ? failureLine(run) : null;
    if (runFailure) lines.push(RED(`      ✗ ${runFailure}`));
    let pendingCount = 0;
    for (const stage of run.stages ?? []) {
      if (stage.status === "pending") {
        pendingCount += 1;
        continue;
      }
      const model = fmtModel(stage.model);
      const stageDur = fmtDur(elapsed(stage, now));
      const stageCost = fmtCost(usageOfStage(stage).cost);
      const meta = [stageDur, model, stageCost].filter(Boolean).join(" · ");
      const stageLink = linkMark(targets, stage.sessionFile && existsSync(stage.sessionFile) ? stage.sessionFile : null);
      lines.push(`      ${GLYPH[stage.status] ?? "?"} ${stage.name} (${stage.status}) ${DIM(meta)}${stageLink}`);
      if (stage.status === "awaiting_input") {
        const waitAge = Number.isFinite(stage.awaitingInputSince) ? ` — waiting ${fmtDur(now - stage.awaitingInputSince)}` : "";
        const prompt = stagePrompt(stage, run);
        if (prompt) {
          lines.push(YELLOW(`         Q: ${prompt.message.slice(0, width - 14)}${waitAge}`));
          if (prompt.choices.length) lines.push(YELLOW(`         choices: ${prompt.choices.join(" / ").slice(0, width - 18)}`));
        } else if (waitAge) {
          lines.push(YELLOW(`        ${waitAge.slice(3)}`));
        }
      }
      const stageFailure = stage.status === "failed" || stage.status === "blocked" ? failureLine(stage) : null;
      if (stageFailure) lines.push(RED(`         ${stageFailure.slice(0, width - 12)}`));
      if (stage.skippedReason) lines.push(DIM(`         skipped: ${String(stage.skippedReason).slice(0, width - 18)}`));
    }
    if (pendingCount > 0) lines.push(DIM(`      … ${pendingCount} pending`));
  }
  lines.push("");
  return lines;
}

let offset = 0;
let lastBodyLen = 0;
let view = "active"; // "active" | "history"

// History rows come from the plugin's own NDJSON ledger — the only durable
// record (atomic wipes status.json on session_start; cost exists nowhere
// else). Synthetic statuses (lost/dead) are the watcher's verdicts.
function historyLines(now, width, targets) {
  const rows = readHistory(200);
  if (rows.length === 0) return [DIM("  no journaled runs yet — history fills in as workflows run")];
  const lines = [];
  for (const row of rows) {
    // Deep link: prefer the run's rendered transcript, else the most recent
    // journaled stage session file that still exists on disk.
    const lastSession = [...(row.sessionFiles ?? [])].reverse().find((f) => existsSync(f));
    const link = linkMark(targets, latestRunTranscript(row.runId) ?? lastSession ?? null);
    const glyph = GLYPH[row.status] ?? (row.status === "lost" || row.status === "dead" ? "?" : "·");
    const dur = Number.isFinite(row.durationMs) ? fmtDur(row.durationMs) : "";
    const cost = fmtCost(row.usage?.cost);
    const when = row.endedAt ?? row.startedAt;
    const ago = Number.isFinite(when) ? `${fmtDur(now - when)} ago` : "";
    const verdict = row.synthetic ? DIM(" (watcher verdict)") : "";
    const failure = row.failureKind ? RED(` ${row.failureKind}`) : "";
    const meta = [dur, cost, ago].filter(Boolean).join(" · ");
    const color = row.status === "failed" || row.status === "dead" ? RED : row.status === "lost" ? DIM : (s) => s;
    lines.push(
      color(` ${glyph} ${BOLD(row.name)} [${row.status}]${failure}${verdict} ${DIM(meta)}  ${DIM(path.basename(row.cwd ?? ""))}`.slice(0, width + 40)) + link,
    );
  }
  if (targets.length) lines.push(DIM(`  [1-${targets.length}] open transcript in a new tab`));
  return lines;
}

function render() {
  const rows = process.stdout.rows || 24;
  const width = process.stdout.columns || 100;
  process.stdout.write("\x1b[2J\x1b[H");
  let board = null;
  if (existsSync(boardPath)) {
    try {
      board = JSON.parse(readFileSync(boardPath, "utf8"));
    } catch {
      board = null;
    }
  }
  const tabs = view === "history" ? "history — a: active runs" : "active — h: history";
  console.log(`${BOLD(" Atomic workflows ")} ${DIM(`[${tabs}] (q close · j/k scroll)`)}\n`);
  if (!board) {
    console.log("  watcher state not found — is the watcher running?");
    console.log("  restart it via the plugin action: Restart workflow watcher");
    return;
  }
  // Age of the watcher's last write, not a session timer: event-driven mode
  // reconciles every ~10s (plus instant event passes), polling mode every
  // ~2s. Growth past 15s means the watcher is dead.
  const age = Math.round((Date.now() - board.updatedAt) / 1000);
  const mode = board.mode === "events" ? "events" : "polling";
  const freshness =
    age > 15
      ? RED(`⚠ watcher stale — last update ${age}s ago (right-click → Restart workflow watcher)`)
      : DIM(`watcher live (${mode}) · refreshed ${age}s ago`);
  const now = Date.now();
  if (view === "active" && board.projects.length === 0) {
    console.log(`  no active workflow runs ${DIM("(h: history)")}\n\n  ${freshness}`);
    return;
  }
  let body;
  if (view === "history") {
    const targets = [];
    body = historyLines(now, width, targets);
    linkTargets = targets;
  } else {
    const targets = [];
    const runs = [];
    body = board.projects.flatMap((p) => projectLines(p, now, width, targets, runs));
    linkTargets = targets;
    controlRuns = runs;
    if (selIdx >= runs.length) selIdx = 0;
    const hints = [];
    if (targets.length) hints.push(`[1-${targets.length}] transcript`);
    if (runs.length) hints.push("n select · p/r pause/resume · i/Q interrupt/quit");
    if (hints.length) body.push(DIM(`  ${hints.join(" · ")}`));
    if (statusMsg) body.push(`  ${YELLOW(statusMsg)}`);
  }
  lastBodyLen = body.length;
  const visible = Math.max(4, rows - 4);
  offset = Math.max(0, Math.min(offset, body.length - visible));
  const slice = body.slice(offset, offset + visible);
  for (const line of slice) console.log(line);
  const above = offset > 0 ? `↑${offset} ` : "";
  const below = offset + visible < body.length ? `↓${body.length - offset - visible} ` : "";
  console.log(`  ${above}${below}${freshness}`);
}

render();
const timer = setInterval(render, 1000);

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (key) => {
  const s = String(key);
  if (s === "q" || s === "\x1b" || s === "\x03") {
    clearInterval(timer);
    process.stdout.write("\x1b[2J\x1b[H");
    process.exit(0);
  }
  const visible = Math.max(4, (process.stdout.rows || 24) - 4);
  if (s === "j" || s === "\x1b[B") offset += 1;
  else if (s === "k" || s === "\x1b[A") offset = Math.max(0, offset - 1);
  else if (s === "g") offset = 0;
  else if (s === "G") offset = Math.max(0, lastBodyLen - visible);
  else if (s === "h" && view !== "history") { view = "history"; offset = 0; }
  else if (s === "a" && view !== "active") { view = "active"; offset = 0; }
  else if (s >= "1" && s <= "9" && linkTargets[Number(s) - 1]) {
    openViewer(linkTargets[Number(s) - 1]);
    return;
  }
  else if (view === "active" && (s === "n" || s === "\t") && controlRuns.length) {
    selIdx = (selIdx + 1) % controlRuns.length;
    pendingVerb = null;
  }
  else if (view === "active" && s === "p") { requestVerb("pause", false); return; }
  else if (view === "active" && s === "r") { requestVerb("resume", false); return; }
  else if (view === "active" && s === "i") { requestVerb("interrupt", true); return; }
  else if (view === "active" && s === "Q") { requestVerb("quit", true); return; }
  else return;
  render();
});
