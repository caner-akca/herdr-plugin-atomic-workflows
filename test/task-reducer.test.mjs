import assert from "node:assert/strict";
import test from "node:test";
import { reduceTask, selectTaskRun } from "../bin/task-reducer.mjs";

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

test("managed task reduction surfaces fresh, stale, and dead status-file ages", () => {
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
  assert.equal(stale.patch.status, "stale");
  assert.match(stale.patch.phase, /stale/);

  const dead = reduceTask(task, snapshot, { statusMtimeMs: nowMs - 300_001, nowMs });
  assert.equal(dead.liveness, "dead");
  assert.equal(dead.patch.status, "dead");
  assert.match(dead.patch.phase, /dead/);
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
    assert.equal(reduced.liveness, "dead");
    assert.equal(reduced.patch.status, "dead");
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
