// Workflow history ledger: NDJSON journal under HERDR_PLUGIN_STATE_DIR/ledger.
//
// Why the plugin keeps its own ledger: atomic wipes status.json to runs:[]
// on every session_start and never rehydrates it, keeps no queryable run
// index, and cost/usage data (stage modelAttempts[].usage) exists ONLY in
// the live status.json — the watcher is the sole continuous observer, so it
// journals transitions before they are destroyed.
//
// One file per project cwd (hashed name), entries:
//   {t:"run.start", ts, cwd, runId, name, startedAt, origin, reobserved?}
//   {t:"stage.end", ts, cwd, runId, stage, stageId, status, durationMs,
//    model, cost, sessionFile, error?}
//   {t:"run.end",  ts, cwd, runId, status, endedAt, durationMs, usage,
//    stages:{completed,failed,skipped}, failureKind?, error?, synthetic?}
// "synthetic" run.end entries are the watcher's own verdicts: "lost" (run
// vanished from the file — session wipe or same-cwd clobber) and "dead"
// (F1's no-writes-while-running verdict). Dedupe is by runId via index.json,
// never atomic's version counter (it resets per process).

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { STATE_DIR } from "./plugin-state.mjs";

const LEDGER_DIR = path.join(STATE_DIR, "ledger");
const INDEX_PATH = path.join(LEDGER_DIR, "index.json");
const INDEX_MAX_RUNS = 2000;

function cwdKey(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

// index.json: runId -> {phase: "started"|"ended", ts} — restart-safe dedupe.
export function loadIndex() {
  try {
    return JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveIndex(index) {
  const ids = Object.keys(index);
  if (ids.length > INDEX_MAX_RUNS) {
    // Drop the oldest ended runs; never drop in-flight ones.
    const ended = ids.filter((id) => index[id].phase === "ended").sort((a, b) => (index[a].ts ?? 0) - (index[b].ts ?? 0));
    for (const id of ended.slice(0, ids.length - INDEX_MAX_RUNS)) delete index[id];
  }
  mkdirSync(LEDGER_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index));
}

export function appendEntry(cwd, entry) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  appendFileSync(
    path.join(LEDGER_DIR, `${cwdKey(cwd)}.ndjson`),
    `${JSON.stringify({ ts: Date.now(), cwd, ...entry })}\n`,
  );
}

// Sum a run's stage modelAttempts[].usage into one rollup. Cost is USD.
export function usageOfRun(run) {
  const total = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  for (const stage of run?.stages ?? []) {
    const u = usageOfStage(stage);
    for (const k of Object.keys(total)) total[k] += u[k];
  }
  return total;
}

export function usageOfStage(stage) {
  const total = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  for (const attempt of stage?.modelAttempts ?? []) {
    const u = attempt?.usage;
    if (!u) continue;
    for (const k of Object.keys(total)) total[k] += Number.isFinite(u[k]) ? u[k] : 0;
  }
  return total;
}

// Fold every ledger file into per-run history rows, newest first.
export function readHistory(limit = 100) {
  let files = [];
  try {
    files = readdirSync(LEDGER_DIR).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return [];
  }
  const runs = new Map(); // runId -> row (entries applied in ts order)
  const entries = [];
  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(path.join(LEDGER_DIR, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip torn/corrupt line
      }
    }
  }
  entries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  for (const e of entries) {
    if (!e.runId) continue;
    let row = runs.get(e.runId);
    if (!row) {
      row = { runId: e.runId, cwd: e.cwd, name: "?", status: "running", startedAt: null, endedAt: null, durationMs: null, usage: null, origin: null, synthetic: false, sessionFiles: [] };
      runs.set(e.runId, row);
    }
    if (e.t === "stage.end") {
      if (e.sessionFile) row.sessionFiles.push(e.sessionFile);
    } else if (e.t === "run.start") {
      row.name = e.name ?? row.name;
      row.startedAt = e.startedAt ?? row.startedAt;
      row.origin = e.origin ?? row.origin;
      if (e.reobserved) {
        row.status = "running";
        row.endedAt = null;
        row.synthetic = false;
      }
    } else if (e.t === "run.end") {
      row.status = e.status ?? row.status;
      row.endedAt = e.endedAt ?? e.ts;
      row.durationMs = e.durationMs ?? row.durationMs;
      row.usage = e.usage ?? row.usage;
      row.synthetic = Boolean(e.synthetic);
      row.failureKind = e.failureKind;
      row.error = e.error;
    }
  }
  return [...runs.values()]
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
    .slice(0, limit);
}
