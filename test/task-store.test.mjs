import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, watch, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const state = mkdtempSync(path.join(os.tmpdir(), "atomic-workflows-task-store-"));
process.env.HERDR_PLUGIN_STATE_DIR = state;
const fakeHerdr = path.join(state, "fake-herdr.sh");
writeFileSync(fakeHerdr, `#!/bin/sh
if [ "$1 $2 $3" = "plugin pane open" ]; then
  echo '{"result":{"type":"plugin_pane_opened","plugin_pane":{"pane":{"pane_id":"pane-test","tab_id":"tab-test"}}}}'
else
  echo '{"result":{"type":"ok"}}'
fi
`);
chmodSync(fakeHerdr, 0o700);
process.env.HERDR_BIN_PATH = fakeHerdr;
const store = await import(`../bin/task-store.mjs?test=${Date.now()}`);
const launcher = await import(`../bin/task-launcher.mjs?test=${Date.now()}`);

function fakeRepo() {
  const repo = path.join(state, "repo");
  mkdirSync(path.join(repo, ".atomic", "workflows"), { recursive: true });
  writeFileSync(path.join(repo, ".atomic", "workflows", "herdr-bug-pipeline.ts"), "export default {};\n");
  writeFileSync(path.join(repo, ".atomic", "workflows", "herdr-triage-queue.ts"), "export default {};\n");
  writeFileSync(path.join(repo, ".atomic", "workflows", "herdr-code-review.ts"), "export default {};\n");
  return repo;
}

