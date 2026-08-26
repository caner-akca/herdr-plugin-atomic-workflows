import { usageOfRun } from "./ledger.mjs";
import { stagePrompt } from "./display.mjs";

const TERMINAL_RUN = new Set(["completed", "skipped", "failed", "blocked", "killed", "cancelled"]);
const STALE_MS = 45_000;
const DEAD_MS = 300_000;

export function liveness(ageMs) {
  if (ageMs > DEAD_MS) return "dead";
  if (ageMs > STALE_MS) return "stale";
  return "fresh";
}

export function selectTaskRun(task, snapshot) {
  const runs = snapshot?.runs ?? [];
  if (task.run_id) {
    const exact = runs.find((run) => run.id === task.run_id);
    if (exact) return exact;
  }
  return [...runs]
    .filter((run) => !run.parentRunId && run.name === task.workflow)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null;
}

function outputsOfRun(run) {
  if (!run?.result || typeof run.result !== "object") return {};
  if (run.result.outputs && typeof run.result.outputs === "object") return run.result.outputs;
  return run.result;
}

export function reduceTask(task, snapshot, { paneExists = true, statusMtimeMs, nowMs = Date.now() } = {}) {
  const run = selectTaskRun(task, snapshot);
  const stages = run?.stages ?? [];
  const awaiting = stages.find((stage) => stage.status === "awaiting_input");
  // A running run is expected to keep writing unless it is explicitly waiting
  // for human input. This includes legal pre-stage and pending-stage snapshots.
  const expectsWrites = run?.status === "running" && !awaiting;
  const live = expectsWrites && Number.isFinite(statusMtimeMs)
    ? liveness(Math.max(0, nowMs - statusMtimeMs))
    : "fresh";
  if (!paneExists && !TERMINAL_RUN.has(run?.status)) {
    return { run, liveness: live, patch: { status: "pane-gone", phase: "pane gone", attention: "pane exited" } };
  }
  if (!run) {
    return {
      run: null,
      liveness: "fresh",
      patch: {
        status: task.status === "launch-failed" ? "launch-failed" : "launching",
        phase: task.status === "launch-failed" ? "launch failed" : "launching",
        attention: task.attention ?? "",
      },
    };
  }

  const running = stages.find((stage) => stage.status === "running");
  const done = stages.filter((stage) => ["completed", "failed", "skipped"].includes(stage.status)).length;
  const total = stages.length;
  const phase = awaiting?.name ?? running?.name ?? run.status;
  const patch = {
    run_id: run.id,
    status: awaiting ? "needs-input" : run.status,
    phase,
    attention: awaiting ? stagePrompt(awaiting, run)?.message || awaiting.name : "",
    progress: total > 0 ? `${done}/${total}` : "",
    cost: usageOfRun(run).cost,
  };
  if (live !== "fresh") {
    const ageMs = Math.max(0, nowMs - statusMtimeMs);
    patch.status = live;
    patch.phase = live === "dead"
      ? `[dead? no writes ${Math.round(ageMs / 60_000)}m]`
      : `${phase} (stale?)`;
    patch.attention = "";
  }

  if (TERMINAL_RUN.has(run.status)) {
    const outputs = outputsOfRun(run);
    if (Array.isArray(outputs.shortlist)) patch.shortlist = outputs.shortlist;
    if (typeof outputs.queue_report === "string") patch.queue_report = outputs.queue_report;
    patch.result = outputs;
  }
  return { run, liveness: live, patch };
}

export function taskSummary(task, run) {
  return {
    task_id: task.task_id,
    campaign_id: task.campaign_id,
    kind: task.kind,
    target: task.target,
    title: task.title,
    repo_root: task.repo_root,
    workspace_id: task.workspace_id,
    pane_id: task.pane_id,
    tab_id: task.tab_id,
    workflow: task.workflow,
    run_id: task.run_id,
    status: task.status,
    phase: task.phase,
    attention: task.attention,
    progress: task.progress ?? "",
    cost: task.cost ?? 0,
    shortlist: task.shortlist ?? [],
    queue_report: task.queue_report ?? "",
    created_at: task.created_at,
    run,
  };
}
