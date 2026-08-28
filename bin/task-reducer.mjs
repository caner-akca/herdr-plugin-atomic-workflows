import { usageOfRun } from "./ledger.mjs";
import { stagePrompt } from "./display.mjs";

const TERMINAL_RUN = new Set(["completed", "skipped", "failed", "blocked", "killed", "cancelled"]);
const STALE_MS = 45_000;
export const LAUNCH_DEADLINE_MS = 10 * 60_000;

// Review F2: file age alone can only ever mean "quiet" — a long model call,
// build, test, or remote command legitimately writes nothing for many
// minutes. Terminal death requires independent pane evidence (pane-gone).
export function liveness(ageMs) {
  return ageMs > STALE_MS ? "stale" : "fresh";
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
    // Review F11: a crash between task creation and run start must not block
    // this issue/PR forever. A runless task past the deadline becomes the
    // terminal launch-failed, which frees dedupe for a relaunch.
    const expired = task.status !== "launch-failed" &&
      Number.isFinite(task.created_at) && nowMs - task.created_at > LAUNCH_DEADLINE_MS;
    const failed = task.status === "launch-failed" || expired;
    return {
      run: null,
      liveness: "fresh",
      patch: {
        status: failed ? "launch-failed" : "launching",
        phase: failed
          ? (expired ? `launch failed (no run within ${Math.round(LAUNCH_DEADLINE_MS / 60_000)}m)` : "launch failed")
          : "launching",
        attention: failed ? "no workflow run appeared; relaunch from the board" : (task.attention ?? ""),
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
    // Quiet is presentation, not state: the run's own status stays truthful
    // and only the phase carries the age marker.
    const ageMs = Math.max(0, nowMs - statusMtimeMs);
    patch.phase = `${phase} (quiet ${Math.max(1, Math.round(ageMs / 60_000))}m?)`;
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

/** Review F9: a pane move changes the public pane id; rebind the matching
 * task so the next pass does not misread it as pane-gone (terminal). Pure:
 * the store update function is injected. */
export function rebindMovedTask(tasks, event, update) {
  if (event?.type !== "pane.moved" || !event.previous_pane_id || !event.pane?.pane_id) return null;
  const task = tasks.find((candidate) => candidate.pane_id === event.previous_pane_id);
  if (!task) return null;
  return update(task.task_id, {
    pane_id: event.pane.pane_id,
    tab_id: event.pane.tab_id ?? task.tab_id,
    workspace_id: event.pane.workspace_id ?? task.workspace_id,
  });
}