function runUpdater(taskId, patchKind, count) {
  const storeUrl = new URL("../bin/task-store.mjs", import.meta.url).href;
  const script = `
    const store = await import(process.argv[1]);
    const [taskId, kind, count] = [process.argv[2], process.argv[3], Number(process.argv[4])];
    for (let i = 0; i < count; i += 1) {
      const patch = kind === "pane"
        ? { pane_id: "pane-child", tab_id: "tab-child" }
        : { [kind]: kind + "-" + i };
      store.updateTask(taskId, patch);
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, storeUrl, taskId, patchKind, String(count)], {
      env: { ...process.env, HERDR_PLUGIN_STATE_DIR: state },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`updater exited ${code}: ${stderr}`)));
  });
}

function runStoppedUpdater(task) {
  const storeUrl = new URL("../bin/task-store.mjs", import.meta.url).href;
  const script = `
    const store = await import(process.argv[1]);
    store.updateTask(process.argv[2], { phase: "x".repeat(64 * 1024 * 1024) });
  `;
  let child;
  const stopped = new Promise((resolve, reject) => {
    const watcher = watch(task.control_dir, (_event, filename) => {
      if (!child || !String(filename).startsWith(`task.json.tmp-${child.pid}-`)) return;
      try {
        process.kill(child.pid, "SIGSTOP");
        watcher.close();
        resolve();
      } catch (error) {
        watcher.close();
        reject(error);
      }
    });
    child = spawn(process.execPath, ["--input-type=module", "-e", script, storeUrl, task.task_id], {
      env: { ...process.env, HERDR_PLUGIN_STATE_DIR: state },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => { watcher.close(); reject(error); });
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`delayed updater exited ${code}: ${stderr}`)));
  });
  return { child, stopped, done };
}

test("task updates preserve every revision across processes and retain a pane binding", async () => {
  const repo = fakeRepo();
  const task = store.createTask({
    kind: "issue-fix", target: 122, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 122 }, title: "#122 fix",
  });
  await Promise.all([
    runUpdater(task.task_id, "phase", 100),
    runUpdater(task.task_id, "progress", 100),
  ]);
  assert.equal(store.readTask(task.task_id).revision, 201);

  const paneTask = store.createTask({
    kind: "issue-fix", target: 123, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 123 }, title: "#123 fix",
  });
  await Promise.all([
    runUpdater(paneTask.task_id, "pane", 1),
    runUpdater(paneTask.task_id, "phase", 150),
  ]);
  const final = store.readTask(paneTask.task_id);
  assert.equal(final.revision, 152);
  assert.equal(final.pane_id, "pane-child");
  assert.equal(final.tab_id, "tab-child");
});

test("a delayed live lock owner cannot overwrite a later pane binding", async () => {
  const repo = fakeRepo();
  const task = store.createTask({
    kind: "issue-fix", target: 125, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 125 }, title: "#125 fix",
  });
  const delayed = runStoppedUpdater(task);
  await delayed.stopped;

  const lock = path.join(task.control_dir, "task.json.lock");
  const stale = new Date(Date.now() - 31_000);
  utimesSync(lock, stale, stale);
  const binding = runUpdater(task.task_id, "pane", 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.kill(delayed.child.pid, "SIGCONT");
  await Promise.all([delayed.done, binding]);

  const final = store.readTask(task.task_id);
  assert.equal(final.revision, 3);
  assert.equal(final.pane_id, "pane-child");
  assert.equal(final.tab_id, "tab-child");
  store.updateTask(task.task_id, { phase: "cleanup" });
});

test("task updates reclaim stale locks and release locks after write errors", () => {
  const repo = fakeRepo();
  const task = store.createTask({
    kind: "issue-fix", target: 124, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 124 }, title: "#124 fix",
  });
  const lock = path.join(task.control_dir, "task.json.lock");
  writeFileSync(lock, "crashed-writer");
  const stale = new Date(Date.now() - 31_000);
  utimesSync(lock, stale, stale);
  assert.equal(store.updateTask(task.task_id, { phase: "recovered" }).phase, "recovered");

  assert.throws(() => store.updateTask(task.task_id, { invalid: 1n }), /BigInt/);
  assert.equal(store.updateTask(task.task_id, { phase: "after-error" }).phase, "after-error");
});

test("tasks for one repository receive isolated Atomic projects and sessions", () => {
  const repo = fakeRepo();
  const first = store.createTask({
    kind: "issue-fix", target: 123, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 123 }, title: "#123 fix",
  });
  const second = store.createTask({
    kind: "issue-fix", target: 456, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 456 }, title: "#456 fix",
  });
  assert.notEqual(first.task_id, second.task_id);
  assert.notEqual(first.project_dir, second.project_dir);
  assert.notEqual(first.status_path, second.status_path);
  assert.notEqual(first.atomic_session_id, second.atomic_session_id);
  assert.equal(store.readTask(first.task_id).repo_root, store.readTask(second.task_id).repo_root);
});

test("task cwd comparison accepts a symlinked state directory", async () => {
  const repo = fakeRepo();
  const realState = path.join(state, "canonical-state");
  const stateAlias = path.join(state, "state-alias");
  mkdirSync(realState);
  symlinkSync(realState, stateAlias);
  const storeUrl = new URL("../bin/task-store.mjs", import.meta.url).href;
  const launcherUrl = new URL("../bin/task-launcher.mjs", import.meta.url).href;
  const script = `
    const { realpathSync } = await import("node:fs");
    const store = await import(process.argv[1]);
    const launcher = await import(process.argv[2]);
    const task = store.createTask({
      kind: "issue-fix", target: 126, repoRoot: process.argv[3], workspaceId: "w1",
      workflow: "herdr-bug-pipeline", inputs: { issue: 126 }, title: "#126 fix",
    });
    process.env.ATOMIC_WORKFLOWS_TASK_ID = task.task_id;
    process.chdir(realpathSync(task.project_dir));
    console.log(launcher.resolveTaskFromEnvironment().task_id);
  `;
  const resolved = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, storeUrl, launcherUrl, repo], {
      env: { ...process.env, HERDR_PLUGIN_STATE_DIR: stateAlias },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
  assert.match(resolved, /^[0-9a-f-]{36}$/);
});

test("code-review tasks use the exact kickoff contract and isolated project", () => {
  const repo = fakeRepo();
  const issue = store.createTask({
    kind: "issue-fix", target: 321, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 321 }, title: "#321 fix",
  });
  const review = launcher.launchReviewTask({
    campaign: { campaign_id: null, repo_root: repo, workspace_id: "w1" },
    pr: 321,
  }).task;
  assert.equal(
    launcher.taskKickoff(review),
    `/workflow herdr-code-review target="321" repo_dir=${JSON.stringify(realpathSync(repo))}`,
  );
  assert.equal(review.target, 321);
  assert.equal(review.inputs.target, "321");
  assert.equal(review.repo_root, realpathSync(repo));
  assert.notEqual(review.project_dir, issue.project_dir);
  assert.notEqual(review.status_path, issue.status_path);
  const config = JSON.parse(readFileSync(path.join(review.project_dir, ".atomic", "extensions", "workflow", "config.json"), "utf8"));
  assert.equal(config.workflows["herdr-code-review"].path, realpathSync(path.join(repo, ".atomic", "workflows", "herdr-code-review.ts")));
});

test("code-review dedupe is scoped by repository, kind, and PR number", () => {
  const repo = fakeRepo();
  const issue = store.createTask({
    kind: "issue-fix", target: 654, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 654 }, title: "#654 fix",
  });
  const review = store.createTask({
    kind: "code-review", target: 654, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-code-review", inputs: { target: "654" }, title: "PR #654 review",
  });
  assert.equal(store.findOpenTask(repo, "issue-fix", 654)?.task_id, issue.task_id);
  assert.equal(store.findOpenTask(repo, "code-review", 654)?.task_id, review.task_id);
  assert.equal(store.findOpenTask(repo, "code-review", 655), undefined);
  const launched = launcher.launchReviewTask({
    campaign: { campaign_id: null, repo_root: repo, workspace_id: "w1" },
    pr: 654,
  });
  assert.equal(launched.existing, true);
  assert.equal(launched.task.task_id, review.task_id);
  assert.throws(
    () => launcher.launchReviewTask({ campaign: { repo_root: repo, workspace_id: "w1" }, pr: 0 }),
    /invalid PR number/,
  );
});

test("review launches use the shared five-task launch cap", () => {
  assert.throws(
    () => launcher.launchSelectedReviews({ task_ids: [] }, [1, 2, 3, 4, 5, 6]),
    /at most 5 tasks at once/,
  );
});

test("open-task deduplication is repository, kind, and target scoped", () => {
  const repo = fakeRepo();
  const task = store.createTask({
    kind: "issue-fix", target: 789, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 789 }, title: "#789 fix",
  });
  assert.equal(store.findOpenTask(repo, "issue-fix", 789)?.task_id, task.task_id);
  store.updateTask(task.task_id, { status: "completed" });
  assert.equal(store.findOpenTask(repo, "issue-fix", 789), undefined);
});

test("skipped tasks do not block a later retry", () => {
  const repo = fakeRepo();
  const task = store.createTask({
    kind: "issue-fix", target: 790, repoRoot: repo, workspaceId: "w1",
    workflow: "herdr-bug-pipeline", inputs: { issue: 790 }, title: "#790 fix",
  });
  store.updateTask(task.task_id, { status: "skipped" });
  assert.equal(store.findOpenTask(repo, "issue-fix", 790), undefined);
});
