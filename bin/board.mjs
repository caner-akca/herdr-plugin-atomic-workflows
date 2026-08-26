#!/usr/bin/env node
// Popup board v2: renders the watcher's aggregate state with per-stage
// timing, models, prompts, and failure details.
// q / esc / ctrl+c closes; j/k or arrows scroll; g/G jump.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fmtCost, stagePrompt, tasksForWorkspace } from "./display.mjs";
import { STATE_DIR } from "./plugin-state.mjs";
import { readHistory, usageOfRun, usageOfStage } from "./ledger.mjs";
import { focusTask, launchSelectedIssues, launchSelectedReviews } from "./task-launcher.mjs";
import { readCampaign } from "./task-store.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const GH = process.env.GH_BIN_PATH || "gh";
const WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID || "";
const RUNS_ROOT = path.join(
  process.env.ATOMIC_WORKFLOW_ARTIFACT_DIR || path.join(os.homedir(), ".atomic", "workflows"),
  "runs",
);

// Deep-link targets ([1]..[9]): stage session transcripts and run transcript
// files, rebuilt on every active-view render. Digit keys open them in a
// viewer pane (new tab) via `herdr plugin pane open`.
let linkTargets = [];

let statusMsg = "";
let taskRows = []; // queue issue rows and durable task rows in render order
let taskCursor = 0;
const selectedIssues = new Set();
const selectedReviews = new Set();
const prCache = new Map();
const prErrors = new Map();
const prLoading = new Set();
const PR_CACHE_TTL_MS = 30_000;
const PR_FETCH_TIMEOUT_MS = 2_000;
let reviewRepoRoot = null;
let taskList = "issues";
let selectionCampaignId = null;

function launchIssues(campaignId, issues) {
  try {
    const launched = launchSelectedIssues(readCampaign(campaignId), issues);
    const created = launched.filter(({ existing }) => !existing).length;
    const reused = launched.length - created;
    selectedIssues.clear();
    statusMsg = `launched ${created} task${created === 1 ? "" : "s"}${reused ? ` · reused ${reused}` : ""}`;
  } catch (error) {
    statusMsg = `launch: ✗ ${error instanceof Error ? error.message : String(error)}`;
  }
  render();
}

function launchReviews(campaignId, prs) {
  try {
    const launched = launchSelectedReviews(readCampaign(campaignId), prs);
    const created = launched.filter(({ existing }) => !existing).length;
    const reused = launched.length - created;
    selectedReviews.clear();
    statusMsg = `launched ${created} review${created === 1 ? "" : "s"}${reused ? ` · reused ${reused}` : ""}`;
  } catch (error) {
    statusMsg = `launch: ✗ ${error instanceof Error ? error.message : String(error)}`;
  }
  render();
}
function pullRequests(repoRoot) {
  const cached = prCache.get(repoRoot);
  return {
    prs: cached?.prs ?? [],
    error: prErrors.get(repoRoot) ?? "",
    loading: prLoading.has(repoRoot),
    fetchedAt: cached?.fetchedAt ?? 0,
  };
}

