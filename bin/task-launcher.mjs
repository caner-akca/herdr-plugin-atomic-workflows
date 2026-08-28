import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  PLUGIN_ID,
  createTask,
  findOpenTask,
  readTask,
  updateCampaign,
  updateTask,
} from "./task-store.mjs";

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TASK_LAUNCH_CAP = 5;

function serializeWorkflowValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  throw new Error(`unsupported workflow input value: ${typeof value}`);
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
    "--cwd", task.project_dir,
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
  const existing = findOpenTask(campaign.repo_root, "issue-fix", issue);
  if (existing) {
    if (focus) focusTask(existing);
    return { task: existing, existing: true };
  }
  const created = createTask({
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
  return { task: launchTaskPane(created, { focus }), existing: false };
}

export function launchReviewTask({ campaign, pr, focus = false }) {
  if (!Number.isInteger(pr) || pr < 1) throw new Error(`invalid PR number: ${pr}`);
  const existing = findOpenTask(campaign.repo_root, "code-review", pr);
  if (existing) {
    if (focus) focusTask(existing);
    return { task: existing, existing: true };
  }
  const created = createTask({
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
  return { task: launchTaskPane(created, { focus }), existing: false };
}

export function launchSelectedReviews(campaign, prNumbers) {
  const prs = [...new Set(prNumbers.map(Number))];
  if (prs.length === 0) throw new Error("select at least one PR");
  if (prs.length > TASK_LAUNCH_CAP) throw new Error(`a campaign can launch at most ${TASK_LAUNCH_CAP} tasks at once`);
  const launched = prs.map((pr) => launchReviewTask({ campaign, pr }));
  const taskIds = [...new Set([...(campaign.task_ids ?? []), ...launched.map(({ task }) => task.task_id)])];
  updateCampaign(campaign.campaign_id, { status: "running", task_ids: taskIds });
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
  const launched = issues.map((issue) => launchIssueTask({ campaign, issue }));
  const taskIds = [...new Set([...(campaign.task_ids ?? []), ...launched.map(({ task }) => task.task_id)])];
  updateCampaign(campaign.campaign_id, {
    status: "running",
    selected_issues: [...new Set([...(campaign.selected_issues ?? []), ...issues])],
    task_ids: taskIds,
  });
  return launched;
}

export function taskKickoff(task) {
  return buildWorkflowCommand(task.workflow, task.inputs);
}

export function resolveTaskFromEnvironment() {
  const id = process.env.ATOMIC_WORKFLOWS_TASK_ID;
  if (!id) throw new Error("ATOMIC_WORKFLOWS_TASK_ID is missing");
  const task = readTask(id);
  const cwd = path.resolve(process.cwd());
  const projectDir = path.resolve(task.project_dir);
  let sameDirectory = cwd === projectDir;
  try { sameDirectory = realpathSync(cwd) === realpathSync(projectDir); } catch {}
  if (!sameDirectory) {
    throw new Error(`task cwd mismatch: expected ${task.project_dir}, got ${process.cwd()}`);
  }
  return task;
}
