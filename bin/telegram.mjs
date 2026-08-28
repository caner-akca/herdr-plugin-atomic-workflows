#!/usr/bin/env node
// Telegram cockpit daemon: long-polls the Bot API, answers a closed command
// grammar with board/ledger/artifact data, pushes run events, launches tasks
// only after inline-button confirmation, and records maintainer decisions
// without executing anything on them. No model calls, no shell passthrough.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./plugin-state.mjs";
import { readHistory } from "./ledger.mjs";
import { createCampaign } from "./task-store.mjs";
import { launchIssueTask, launchQueueTask, launchReviewTask } from "./task-launcher.mjs";
import { loadTelegramConfig, roleOf } from "./telegram-config.mjs";
import { createApi } from "./telegram-api.mjs";
import {
  authorize,
  DECISIONS,
  decisionCallback,
  HELP_TEXT,
  launchCallback,
  parseCallback,
  parseCommand,
} from "./telegram-commands.mjs";
import {
  fmtArtifacts,
  fmtCostRollup,
  fmtDecision,
  fmtHistory,
  fmtPush,
  fmtStatus,
  fmtTask,
  pushKey,
} from "./telegram-format.mjs";
import {
  assembleHandoff,
  assertServableArtifact,
  findNamedArtifact,
  listArtifacts,
  renderGif,
  stagedDiff,
} from "./telegram-artifacts.mjs";

const TG_DIR = path.join(STATE_DIR, "telegram");
const STATE_FILE = path.join(TG_DIR, "state.json");
const DECISIONS_FILE = path.join(TG_DIR, "decisions.ndjson");
const STRANGERS_FILE = path.join(TG_DIR, "strangers.log");
const BOARD_FILE = path.join(STATE_DIR, "board.json");
const SEEN_CAP = 800;
const LAUNCH_NONCE_TTL_MS = 10 * 60_000;

mkdirSync(TG_DIR, { recursive: true, mode: 0o700 });

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { offset: 0, seen: [], pendingLaunches: {}, digests: {}, muted: false };
  }
}

const state = loadState();
state.seen = Array.isArray(state.seen) ? state.seen : [];
state.pendingLaunches = state.pendingLaunches ?? {};
state.digests = state.digests ?? {};
const seen = new Set(state.seen);
let halted = false;

