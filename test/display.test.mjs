import assert from "node:assert/strict";
import test from "node:test";
import { taskLabel, tasksForWorkspace } from "../bin/display.mjs";

test("managed task labels identify review, issue, and queue panes", () => {
  assert.equal(taskLabel({ kind: "code-review", target: 42, title: "PR #42 review" }), "PR #42 review");
  assert.equal(taskLabel({ kind: "issue-fix", target: 7, title: "#7 fix" }), "#7 fix");
  assert.equal(taskLabel({ kind: "issue-queue", title: "Issue queue" }), "Issue queue");
  assert.equal(taskLabel({ kind: "code-review", target: 9 }), "PR #9 review");
});

test("board tasks are scoped to the invoking workspace when available", () => {
  const tasks = [
    { task_id: "a", workspace_id: "ws-a", repo_root: "/repo-a" },
    { task_id: "b", workspace_id: "ws-b", repo_root: "/repo-b" },
  ];
  assert.deepEqual(tasksForWorkspace(tasks, "ws-a"), [tasks[0]]);
  assert.equal(tasksForWorkspace(tasks, "").length, 2);
});
