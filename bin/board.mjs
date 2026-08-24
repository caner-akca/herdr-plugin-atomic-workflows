#!/usr/bin/env node
// Popup board v2: renders the watcher's aggregate state with per-stage
// timing, models, prompts, and failure details.
// q / esc / ctrl+c closes; j/k or arrows scroll; g/G jump.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

function projectLines(project, now, width) {
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
    lines.push(`   ${GLYPH[run.status] ?? "?"} ${BOLD(run.name)} [${run.status}] ${DIM(dur)}${origin}`);
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
      const meta = [stageDur, model].filter(Boolean).join(" · ");
      lines.push(`      ${GLYPH[stage.status] ?? "?"} ${stage.name} (${stage.status}) ${DIM(meta)}`);
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
  console.log(`${BOLD(" Atomic workflows ")} ${DIM("(q close · j/k scroll)")}\n`);
  if (!board) {
    console.log("  watcher state not found — is the watcher running?");
    console.log("  restart it via the plugin action: Restart workflow watcher");
    return;
  }
  // Age of the watcher's last write, not a session timer: the watcher rewrites
  // board.json every ~2s, so a healthy age oscillates 0-2s. Growth means the
  // watcher is dead.
  const age = Math.round((Date.now() - board.updatedAt) / 1000);
  const freshness =
    age > 5
      ? RED(`⚠ watcher stale — last update ${age}s ago (right-click → Restart workflow watcher)`)
      : DIM(`watcher live · refreshed ${age}s ago`);
  if (board.projects.length === 0) {
    console.log(`  no active workflow runs\n\n  ${freshness}`);
    return;
  }
  const now = Date.now();
  const body = board.projects.flatMap((p) => projectLines(p, now, width));
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
  else return;
  render();
});
