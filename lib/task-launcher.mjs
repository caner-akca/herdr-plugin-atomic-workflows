import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { STATE_DIR } from "./plugin-state.mjs";
import { mkdirSync } from "node:fs";
import {
  PLUGIN_ID,
  createTask,
  findOpenTask,
  readTask,
  updateCampaign,
  updateTask, withFileLock } from "./task-store.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TASK_LAUNCH_CAP = 5;

function serializeWorkflowValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    // Review F21: Atomic's command tokenizer toggles quote state without
    // escape handling, so a value containing a quote or backslash would be
    // split into the wrong tokens. Refuse what cannot round-trip.
    if (/["\\\n\r]/.test(value)) {
      throw new Error(`workflow input value cannot be represented in a /workflow command: ${JSON.stringify(value)}`);
    }
    return JSON.stringify(value);
  }
  throw new Error(`unsupported workflow input value: ${typeof value}`);
}


// Review F8: admission (find-or-create for one repository+kind+target) runs
// under a cross-process file lock so two launchers can never both create the
// same task. The pane launch itself stays outside the lock; a concurrent
// caller then finds the freshly created non-terminal task and reuses it.
function withAdmissionLock(repoRoot, kind, target, action) {
  const locksDir = path.join(STATE_DIR, "locks");
  mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(`${path.resolve(String(repoRoot))}\0${kind}\0${target}`).digest("hex").slice(0, 16);
  return withFileLock(path.join(locksDir, `admission-${key}`), action);
}

export function buildWorkflowCommand(workflow, inputs) {
  if (!WORKFLOW_NAME_RE.test(workflow)) throw new Error(`invalid workflow name: ${workflow}`);
  const fields = [];
  for (const [key, value] of Object.entries(inputs)) {
    if (!INPUT_NAME_RE.test(key)) throw new Error(`invalid workflow input name: ${key}`);
    if (value === undefined) continue;
    fields.push(`${key}=${serializeWorkflowValue(value)}`);
  }
  return `/workflow ${workflow}${fields.length ? ` ${fields.join(" ")}` : ""}`;
}

export function parsePluginPaneOpen(stdout) {
  const response = JSON.parse(stdout);
  if (response?.result?.type !== "plugin_pane_opened") {
    throw new Error(`unexpected Herdr response: ${stdout.trim().slice(0, 300)}`);
  }
  const pane = response.result.plugin_pane?.pane;
  if (!pane?.pane_id || !pane?.tab_id) throw new Error("Herdr response omitted pane or tab identity");
  return pane;
}

function herdr(args, timeout = 20_000) {
  return spawnSync(HERDR, args, { encoding: "utf8", timeout });
}

export function focusTask(task) {
  if (!task?.pane_id) return false;
  return herdr(["plugin", "pane", "focus", task.pane_id]).status === 0;
}