function refreshPullRequests(repoRoot, { force = false } = {}) {
  if (!repoRoot || prLoading.has(repoRoot)) return;
  const cached = prCache.get(repoRoot);
  if (!force && cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return;

  prLoading.add(repoRoot);
  prErrors.delete(repoRoot);
  const child = spawn(GH, ["pr", "list", "--json", "number,title,author,isDraft", "--limit", "20"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let finished = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill(), PR_FETCH_TIMEOUT_MS);

  function finish({ prs, error = "" }) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    prLoading.delete(repoRoot);
    if (error) {
      // Errors are display state, never cache entries: pressing p can retry.
      prCache.delete(repoRoot);
      prErrors.set(repoRoot, error);
    } else {
      prErrors.delete(repoRoot);
      prCache.set(repoRoot, { prs, fetchedAt: Date.now() });
    }
    render();
  }
  child.on("error", (error) => finish({ prs: [], error: error.message }));
  child.on("close", (code, signal) => {
    if (code !== 0) {
      const reason = signal ? `gh pr list timed out after ${PR_FETCH_TIMEOUT_MS}ms` : stderr.trim() || "could not list PRs";
      finish({ prs: [], error: reason });
      return;
    }
    try {
      const prs = JSON.parse(stdout || "[]");
      if (!Array.isArray(prs)) throw new Error("gh pr list returned a non-array result");
      finish({ prs });
    } catch (error) {
      finish({ prs: [], error: error instanceof Error ? error.message : String(error) });
    }
  });
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
  launching: "…",
  "launch-failed": "✗",
  "needs-input": "?",
  "pane-gone": "○",
  stale: "?",
  dead: "✗",
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


function failureLine(x) {
  const bits = [];
  if (x.failureKind) bits.push(x.failureCode ? `${x.failureKind}/${x.failureCode}` : x.failureKind);
  if (x.error) bits.push(String(x.error).slice(0, 100));
  if (Number.isFinite(x.retryAfterMs)) bits.push(`retry in ${fmtDur(x.retryAfterMs)}`);
  if (x.resumable) bits.push("resumable");
  return bits.length ? bits.join(" · ") : null;
}

function projectLines(project, now, width, targets) {
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
    lines.push(`   ${GLYPH[run.status] ?? "?"} ${BOLD(run.name)} [${run.status}] ${DIM(dur)}${cost}${origin}${runLink}`);
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
let view = "tasks"; // "tasks" | "active" | "history"

function shortlistIssue(item) {
  return Number(item?.issue);
}

function recommended(item) {
  if (item?.recommended === true) return true;
  return /^(fix|fix-now|proceed|recommended|actionable|yes)$/i.test(String(item?.recommendation ?? "").trim());
}

function taskLines(board, width) {
  const lines = [];
  const rows = [];
  const tasks = tasksForWorkspace(board.tasks ?? [], WORKSPACE_ID)
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const ranking = tasks.find((task) => task.kind === "issue-queue");
  const queue = ranking?.shortlist?.length ? ranking : null;
  const managedTasks = tasks.filter((task) => task.kind === "issue-fix" || task.kind === "code-review");
  const reviewContext = ranking ?? tasks.find((task) => task.campaign_id && task.repo_root);
  reviewRepoRoot = reviewContext?.repo_root ?? null;
  const reviewList = taskList === "reviews" && reviewContext ? pullRequests(reviewContext.repo_root) : { prs: [], error: "", loading: false };
  const candidateCount = taskList === "reviews"
    ? reviewList.prs.filter((pr) => Number.isInteger(Number(pr.number))).length
    : (queue?.shortlist ?? []).filter((item) => Number.isInteger(shortlistIssue(item))).length;
  if (taskCursor >= candidateCount + managedTasks.length) taskCursor = Math.max(0, candidateCount + managedTasks.length - 1);

  if (taskList === "reviews") {
    lines.push(`${BOLD(" Open pull requests")} ${DIM("(p issues · space select · enter launch)")}`);
    if (!reviewContext) {
      lines.push(DIM("   start an issue campaign to establish the workspace repository"));
    } else if (reviewList.loading && reviewList.prs.length === 0) {
      lines.push(DIM("   loading open pull requests…"));
    } else if (reviewList.error) {
      lines.push(YELLOW(`   could not list PRs: ${reviewList.error}`));
    } else if (reviewList.prs.length === 0) {
      lines.push(DIM("   no open pull requests"));
    } else {
      const allowed = new Set(reviewList.prs.map((pr) => Number(pr.number)).filter(Number.isInteger));
      for (const pr of selectedReviews) if (!allowed.has(pr)) selectedReviews.delete(pr);
      for (const item of reviewList.prs) {
        const pr = Number(item.number);
        if (!Number.isInteger(pr)) continue;
        const row = { type: "review", campaignId: reviewContext.campaign_id, pr, line: lines.length };
        const cursor = rows.length === taskCursor ? "▸" : " ";
        const checked = selectedReviews.has(pr) ? "x" : " ";
        const author = item.author?.login ? ` · @${item.author.login}` : "";
        const draft = item.isDraft ? " · draft" : "";
        const title = String(item.title ?? "").slice(0, Math.max(10, width - 32));
        lines.push(`${cursor} [${checked}] PR #${pr}${draft}${author}  ${title}`);
        rows.push(row);
      }
    }
    lines.push("");
  } else if (queue) {
    if (selectionCampaignId !== queue.campaign_id) {
      selectedIssues.clear();
      selectionCampaignId = queue.campaign_id;
    }
    const allowedIssues = new Set(queue.shortlist.map(shortlistIssue).filter(Number.isInteger));
    for (const issue of selectedIssues) if (!allowedIssues.has(issue)) selectedIssues.delete(issue);
    lines.push(`${BOLD(" Issue shortlist")} ${DIM("(p reviews · space select · a recommended · enter launch)")}`);
    for (const item of queue.shortlist) {
      const issue = shortlistIssue(item);
      if (!Number.isInteger(issue)) continue;
      const row = { type: "issue", campaignId: queue.campaign_id, issue, item, line: lines.length };
      const cursor = rows.length === taskCursor ? "▸" : " ";
      const checked = selectedIssues.has(issue) ? "x" : " ";
      const score = Number.isFinite(Number(item.score)) ? ` ${Number(item.score).toFixed(1)}` : "";
      const tag = item.recommendation ? ` · ${item.recommendation}` : "";
      const os = Array.isArray(item.os) ? item.os.join("/") : Array.isArray(item.affected_platforms) ? item.affected_platforms.join("/") : "";
      const title = String(item.title ?? "").slice(0, Math.max(10, width - 38));
      lines.push(`${cursor} [${checked}] #${issue}${score}${tag}${os ? ` · ${os}` : ""}  ${title}`);
      rows.push(row);
    }
    lines.push("");
  } else if (ranking) {
    lines.push(`${BOLD(" Issue shortlist")}  ${GLYPH[ranking.status] ?? "·"} ${ranking.phase ?? ranking.status}`);
    if (ranking.attention) lines.push(YELLOW(`   ${ranking.attention}`));
    lines.push("");
  }

  lines.push(BOLD(" Tasks"));
  if (managedTasks.length === 0) {
    lines.push(DIM("   no managed tasks yet"));
  } else {
    for (const task of managedTasks) {
      const row = { type: "task", task, line: lines.length };
      const cursor = rows.length === taskCursor ? "▸" : " ";
      const glyph = GLYPH[task.status] ?? "·";
      const cost = fmtCost(task.cost);
      const meta = [task.phase ?? task.status, task.progress, cost].filter(Boolean).join(" · ");
      lines.push(`${cursor} ${glyph} ${BOLD(task.title ?? `#${task.target}`)}  ${DIM(meta)}`);
      if (task.attention) lines.push(YELLOW(`     ${String(task.attention).slice(0, Math.max(20, width - 7))}`));
      rows.push(row);
    }
  }
  if (!ranking && managedTasks.length === 0) lines.push("", DIM("  Start with the “Start issue campaign” plugin action."));
  if (rows.length) lines.push("", DIM("  enter: launch selected items / focus task · x: clear selection"));
  if (statusMsg) lines.push(`  ${YELLOW(statusMsg)}`);
  taskRows = rows;
  if (taskCursor >= rows.length) taskCursor = Math.max(0, rows.length - 1);
  return lines;
}

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
  const tabs =
    view === "tasks"
      ? "tasks — l: legacy runs · h: history"
      : view === "history"
        ? "history — b: tasks · l: legacy runs"
        : "legacy runs — b: tasks · h: history";
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
  let body;
  if (view === "history") {
    const targets = [];
    body = historyLines(now, width, targets);
    linkTargets = targets;
  } else if (view === "active") {
    const targets = [];
    body = (board.projects ?? []).flatMap((p) => projectLines(p, now, width, targets));
    if (body.length === 0) body.push(DIM("  no active legacy workflow runs"));
    linkTargets = targets;
    const hints = [];
    if (targets.length) hints.push(`[1-${targets.length}] transcript`);
    if (hints.length) body.push(DIM(`  ${hints.join(" · ")}`));
    if (statusMsg) body.push(`  ${YELLOW(statusMsg)}`);
  } else {
    linkTargets = [];
    body = taskLines(board, width);
  }
  lastBodyLen = body.length;
  const visible = Math.max(4, rows - 4);
  if (view === "tasks" && taskRows[taskCursor]) {
    const cursorLine = taskRows[taskCursor].line;
    if (cursorLine < offset) offset = cursorLine;
    else if (cursorLine >= offset + visible) offset = cursorLine - visible + 1;
  }
  offset = Math.max(0, Math.min(offset, body.length - visible));
  const slice = body.slice(offset, offset + visible);
  for (const line of slice) console.log(line);
  const above = offset > 0 ? `↑${offset} ` : "";
  const below = offset + visible < body.length ? `↓${body.length - offset - visible} ` : "";
  console.log(`  ${above}${below}${freshness}`);
}

render();
const timer = setInterval(() => {
  if (view === "tasks" && taskList === "reviews" && !prErrors.has(reviewRepoRoot)) {
    refreshPullRequests(reviewRepoRoot);
  }
  render();
}, 1000);
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
  if ((s === "j" || s === "\x1b[B") && view === "tasks" && taskRows.length) {
    taskCursor = Math.min(taskRows.length - 1, taskCursor + 1);
  }
  else if ((s === "k" || s === "\x1b[A") && view === "tasks" && taskRows.length) {
    taskCursor = Math.max(0, taskCursor - 1);
  }
  else if (s === "j" || s === "\x1b[B") offset += 1;
  else if (s === "k" || s === "\x1b[A") offset = Math.max(0, offset - 1);
  else if (s === "g") offset = 0;
  else if (s === "G") offset = Math.max(0, lastBodyLen - visible);
  else if (s === "h" && view !== "history") { view = "history"; offset = 0; }
  else if (s === "b" && view !== "tasks") { view = "tasks"; offset = 0; }
  else if (s === "l" && view !== "active") { view = "active"; offset = 0; }
  else if (view === "tasks" && s === "p") {
    taskList = taskList === "issues" ? "reviews" : "issues";
    taskCursor = 0;
    offset = 0;
    statusMsg = "";
    if (taskList === "reviews") refreshPullRequests(reviewRepoRoot, { force: true });
  }
  else if (view === "tasks" && s === " " && taskRows[taskCursor]?.type === "issue") {
    const issue = taskRows[taskCursor].issue;
    if (selectedIssues.has(issue)) selectedIssues.delete(issue);
    else if (selectedIssues.size < 5) selectedIssues.add(issue);
    else statusMsg = "campaign launch limit is 5 tasks";
  }
  else if (view === "tasks" && s === " " && taskRows[taskCursor]?.type === "review") {
    const pr = taskRows[taskCursor].pr;
    if (selectedReviews.has(pr)) selectedReviews.delete(pr);
    else if (selectedReviews.size < 5) selectedReviews.add(pr);
    else statusMsg = "campaign launch limit is 5 tasks";
  }
  else if (view === "tasks" && s === "a") {
    for (const row of taskRows) {
      if (selectedIssues.size >= 5) break;
      if (row.type === "issue" && recommended(row.item)) selectedIssues.add(row.issue);
    }
    statusMsg = selectedIssues.size === 5 ? "selected the first 5 recommended issues" : "selected recommended issues";
  }
  else if (view === "tasks" && s === "x") {
    if (taskList === "reviews") selectedReviews.clear();
    else selectedIssues.clear();
    statusMsg = "selection cleared";
  }
  else if (view === "tasks" && (s === "\r" || s === "\n") && taskRows[taskCursor]) {
    const row = taskRows[taskCursor];
    if (row.type === "task") {
      statusMsg = focusTask(row.task) ? `focused ${row.task.title}` : row.task.pane_id ? `could not focus ${row.task.title}` : "task pane is not available";
      render();
      return;
    }
    if (row.type === "review") {
      if (selectedReviews.size === 0) selectedReviews.add(row.pr);
      statusMsg = `launching ${selectedReviews.size} review${selectedReviews.size === 1 ? "" : "s"}…`;
      render();
      launchReviews(row.campaignId, [...selectedReviews]);
      return;
    }
    if (selectedIssues.size === 0) selectedIssues.add(row.issue);
    statusMsg = `launching ${selectedIssues.size} issue task${selectedIssues.size === 1 ? "" : "s"}…`;
    render();
    launchIssues(row.campaignId, [...selectedIssues]);
    return;
  }
  else if (s >= "1" && s <= "9" && linkTargets[Number(s) - 1]) {
    openViewer(linkTargets[Number(s) - 1]);
    return;
  }
  else return;
  render();
});
