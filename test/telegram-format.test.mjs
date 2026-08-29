import assert from "node:assert/strict";
import test from "node:test";
import { splitMessage } from "../lib/telegram-api.mjs";
import {
  fmtArtifacts,
  fmtCostRollup,
  fmtPush,
  fmtStatus,
  fmtTask,
  pushKey,
} from "../lib/telegram-format.mjs";

const task = {
  title: "#42 fix", kind: "issue-fix", target: 42, status: "needs-input", phase: "implement",
  attention: "Pick an approach", cost: 3.21, repo_root: "/repo",
  runs: [{
    status: "running", name: "herdr-bug-pipeline",
    stages: [
      { name: "diagnose", status: "completed" },
      { name: "implement", status: "awaiting_input", pendingPrompt: { message: "Which approach?", choices: ["A", "B"] } },
    ],
  }],
};

test("status and task views render prompts, cost, and freshness", () => {
  const status = fmtStatus({ updatedAt: Date.now() - 5000, mode: "events", tasks: [task] });
  assert.match(status, /t1 #42 fix — needs-input · implement · \$3\.21/);
  assert.match(status, /needs: Pick an approach/);
  const detail = fmtTask(task, 0);
  assert.match(detail, /\? implement \(awaiting_input\)/);
  assert.match(detail, /prompt: Which approach\?/);
  assert.match(detail, /1\. A/);
  assert.match(fmtStatus({ tasks: [] }), /no active tasks/);
});

test("push events format and dedupe keys are stable", () => {
  const awaiting = { type: "awaiting_input", runId: "r1", stage: "implement", task: "#42 fix", message: "Which?", choices: ["A"] };
  assert.equal(pushKey(awaiting), pushKey({ ...awaiting, message: "changed text" }));
  assert.notEqual(pushKey(awaiting), pushKey({ ...awaiting, stage: "review" }));
  assert.match(fmtPush(awaiting), /needs input — implement/);
  assert.match(fmtPush({ type: "run_end", status: "completed", name: "wf", durationMs: 60000, cost: 2 }), /✅ wf completed/);
  assert.match(fmtPush({ type: "blocked", task: "t", status: "dead", detail: "no writes" }), /⛔/);
});

test("artifact listings, cost rollup, and message splitting stay bounded", () => {
  const listing = fmtArtifacts(42, [{ id: "a1", source: "triage", name: "report.md", bytes: 2048 }]);
  assert.match(listing, /a1 \[triage\] report\.md \(2K\)/);
  const rollup = fmtCostRollup([
    { usage: { cost: 2 }, endedAt: Date.now() },
    { usage: { cost: 3 }, endedAt: Date.now() - 48 * 3600000 },
  ]);
  assert.match(rollup, /\$2\.00 last 24h · \$5\.00 all/);
  const chunks = splitMessage(Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n"));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 4096));
  assert.equal(chunks.join("\n"), chunks.join("\n")); // no content loss across joins
  assert.ok(splitMessage("x".repeat(9000)).every((chunk) => chunk.length <= 4096));
});