function launchTaskPane(task, { focus = false } = {}) {
  if (task.pane_id) {
    if (focus) focusTask(task);
    return task;
  }
  const args = [
    "plugin", "pane", "open",
    "--plugin", PLUGIN_ID,
    "--entrypoint", "task",
    "--placement", "tab",
    "--workspace", task.workspace_id,
    // No --cwd: herdr resolves the relative manifest command against the pane
    // cwd, so the pane must start in the plugin root. task-runner gives Atomic
    // the task project dir explicitly via spawn cwd.
    "--env", `ATOMIC_WORKFLOWS_TASK_ID=${task.task_id}`,
    focus ? "--focus" : "--no-focus",
  ];
  const result = herdr(args);
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "Herdr could not open the task pane").trim().slice(0, 500);
    updateTask(task.task_id, { status: "launch-failed", phase: "launch failed", attention: message });
    throw new Error(message);
  }
  try {
    const pane = parsePluginPaneOpen(result.stdout);
    const updated = updateTask(task.task_id, {
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      status: "launching",
      phase: "starting Atomic",
      attention: "",
    });
    // A plugin pane has a static manifest title; the surrounding task tab is dynamic.
    herdr(["tab", "rename", pane.tab_id, task.title]);
    return updated;
  } catch (error) {
    updateTask(task.task_id, {
      status: "launch-failed",
      phase: "launch failed",
      attention: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function launchQueueTask(campaign, { focus = true } = {}) {
  const task = createTask({
    campaignId: campaign.campaign_id,
    kind: "issue-queue",
    target: "queue",
    repoRoot: campaign.repo_root,
    workspaceId: campaign.workspace_id,
    workflow: "herdr-triage-queue",
    inputs: {
      mode: "rank-only",
      shortlist_size: campaign.shortlist_size,
    },
    title: "Issue queue",
  });
  updateCampaign(campaign.campaign_id, { queue_task_id: task.task_id });
  return launchTaskPane(task, { focus });
}

export function launchIssueTask({ campaign, issue, focus = false }) {
  if (!Number.isInteger(issue) || issue < 1) throw new Error(`invalid issue number: ${issue}`);
  const admitted = withAdmissionLock(campaign.repo_root, "issue-fix", issue, () => {
    const existing = findOpenTask(campaign.repo_root, "issue-fix", issue);
    if (existing) return { task: existing, existing: true };
    return { task: createIssueTask(campaign, issue), existing: false };
  });
  if (admitted.existing) {
    if (focus) focusTask(admitted.task);
    return admitted;
  }
  return { task: launchTaskPane(admitted.task, { focus }), existing: false };
}

function createIssueTask(campaign, issue) {
  return createTask({
    campaignId: campaign.campaign_id,
    kind: "issue-fix",
    target: issue,
    repoRoot: campaign.repo_root,
    workspaceId: campaign.workspace_id,
    workflow: "herdr-bug-pipeline",
    inputs: {
      issue,
      simplify: "on",
      review: true,
    },
    title: `#${issue} fix`,
  });
}

export function launchReviewTask({ campaign, pr, focus = false }) {
  if (!Number.isInteger(pr) || pr < 1) throw new Error(`invalid PR number: ${pr}`);
  const admitted = withAdmissionLock(campaign.repo_root, "code-review", pr, () => {
    const existing = findOpenTask(campaign.repo_root, "code-review", pr);
    if (existing) return { task: existing, existing: true };
    return { task: createReviewTask(campaign, pr), existing: false };
  });
  if (admitted.existing) {
    if (focus) focusTask(admitted.task);
    return admitted;
  }
  return { task: launchTaskPane(admitted.task, { focus }), existing: false };
}

function createReviewTask(campaign, pr) {
  return createTask({
    campaignId: campaign.campaign_id,
    kind: "code-review",
    target: pr,
    repoRoot: campaign.repo_root,
    workspaceId: campaign.workspace_id,
    workflow: "herdr-code-review",
    // Atomic JSON-parses k=v values, while herdr-code-review declares target
    // as Type.String, so keep the workflow input distinct from numeric task.target.
    inputs: { target: String(pr) },
    title: `PR #${pr} review`,
  });
}

export function launchSelectedReviews(campaign, prNumbers) {
  const prs = [...new Set(prNumbers.map(Number))];
  if (prs.length === 0) throw new Error("select at least one PR");
  if (prs.length > TASK_LAUNCH_CAP) throw new Error(`a campaign can launch at most ${TASK_LAUNCH_CAP} tasks at once`);
  const launched = [];
  for (const pr of prs) {
    const result = launchReviewTask({ campaign, pr });
    launched.push(result);
    // Record each admitted task before the next launch so a later pane
    // failure never leaves earlier running tasks outside the campaign.
    campaign = updateCampaign(campaign.campaign_id, {
      status: "running",
      task_ids: [...new Set([...(campaign.task_ids ?? []), result.task.task_id])],
    });
  }
  return launched;
}

export function launchSelectedIssues(campaign, issueNumbers) {
  const queueTask = readTask(campaign.queue_task_id);
  const allowed = new Set((queueTask.shortlist ?? []).map((item) => Number(item.issue)));
  const issues = [...new Set(issueNumbers.map(Number))];
  if (issues.length === 0) throw new Error("select at least one issue");
  if (issues.length > TASK_LAUNCH_CAP) throw new Error(`an issue campaign can launch at most ${TASK_LAUNCH_CAP} tasks at once`);
  for (const issue of issues) {
    if (!allowed.has(issue)) throw new Error(`issue #${issue} is not in campaign shortlist`);
  }
  const launched = [];
  for (const issue of issues) {
    const result = launchIssueTask({ campaign, issue });
    launched.push(result);
    campaign = updateCampaign(campaign.campaign_id, {
      status: "running",
      selected_issues: [...new Set([...(campaign.selected_issues ?? []), issue])],
      task_ids: [...new Set([...(campaign.task_ids ?? []), result.task.task_id])],
    });
  }
  return launched;
}

export function taskKickoff(task) {
  return buildWorkflowCommand(task.workflow, task.inputs);
}

export function resolveTaskFromEnvironment() {
  const id = process.env.ATOMIC_WORKFLOWS_TASK_ID;
  if (!id) throw new Error("ATOMIC_WORKFLOWS_TASK_ID is missing");
  const task = readTask(id);
  // The pane starts in the plugin root (relative manifest command); Atomic gets
  // the project dir via spawn cwd. Verify the manifest's own integrity instead:
  // the project dir must live inside this task's control dir.
  const projectDir = path.resolve(task.project_dir);
  const controlDir = path.resolve(task.control_dir);
  if (projectDir !== path.join(controlDir, "project")) {
    throw new Error(`task project dir mismatch: ${task.project_dir} is not ${task.control_dir}/project`);
  }
  return task;
}
