import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./plugin-state.mjs";

const TASK_SCHEMA = 1;
const CAMPAIGN_SCHEMA = 1;
export const PLUGIN_ID = "atomic.workflows";
const TASKS_DIR = path.join(STATE_DIR, "tasks");
const CAMPAIGNS_DIR = path.join(STATE_DIR, "campaigns");

const LOCK_WAIT_MS = 2_000;
// A stale lock is reclaimable only after proving its recorded owner is gone.
// A PID can theoretically be reused; the age threshold makes that narrow race
// much less likely while owner-token verification still prevents a late commit.
const STALE_LOCK_MS = 30_000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "skipped",
  "failed",
  "blocked",
  "cancelled",
  "killed",
  "pane-gone",
  "launch-failed",
]);

function ensureStateDirs() {
  mkdirSync(TASKS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(CAMPAIGNS_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(STATE_DIR, 0o700);
    chmodSync(TASKS_DIR, 0o700);
    chmodSync(CAMPAIGNS_DIR, 0o700);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function assertUuid(value, label = "id") {
  if (!UUID_RE.test(String(value))) throw new Error(`${label} must be a UUID`);
  return String(value);
}

function sleep(ms) {
  Atomics.wait(LOCK_SLEEP, 0, 0, ms);
}

function lockOwnerIsAlive(token) {
  const pid = Number(String(token).split(":", 1)[0]);
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function withFileLock(file, action) {
  const lock = `${file}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          const ownerToken = readFileSync(lock, "utf8");
          if (!lockOwnerIsAlive(ownerToken) && readFileSync(lock, "utf8") === ownerToken) unlinkSync(lock);
        }
      } catch (staleError) {
        if (staleError?.code !== "ENOENT") throw staleError;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for manifest lock: ${file}`);
      sleep(10);
      continue;
    }
    try {
      writeFileSync(descriptor, token, "utf8");
    } catch (error) {
      closeSync(descriptor);
      descriptor = undefined;
      try { unlinkSync(lock); } catch {}
      throw error;
    }
  }
  try {
    const assertOwned = () => {
      try {
        if (readFileSync(lock, "utf8") === token) return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const error = new Error(`manifest lock ownership lost: ${file}`);
      error.code = "ELOCKLOST";
      throw error;
    };
    return action(assertOwned);
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

export function atomicWriteJson(file, value, beforeRename = () => {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    beforeRename();
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function taskDir(taskId) {
  return path.join(TASKS_DIR, assertUuid(taskId, "task_id"));
}

function taskFile(taskId) {
  return path.join(taskDir(taskId), "task.json");
}

function campaignFile(campaignId) {
  return path.join(CAMPAIGNS_DIR, `${assertUuid(campaignId, "campaign_id")}.json`);
}

export function readTask(taskId) {
  const task = readJson(taskFile(taskId));
  if (task.schema !== TASK_SCHEMA || task.task_id !== taskId) throw new Error(`invalid task manifest ${taskId}`);
  return task;
}

export function listTasks() {
  ensureStateDirs();
  const tasks = [];
  for (const entry of readdirSync(TASKS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    try {
      tasks.push(readTask(entry.name));
    } catch {
      // A corrupt task remains on disk for manual recovery but not in live state.
    }
  }
  return tasks.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
}

function writeTask(task) {
  assertUuid(task.task_id, "task_id");
  atomicWriteJson(taskFile(task.task_id), { ...task, schema: TASK_SCHEMA, updated_at: Date.now() });
}

export function updateTask(taskId, patch) {
  const file = taskFile(taskId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = withFileLock(file, (assertOwned) => {
        const task = readTask(taskId);
        const revision = task.revision ?? 0;
        const next = {
          ...task,
          ...patch,
          schema: TASK_SCHEMA,
          task_id: task.task_id,
          revision: revision + 1,
          updated_at: Date.now(),
        };
        // The lock is the cross-process primitive; retain the revision check as
        // a cheap guard against a writer that does not participate in locking.
        if ((readTask(taskId).revision ?? 0) !== revision) return null;
        atomicWriteJson(file, next, assertOwned);
        return next;
      });
      if (result) return result;
    } catch (error) {
      if (error?.code !== "ELOCKLOST") throw error;
    }
  }
  throw new Error(`task update could not converge after 3 revision retries: ${taskId}`);
}

export function readCampaign(campaignId) {
  const campaign = readJson(campaignFile(campaignId));
  if (campaign.schema !== CAMPAIGN_SCHEMA || campaign.campaign_id !== campaignId) {
    throw new Error(`invalid campaign manifest ${campaignId}`);
  }
  return campaign;
}


function writeCampaign(campaign) {
  assertUuid(campaign.campaign_id, "campaign_id");
  atomicWriteJson(campaignFile(campaign.campaign_id), {
    ...campaign,
    schema: CAMPAIGN_SCHEMA,
    updated_at: Date.now(),
  });
}

export function updateCampaign(campaignId, patch) {
  const file = campaignFile(campaignId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = withFileLock(file, (assertOwned) => {
        const campaign = readCampaign(campaignId);
        const revision = campaign.revision ?? 0;
        const next = {
          ...campaign,
          ...patch,
          schema: CAMPAIGN_SCHEMA,
          campaign_id: campaign.campaign_id,
          revision: revision + 1,
          updated_at: Date.now(),
        };
        if ((readCampaign(campaignId).revision ?? 0) !== revision) return null;
        atomicWriteJson(file, next, assertOwned);
        return next;
      });
      if (result) return result;
    } catch (error) {
      if (error?.code !== "ELOCKLOST") throw error;
    }
  }
  throw new Error(`campaign update could not converge after 3 revision retries: ${campaignId}`);
}

export function isTerminalTask(task) {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

export function findOpenTask(repoRoot, kind, target) {
  const canonical = canonicalRepoRoot(repoRoot);
  return listTasks().find(
    (task) =>
      task.repo_root === canonical &&
      task.kind === kind &&
      String(task.target) === String(target) &&
      !isTerminalTask(task),
  );
}

function canonicalRepoRoot(repoRoot) {
  const resolved = path.resolve(String(repoRoot));
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`repository directory does not exist: ${resolved}`);
  }
  return realpathSync(resolved);
}

function workflowPath(repoRoot, workflow) {
  const file = path.join(repoRoot, ".atomic", "workflows", `${workflow}.ts`);
  if (!existsSync(file)) throw new Error(`workflow not found: ${file}`);
  return realpathSync(file);
}

export function createCampaign({ repoRoot, workspaceId, shortlistSize = 15 }) {
  ensureStateDirs();
  const campaignId = randomUUID();
  const now = Date.now();
  const campaign = {
    schema: CAMPAIGN_SCHEMA,
    revision: 1,
    campaign_id: campaignId,
    kind: "issue-campaign",
    repo_root: canonicalRepoRoot(repoRoot),
    workspace_id: String(workspaceId),
    status: "ranking",
    shortlist_size: shortlistSize,
    queue_task_id: null,
    selected_issues: [],
    task_ids: [],
    created_at: now,
    updated_at: now,
  };
  writeCampaign(campaign);
  return campaign;
}

export function createTask({ campaignId, kind, target, repoRoot, workspaceId, workflow, inputs, title }) {
  ensureStateDirs();
  const taskId = randomUUID();
  const atomicSessionId = randomUUID();
  const root = taskDir(taskId);
  const projectDir = path.join(root, "project");
  const sessionsDir = path.join(root, "sessions");
  const atomicArtifactDir = path.join(root, "atomic-artifacts");
  const statusPath = path.join(projectDir, ".atomic", "workflows", "status.json");
  const canonicalRepo = canonicalRepoRoot(repoRoot);
  const resolvedInputs = { ...inputs, repo_dir: canonicalRepo };
  const now = Date.now();
  const task = {
    schema: TASK_SCHEMA,
    revision: 1,
    task_id: taskId,
    campaign_id: campaignId ?? null,
    kind,
    target,
    title,
    repo_root: canonicalRepo,
    workspace_id: String(workspaceId),
    control_dir: root,
    project_dir: projectDir,
    sessions_dir: sessionsDir,
    atomic_artifact_dir: atomicArtifactDir,
    status_path: statusPath,
    workflow,
    inputs: resolvedInputs,
    pane_id: null,
    tab_id: null,
    atomic_session_id: atomicSessionId,
    run_id: null,
    status: "launching",
    phase: "launching",
    attention: "",
    shortlist: [],
    queue_report: "",
    cost: 0,
    created_at: now,
    updated_at: now,
  };

  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  mkdirSync(atomicArtifactDir, { recursive: true, mode: 0o700 });
  atomicWriteJson(path.join(projectDir, ".atomic", "extensions", "workflow", "config.json"), {
    statusFile: true,
    resumeInFlight: "never",
    workflows: {
      [workflow]: { path: workflowPath(canonicalRepo, workflow) },
    },
  });
  writeTask(task);
  return task;
}
