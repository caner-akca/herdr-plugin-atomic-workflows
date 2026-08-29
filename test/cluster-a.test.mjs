// Behavioral coverage for the review's cluster-A fixes (F1, F7, F8, F19).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { claimOwner, readOwner, stillOwner, terminateVerifiedOwner, verifiedPid } from "../lib/watcher-owner.mjs";
import { resolveWorkspaceId } from "../lib/display.mjs";

test("owner records parse (including legacy pids) and follow the newest claimant (F1)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "owner-"));
  const file = path.join(dir, "watcher.pid");
  writeFileSync(file, "12345\n");
  assert.deepEqual(readOwner(file), { pid: 12345, legacy: true });
  claimOwner(file, { pid: process.pid, startedAt: 1, script: "watcher.mjs" });
  assert.ok(stillOwner(file, process.pid));
  claimOwner(file, { pid: process.pid + 1, startedAt: 2, script: "watcher.mjs" });
  assert.ok(!stillOwner(file, process.pid), "an older watcher loses ownership to the newest claim");
  writeFileSync(file, "{not json");
  assert.equal(readOwner(file), null);
});

test("pids are only ever signalled after command-line verification (F1)", async () => {
  // A live process whose command line does not name our script is protected.
  assert.equal(verifiedPid(process.pid, "definitely-not-our-script.mjs"), null);
  const dir = mkdtempSync(path.join(tmpdir(), "owner-"));
  const file = path.join(dir, "watcher.pid");
  claimOwner(file, { pid: process.pid, script: "watcher.mjs" });
  const skipped = terminateVerifiedOwner(file, "some-other-daemon.mjs");
  assert.equal(skipped.action, "skipped-unverified");
  // A verified child is terminated.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); // owner-test-marker.mjs"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  claimOwner(file, { pid: child.pid, script: "node" });
  const terminated = terminateVerifiedOwner(file, "owner-test-marker.mjs");
  assert.equal(terminated.action, "terminated");
  await new Promise((resolve) => child.on("exit", resolve));
});

test("the ledger index merges concurrent writers, keeps ended wins, and stays parseable (F19)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "ledger-"));
  process.env.HERDR_PLUGIN_STATE_DIR_TEST_UNUSED = "1";
  const child = (script) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HERDR_PLUGIN_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    proc.stderr.on("data", (chunk) => { err += chunk; });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  const here = path.resolve("lib/ledger.mjs").replaceAll("\\", "/");
  const write = (id, phase, ts) =>
    `import { saveIndex } from "file://${here}"; saveIndex({ "${id}": { phase: "${phase}", ts: ${ts} } });`;
  await Promise.all([child(write("run-a", "started", 1)), child(write("run-b", "ended", 2))]);
  await child(write("run-a", "ended", 3));
  const index = JSON.parse(readFileSync(path.join(stateDir, "ledger", "index.json"), "utf8"));
  assert.equal(index["run-a"].phase, "ended", "later ended merges over started");
  assert.equal(index["run-b"].phase, "ended", "concurrent writer is not lost");
  // ended never regresses to started.
  await child(write("run-a", "started", 4));
  const again = JSON.parse(readFileSync(path.join(stateDir, "ledger", "index.json"), "utf8"));
  assert.equal(again["run-a"].phase, "ended");
});

test("popup boards resolve their workspace from the plugin context (F7)", () => {
  assert.equal(resolveWorkspaceId({ HERDR_WORKSPACE_ID: "w7" }), "w7");
  assert.equal(resolveWorkspaceId({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w4" }) }), "w4");
  assert.equal(resolveWorkspaceId({ HERDR_PLUGIN_CONTEXT_JSON: "{broken" }), "");
  assert.equal(resolveWorkspaceId({}), "");
});

test("concurrent launchers admit exactly one task per repo+kind+target (F8)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "admission-"));
  const stateDir = path.join(root, "state");
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".atomic", "workflows"), { recursive: true });
  writeFileSync(path.join(repo, ".atomic", "workflows", "herdr-bug-pipeline.ts"), "export default {}\n");
  // Stub herdr: answers `plugin pane open` with a valid pane identity slowly,
  // widening the race window between find and create.
  const stub = path.join(root, "herdr");
  writeFileSync(stub, `#!/bin/sh\nsleep 0.3\necho '{"result":{"type":"plugin_pane_opened","plugin_pane":{"pane":{"pane_id":"w1:p1","tab_id":"w1:t1"}}}}'\n`);
  chmodSync(stub, 0o755);
  const launcher = path.resolve("lib/task-launcher.mjs").replaceAll("\\", "/");
  const script = `
    import { launchIssueTask } from "file://${launcher}";
    const campaign = { campaign_id: "11111111-1111-4111-8111-111111111111", repo_root: ${JSON.stringify(repo)}, workspace_id: "w1" };
    const result = launchIssueTask({ campaign, issue: 42 });
    console.log(JSON.stringify({ existing: result.existing, task: result.task.task_id }));
  `;
  const runChild = () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_BIN_PATH: stub },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.stderr.on("data", (chunk) => { err += chunk; });
    proc.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
  });
  const [first, second] = await Promise.all([runChild(), runChild()]);
  const tasks = readdirSync(path.join(stateDir, "tasks"));
  assert.equal(tasks.length, 1, `expected one admitted task, got ${tasks.length}`);
  assert.equal(first.task, second.task, "both callers converge on the same task");
  assert.ok(first.existing !== second.existing, "exactly one caller created it");
});