function saveState() {
  state.seen = [...seen].slice(-SEEN_CAP);
  writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

let config;
try {
  config = loadTelegramConfig();
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}
const api = createApi({ token: config.token, baseUrl: process.env.TELEGRAM_API_BASE || undefined });

function readBoard() {
  try {
    return JSON.parse(readFileSync(BOARD_FILE, "utf8"));
  } catch {
    return { updatedAt: 0, mode: "missing", tasks: [] };
  }
}

function repoRootOrExplain() {
  if (config.repoRoot && existsSync(config.repoRoot)) return config.repoRoot;
  const fromBoard = readBoard().tasks?.[0]?.repo_root;
  if (fromBoard && existsSync(fromBoard)) return fromBoard;
  throw new Error("no repository configured: set repo_root in telegram.json");
}

function resolveNumber(action, board) {
  if (action.issue) return action.issue;
  const task = board.tasks?.[action.taskIndex - 1];
  if (!task) throw new Error(`no task t${action.taskIndex}; see /status`);
  const target = Number(task.target);
  if (!Number.isInteger(target) || target < 1) throw new Error(`task t${action.taskIndex} has no issue/PR number`);
  return target;
}

function recordDecision(record) {
  appendFileSync(DECISIONS_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function notifyOwner(text) {
  if (config.cockpitChatId) await api.sendMessage(config.cockpitChatId, text);
}

// ── command handling ──────────────────────────────────────────────────────

async function sendNamedFile(chatId, repoRoot, number, names, label) {
  const item = findNamedArtifact(repoRoot, number, names);
  if (!item) return api.sendMessage(chatId, `no ${label} found for #${number}`);
  return api.sendDocument(chatId, assertServableArtifact(repoRoot, item.path), `#${number} ${item.name}`);
}

async function handleCommand(chatId, from, action) {
  const board = readBoard();
  switch (action.command) {
    case "help":
      return api.sendMessage(chatId, HELP_TEXT);
    case "status":
      return api.sendMessage(chatId, fmtStatus(board));
    case "runs":
      return api.sendMessage(chatId, fmtHistory(readHistory().filter((row) => row.status === "running"), 20) + (halted ? "\n(halted: launches disabled until restart)" : ""));
    case "history":
      return api.sendMessage(chatId, fmtHistory([...readHistory()].reverse()));
    case "cost":
      return api.sendMessage(chatId, fmtCostRollup(readHistory()));
    case "task": {
      const index = action.taskIndex ?? (board.tasks ?? []).findIndex((task) => Number(task.target) === action.issue) + 1;
      const task = board.tasks?.[index - 1];
      if (!task) return api.sendMessage(chatId, "no matching task; see /status");
      return api.sendMessage(chatId, fmtTask(task, index - 1));
    }
    case "artifacts": {
      const repoRoot = repoRootOrExplain();
      const number = resolveNumber(action, board);
      const items = listArtifacts(repoRoot, number);
      state.artifactMap = { number, ids: Object.fromEntries(items.map((item) => [item.id, item.path])) };
      saveState();
      return api.sendMessage(chatId, fmtArtifacts(number, items));
    }
    case "get": {
      const repoRoot = repoRootOrExplain();
      const file = state.artifactMap?.ids?.[`a${action.artifactIndex}`];
      if (!file) return api.sendMessage(chatId, "unknown artifact id; run /artifacts first");
      return api.sendDocument(chatId, assertServableArtifact(repoRoot, file), path.basename(file));
    }
    case "report":
      return sendNamedFile(chatId, repoRootOrExplain(), resolveNumber(action, board), ["report.md"], "report");
    case "evidence":
      return sendNamedFile(chatId, repoRootOrExplain(), resolveNumber(action, board), ["integration-evidence.md"], "integration evidence");
    case "driver":
      return sendNamedFile(chatId, repoRootOrExplain(), resolveNumber(action, board), ["repro-driver.json"], "replay driver");
    case "diff": {
      const repoRoot = repoRootOrExplain();
      const number = resolveNumber(action, board);
      const result = stagedDiff(repoRoot, number);
      if (result.error) return api.sendMessage(chatId, result.error);
      if (!result.diff.trim()) return api.sendMessage(chatId, `the #${number} worktree has no staged change`);
      const diffPath = path.join(TG_DIR, `diff-${number}.patch`);
      writeFileSync(diffPath, result.diff, { mode: 0o600 });
      return api.sendDocument(chatId, diffPath, `#${number} staged diff (${result.worktree})`);
    }
    case "gif": {
      const repoRoot = repoRootOrExplain();
      const number = resolveNumber(action, board);
      const rendered = renderGif(repoRoot, number, action.which, TG_DIR);
      if (rendered.gifPath) return api.sendAnimation(chatId, rendered.gifPath, `#${number} ${action.which}`);
      if (rendered.castPath) {
        await api.sendMessage(chatId, `GIF conversion unavailable (${rendered.error}); sending the raw cast`);
        return api.sendDocument(chatId, assertServableArtifact(repoRoot, rendered.castPath), `#${number} ${action.which}.cast`);
      }
      return api.sendMessage(chatId, rendered.error);
    }
    case "mute":
      state.muted = true;
      saveState();
      return api.sendMessage(chatId, "pushes muted (/unmute to restore)");
    case "unmute":
      state.muted = false;
      saveState();
      return api.sendMessage(chatId, "pushes on");
    case "halt":
      halted = true;
      return api.sendMessage(chatId, "halted: launch and handoff are disabled until the daemon restarts");
    case "queue": case "fix": case "review": {
      if (halted) return api.sendMessage(chatId, "halted; restart the daemon at the Mac to re-enable launches");
      if (!config.enableLaunch) return api.sendMessage(chatId, "launching is disabled in telegram.json");
      repoRootOrExplain(); // fail early with the config hint
      const number = action.command === "queue" ? action.size : action.number;
      const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex");
      state.pendingLaunches[nonce] = { kind: action.command, number, expires: Date.now() + LAUNCH_NONCE_TTL_MS, confirms: action.command === "fix" ? 2 : 1 };
      saveState();
      const what = action.command === "queue"
        ? `rank the issue queue (shortlist ${number})`
        : action.command === "fix"
          ? `run the FULL fix pipeline for issue #${number} (hours of compute + model spend)`
          : `review PR #${number}`;
      return api.sendMessage(chatId, `Confirm: ${what}?`, {
        replyMarkup: { inline_keyboard: [[{ text: action.command === "fix" ? "Confirm (1/2)" : "Confirm", callback_data: launchCallback(action.command, number, nonce) }]] },
      });
    }
    case "handoff": {
      if (halted) return api.sendMessage(chatId, "halted; restart the daemon to re-enable handoff");
      if (!config.maintainerChatId) return api.sendMessage(chatId, "no maintainer chat configured (TELEGRAM_MAINTAINER_CHAT_ID)");
      const repoRoot = repoRootOrExplain();
      const digest = assembleHandoff(repoRoot, action.number, (file) => readFileSync(file, "utf8"));
      if (digest.error) return api.sendMessage(chatId, digest.error);
      const message = await api.sendMessage(config.maintainerChatId, digest.summary, {
        replyMarkup: { inline_keyboard: [DECISIONS.map((decision) => ({ text: decision, callback_data: decisionCallback(action.number, decision) }))] },
      });
      state.digests[String(message.message_id)] = action.number;
      saveState();
      for (const file of digest.files) await api.sendDocument(config.maintainerChatId, assertServableArtifact(repoRoot, file), path.basename(file));
      const gif = renderGif(repoRoot, action.number, "repro", TG_DIR);
      if (gif.gifPath) await api.sendAnimation(config.maintainerChatId, gif.gifPath, `#${action.number} reproduction`);
      const diff = stagedDiff(repoRoot, action.number);
      if (!diff.error && diff.diff.trim()) {
        const diffPath = path.join(TG_DIR, `handoff-diff-${action.number}.patch`);
        writeFileSync(diffPath, diff.diff, { mode: 0o600 });
        await api.sendDocument(config.maintainerChatId, diffPath, `#${action.number} proposed change`);
      }
      return api.sendMessage(chatId, `handed #${action.number} to the maintainer chat`);
    }
    default:
      return api.sendMessage(chatId, HELP_TEXT);
  }
}

async function executeLaunch(kind, number) {
  const repoRoot = repoRootOrExplain();
  const campaign = createCampaign({ repoRoot, workspaceId: "telegram", shortlistSize: kind === "queue" ? number : 15 });
  if (kind === "queue") {
    const task = launchQueueTask(campaign, { focus: false });
    return `queue task started (${task.task_id.slice(0, 8)}); shortlist arrives on the board and /status`;
  }
  if (kind === "fix") {
    const { task, existing } = launchIssueTask({ campaign, issue: number, focus: false });
    return existing ? `#${number} already has an open task (${task.task_id.slice(0, 8)})` : `fix pipeline started for #${number} (${task.task_id.slice(0, 8)})`;
  }
  const { task, existing } = launchReviewTask({ campaign, pr: number, focus: false });
  return existing ? `PR #${number} already has an open review task` : `review started for PR #${number} (${task.task_id.slice(0, 8)})`;
}

async function handleCallback(query) {
  const parsed = parseCallback(query.data);
  const chatId = query.message?.chat?.id;
  if (parsed.type === "launch") {
    if (roleOf(config, query.from?.id) !== "owner") return api.answerCallbackQuery(query.id, "owner only");
    const pending = state.pendingLaunches[parsed.nonce];
    if (!pending || pending.expires < Date.now() || pending.kind !== parsed.kind || pending.number !== parsed.number) {
      return api.answerCallbackQuery(query.id, "expired; resend the command");
    }
    if (halted) return api.answerCallbackQuery(query.id, "halted");
    pending.confirms -= 1;
    if (pending.confirms > 0) {
      saveState();
      await api.answerCallbackQuery(query.id, "one more confirmation");
      return api.sendMessage(chatId, `Really start the fix pipeline for #${parsed.number}? This spends real model budget.`, {
        replyMarkup: { inline_keyboard: [[{ text: "Yes, run it (2/2)", callback_data: launchCallback(parsed.kind, parsed.number, parsed.nonce) }]] },
      });
    }
    delete state.pendingLaunches[parsed.nonce];
    saveState();
    await api.answerCallbackQuery(query.id, "launching");
    try {
      return await api.sendMessage(chatId, await executeLaunch(parsed.kind, parsed.number));
    } catch (error) {
      return api.sendMessage(chatId, `launch failed: ${String(error?.message ?? error).slice(0, 300)}`);
    }
  }
  if (parsed.type === "decision") {
    // Decisions are only ever recorded, never executed. Authorization is the
    // maintainer chat itself: the button lives on a digest this daemon posted.
    const digestIssue = state.digests[String(query.message?.message_id ?? "")];
    if (chatId !== config.maintainerChatId || digestIssue !== parsed.issue) {
      return api.answerCallbackQuery(query.id, "not a live handoff message");
    }
    const record = {
      ts: Date.now(),
      issue: parsed.issue,
      decision: parsed.decision,
      from: `${query.from?.username ?? query.from?.first_name ?? "?"} (${query.from?.id ?? "?"})`,
    };
    recordDecision(record);
    await api.answerCallbackQuery(query.id, `recorded: ${parsed.decision}`);
    await api.sendMessage(chatId, `Recorded your decision on #${parsed.issue}: ${parsed.decision}. Reply to the handoff message to add rationale.`);
    return notifyOwner(fmtDecision(record));
  }
  return api.answerCallbackQuery(query.id, "unknown");
}

async function handleMessage(message) {
  const from = message.from ?? {};
  const chatId = message.chat?.id;
  // Maintainer rationale: any reply to a digest message in the maintainer chat.
  const repliedTo = String(message.reply_to_message?.message_id ?? "");
  if (chatId === config.maintainerChatId && state.digests[repliedTo] !== undefined) {
    const record = {
      ts: Date.now(),
      issue: state.digests[repliedTo],
      decision: "rationale",
      rationale: String(message.text ?? "").slice(0, 2000),
      from: `${from.username ?? from.first_name ?? "?"} (${from.id ?? "?"})`,
    };
    recordDecision(record);
    return notifyOwner(fmtDecision(record));
  }
  const role = roleOf(config, from.id);
  if (!role) {
    appendFileSync(STRANGERS_FILE, `${new Date().toISOString()} id=${from.id} name=${JSON.stringify(from.username ?? from.first_name ?? "")}\n`, { mode: 0o600 });
    if (config.users.length === 0) {
      return api.sendMessage(chatId, `Not configured yet. Your Telegram id is ${from.id}; add it to telegram.json users to enable the cockpit.`);
    }
    return; // configured: strangers get silence
  }
  const action = parseCommand(message.text);
  if (action.error) return api.sendMessage(chatId, `${action.error}\n\n${HELP_TEXT}`);
  if (!authorize(role, action.command)) return api.sendMessage(chatId, `/${action.command} needs the owner role`);
  try {
    return await handleCommand(chatId, from, action);
  } catch (error) {
    return api.sendMessage(chatId, `error: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

// ── push events ───────────────────────────────────────────────────────────

function collectPushEvents() {
  const events = [];
  const board = readBoard();
  for (const task of board.tasks ?? []) {
    const label = task.title ?? task.task_id ?? "task";
    for (const run of task.runs ?? []) {
      if (config.push.run_start) {
        events.push({ type: "run_start", runId: run.runId ?? run.id ?? `${task.task_id}:${run.name ?? ""}`, name: run.name, task: label });
      }
      for (const stage of run.stages ?? []) {
        if (stage.status === "awaiting_input" && config.push.awaiting_input) {
          const prompt = stage.pendingPrompt ?? run.pendingPrompt ?? {};
          events.push({
            type: "awaiting_input", runId: run.runId ?? run.id ?? task.task_id, stage: stage.name,
            task: label, message: prompt.message ?? task.attention ?? stage.name, choices: prompt.choices ?? [],
          });
        }
      }
    }
    if (config.push.blocked && ["failed", "blocked", "dead", "launch-failed"].includes(String(task.status))) {
      events.push({ type: "blocked", runId: task.task_id, status: task.status, task: label, detail: task.attention });
    }
  }
  if (config.push.run_end) {
    for (const row of readHistory()) {
      if (row.status === "running" || !row.endedAt) continue;
      events.push({
        type: "run_end", runId: row.runId, status: row.status, name: row.name,
        durationMs: row.durationMs, cost: row.usage?.cost ?? 0,
      });
    }
  }
  return events;
}

async function scanPushes() {
  if (state.muted || !config.cockpitChatId) return;
  for (const event of collectPushEvents()) {
    const key = pushKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await api.sendMessage(config.cockpitChatId, fmtPush(event));
    } catch (error) {
      console.error(`push failed: ${String(error?.message ?? error)}`);
    }
  }
  saveState();
}

// ── main loop ─────────────────────────────────────────────────────────────

let running = true;
process.on("SIGTERM", () => {
  running = false;
});
process.on("SIGINT", () => {
  running = false;
});

// On first start, treat everything already in the ledger/board as seen so a
// fresh daemon does not replay weeks of history into the chat.
if (!state.primed) {
  for (const event of collectPushEvents()) seen.add(pushKey(event));
  state.primed = true;
  saveState();
}

console.log(`telegram cockpit daemon up (users: ${config.users.length}, launch: ${config.enableLaunch})`);
while (running) {
  try {
    const updates = await api.getUpdates(state.offset, 25);
    for (const update of updates) {
      state.offset = update.update_id + 1;
      if (update.message) await handleMessage(update.message);
      else if (update.callback_query) await handleCallback(update.callback_query);
    }
    saveState();
    await scanPushes();
  } catch (error) {
    console.error(`loop error: ${String(error?.message ?? error)}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
saveState();
