import assert from "node:assert/strict";
import test from "node:test";
import { LAUNCH_DEADLINE_MS, rebindMovedTask, reduceTask, selectTaskRun } from "../lib/task-reducer.mjs";

const task = { workflow: "herdr-bug-pipeline", run_id: null, status: "launching", attention: "" };

test("selects the newest matching root run and ignores nested runs", () => {
  const snapshot = { runs: [
    { id: "old", name: "herdr-bug-pipeline", startedAt: 1 },
    { id: "child", name: "herdr-bug-pipeline", parentRunId: "old", startedAt: 3 },
    { id: "new", name: "herdr-bug-pipeline", startedAt: 2 },
  ] };
  assert.equal(selectTaskRun(task, snapshot)?.id, "new");
});

test("awaiting input becomes the only attention state", () => {
  const snapshot = { runs: [{
    id: "run", name: "herdr-bug-pipeline", status: "running", stages: [
      { name: "triage", status: "completed" },
      { name: "scope decision", status: "awaiting_input", pendingPrompt: { message: "Choose scope" } },
    ],
  }] };
  const { patch } = reduceTask(task, snapshot);
  assert.equal(patch.status, "needs-input");
  assert.equal(patch.phase, "scope decision");
  assert.equal(patch.attention, "Choose scope");
  assert.equal(patch.progress, "1/2");
});

test("awaiting input remains visible when the status file is old", () => {
  const nowMs = 1_000_000;
  const snapshot = { runs: [{
    id: "run", name: "herdr-bug-pipeline", status: "running",
    stages: [{
      name: "scope decision",
      status: "awaiting_input",
      pendingPrompt: { message: "Which approach should I take?" },
    }],
  }] };
  const reduced = reduceTask(task, snapshot, { statusMtimeMs: nowMs - 300_001, nowMs });
  assert.equal(reduced.liveness, "fresh");
  assert.equal(reduced.patch.status, "needs-input");
  assert.equal(reduced.patch.phase, "scope decision");
  assert.equal(reduced.patch.attention, "Which approach should I take?");
});

test("terminal queue outputs retain the shortlist", () => {
  const queueTask = { ...task, workflow: "herdr-triage-queue" };
  const shortlist = [{ issue: 123, score: 90, title: "Example" }];
  const snapshot = { runs: [{
    id: "queue", name: "herdr-triage-queue", status: "completed", stages: [],
    result: { shortlist, queue_report: "/tmp/queue.md" },
  }] };
  const { patch } = reduceTask(queueTask, snapshot);
  assert.deepEqual(patch.shortlist, shortlist);
  assert.equal(patch.queue_report, "/tmp/queue.md");
});

test("skipped runs remain terminal task results", () => {
  const snapshot = { runs: [{
    id: "skip", name: "herdr-bug-pipeline", status: "skipped", stages: [],
    result: { summary: "issue already closed" },
  }] };
  const { patch } = reduceTask(task, snapshot, { paneExists: false });
  assert.equal(patch.status, "skipped");
  assert.equal(patch.result.summary, "issue already closed");
});

test("age alone is only ever quiet, never a terminal state (review F2)", () => {
  const nowMs = 1_000_000;
  const snapshot = { runs: [{
    id: "run", name: "herdr-bug-pipeline", status: "running",
    stages: [{ name: "implement", status: "running" }],
  }] };

  const fresh = reduceTask(task, snapshot, { statusMtimeMs: nowMs - 45_000, nowMs });
  assert.equal(fresh.liveness, "fresh");
  assert.equal(fresh.patch.status, "running");

  const stale = reduceTask(task, snapshot, { statusMtimeMs: nowMs - 45_001, nowMs });
  assert.equal(stale.liveness, "stale");
  assert.equal(stale.patch.status, "running", "status stays truthful");
  assert.match(stale.patch.phase, /quiet 1m\?/);

  // A long quiet model/build/test call is still running, not dead.
  const longQuiet = reduceTask(task, snapshot, { statusMtimeMs: nowMs - 900_000, nowMs });
  assert.equal(longQuiet.liveness, "stale");
  assert.equal(longQuiet.patch.status, "running");
  assert.match(longQuiet.patch.phase, /quiet 15m\?/);
});

