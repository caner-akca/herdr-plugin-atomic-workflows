// Pure plain-text formatters for the Telegram cockpit. No Markdown parse
// mode is used anywhere, so escaping can never fail a send.

import { fmtCost, stagePrompt, taskLabel } from "./display.mjs";

function age(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function fmtStatus(board, nowMs = Date.now()) {
  const tasks = board?.tasks ?? [];
  const lines = [`Cockpit: ${tasks.length} task(s) · board ${age(nowMs - (board?.updatedAt ?? 0))} old (${board?.mode ?? "?"})`];
  tasks.forEach((task, index) => {
    const cost = fmtCost(task.cost);
    lines.push(`t${index + 1} ${taskLabel(task)} — ${task.status ?? "?"}${task.phase ? ` · ${task.phase}` : ""}${cost ? ` · ${cost}` : ""}${task.attention ? `\n   needs: ${String(task.attention).slice(0, 160)}` : ""}`);
  });
  if (!tasks.length) lines.push("no active tasks");
  return lines.join("\n");
}

export function fmtTask(task, index) {
  const lines = [`t${index + 1} ${taskLabel(task)} — ${task.status ?? "?"}`];
  if (task.repo_root) lines.push(`repo: ${task.repo_root}`);
  for (const run of task.runs ?? []) {
    lines.push(`run ${String(run.status ?? "?")}${run.name ? ` · ${run.name}` : ""}`);
    for (const stage of run.stages ?? []) {
      const marker = stage.status === "running" ? "▶" : stage.status === "awaiting_input" ? "?" : stage.status === "completed" ? "✓" : stage.status === "failed" ? "✗" : "·";
      lines.push(` ${marker} ${stage.name ?? "?"} (${stage.status ?? "?"})`);
      const prompt = stage.status === "awaiting_input" ? stagePrompt(stage, run) : null;
      if (prompt) {
        lines.push(`   prompt: ${prompt.message.slice(0, 400)}`);
        prompt.choices.forEach((choice, choiceIndex) => lines.push(`   ${choiceIndex + 1}. ${choice}`));
      }
    }
  }
  const cost = fmtCost(task.cost);
  if (cost) lines.push(`cost so far: ${cost}`);
  return lines.join("\n");
}

export function fmtHistory(rows, limit = 12) {
  if (!rows.length) return "no runs in the ledger";
  const lines = ["Recent runs:"];
  for (const row of rows.slice(0, limit)) {
    const cost = fmtCost(row.usage?.cost ?? 0);
    lines.push(`${row.name ?? "?"} — ${row.status ?? "?"}${row.durationMs ? ` · ${age(row.durationMs)}` : ""}${cost ? ` · ${cost}` : ""}`);
  }
  return lines.join("\n");
}

export function fmtCostRollup(rows) {
  let total = 0;
  let dayTotal = 0;
  const dayStart = Date.now() - 24 * 3_600_000;
  for (const row of rows) {
    const cost = Number(row.usage?.cost ?? 0);
    if (!Number.isFinite(cost)) continue;
    total += cost;
    if ((row.endedAt ?? row.startedAt ?? 0) >= dayStart) dayTotal += cost;
  }
  return `Spend (ledger): $${dayTotal.toFixed(2)} last 24h · $${total.toFixed(2)} all recorded runs`;
}

export function fmtArtifacts(number, items) {
  if (!items.length) return `no artifacts found for #${number}`;
  const lines = [`Artifacts for #${number} (newest runs):`];
  for (const item of items) {
    lines.push(`${item.id} [${item.source}] ${item.name} (${item.bytes > 1024 * 1024 ? `${(item.bytes / 1024 / 1024).toFixed(1)}M` : `${Math.max(1, Math.round(item.bytes / 1024))}K`})`);
  }
  lines.push("fetch with /get <id>");
  return lines.join("\n");
}

// ── push events ───────────────────────────────────────────────────────────

export function pushKey(event) {
  return [event.type, event.runId ?? "", event.stage ?? "", event.status ?? ""].join(":");
}

export function fmtPush(event) {
  switch (event.type) {
    case "run_start":
      return `▶ ${event.name ?? "workflow"} started${event.task ? ` (${event.task})` : ""}`;
    case "run_end": {
      const cost = fmtCost(event.cost);
      return `${event.status === "completed" ? "✅" : "⏹"} ${event.name ?? "workflow"} ${event.status}${event.durationMs ? ` in ${age(event.durationMs)}` : ""}${cost ? ` · ${cost}` : ""}${event.summary ? `\n${String(event.summary).slice(0, 500)}` : ""}`;
    }
    case "awaiting_input": {
      const lines = [`❓ ${event.task ?? "task"} needs input — ${event.stage ?? "?"}`, String(event.message ?? "").slice(0, 500)];
      (event.choices ?? []).forEach((choice, index) => lines.push(`${index + 1}. ${choice}`));
      lines.push("(answer in the Herdr pane; remote answering is not enabled)");
      return lines.join("\n");
    }
    case "blocked":
      return `⛔ ${event.task ?? "task"} ${event.status}${event.detail ? ` — ${String(event.detail).slice(0, 300)}` : ""}`;
    default:
      return `event: ${JSON.stringify(event).slice(0, 300)}`;
  }
}

export function fmtDecision(record) {
  return `Maintainer decision on #${record.issue}: ${record.decision}${record.rationale ? `\nRationale: ${record.rationale.slice(0, 800)}` : ""}${record.from ? `\n(from ${record.from})` : ""}`;
}