test("paused and pending managed runs remain live when the status file is old", () => {
  const nowMs = 1_000_000;
  for (const status of ["paused", "pending"]) {
    const snapshot = { runs: [{
      id: status, name: "herdr-bug-pipeline", status,
      stages: [{ name: "implement", status }],
    }] };
    const reduced = reduceTask(task, snapshot, { statusMtimeMs: nowMs - 300_001, nowMs });
    assert.equal(reduced.liveness, "fresh");
    assert.equal(reduced.patch.status, status);
    assert.equal(reduced.patch.phase, status);
  }
});

test("managed liveness covers running snapshots without misclassifying quiet states", () => {
  const nowMs = 1_000_000;
  const old = { statusMtimeMs: nowMs - 300_001, nowMs };
  const reduce = (status, stages) => reduceTask(task, { runs: [{
    id: `${status}-${stages.length}`, name: "herdr-bug-pipeline", status, stages,
    result: status === "completed" ? {} : undefined,
  }] }, old);

  for (const stages of [
    [{ name: "implement", status: "running" }],
    [],
    [{ name: "implement", status: "pending" }],
  ]) {
    const reduced = reduce("running", stages);
    assert.equal(reduced.liveness, "stale");
    assert.equal(reduced.patch.status, "running");
    assert.match(reduced.patch.phase, /quiet/);
  }

  const awaiting = reduce("running", [{
    name: "scope", status: "awaiting_input", pendingPrompt: { message: "Choose scope" },
  }]);
  assert.equal(awaiting.liveness, "fresh");
  assert.equal(awaiting.patch.status, "needs-input");
  assert.equal(awaiting.patch.attention, "Choose scope");

  for (const status of ["paused", "pending", "completed"]) {
    const reduced = reduce(status, [{ name: "implement", status }]);
    assert.equal(reduced.liveness, "fresh");
    assert.equal(reduced.patch.status, status);
  }
});

test("terminal managed runs are unaffected by an old status file", () => {
  const snapshot = { runs: [{
    id: "done", name: "herdr-bug-pipeline", status: "completed", stages: [], result: {},
  }] };
  const reduced = reduceTask(task, snapshot, { statusMtimeMs: 1, nowMs: 1_000_000 });
  assert.equal(reduced.liveness, "fresh");
  assert.equal(reduced.patch.status, "completed");
  assert.equal(reduced.patch.phase, "completed");
});

test("a runless launching task expires to terminal launch-failed (review F11)", () => {
  const nowMs = 10_000_000;
  const young = { ...task, created_at: nowMs - LAUNCH_DEADLINE_MS + 1000 };
  const youngReduced = reduceTask(young, { runs: [] }, { nowMs });
  assert.equal(youngReduced.patch.status, "launching");
  const expired = { ...task, created_at: nowMs - LAUNCH_DEADLINE_MS - 1000 };
  const expiredReduced = reduceTask(expired, { runs: [] }, { nowMs });
  assert.equal(expiredReduced.patch.status, "launch-failed");
  assert.match(expiredReduced.patch.phase, /no run within/);
  // Already-failed stays failed even after time passes.
  const already = { ...task, status: "launch-failed", created_at: nowMs - 1000 };
  assert.equal(reduceTask(already, { runs: [] }, { nowMs }).patch.status, "launch-failed");
});

test("pane moves rebind the matching task instead of orphaning it (review F9)", () => {
  const tasks = [
    { task_id: "a", pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
    { task_id: "b", pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
  ];
  const updates = [];
  const update = (id, patch) => { updates.push([id, patch]); return patch; };
  const event = { type: "pane.moved", previous_pane_id: "w1:p2", pane: { pane_id: "w3:p9", tab_id: "w3:t1", workspace_id: "w3" } };
  assert.ok(rebindMovedTask(tasks, event, update));
  assert.deepEqual(updates, [["a", { pane_id: "w3:p9", tab_id: "w3:t1", workspace_id: "w3" }]]);
  assert.equal(rebindMovedTask(tasks, { type: "pane.moved", previous_pane_id: "w9:p9", pane: { pane_id: "x" } }, update), null);
  assert.equal(rebindMovedTask(tasks, { type: "pane.created" }, update), null);
  assert.equal(updates.length, 1);
});
