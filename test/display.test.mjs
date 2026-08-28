import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeExternal, taskLabel, tasksForWorkspace } from "../bin/display.mjs";

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

test("external text loses control bytes before it reaches the terminal (review F20)", () => {
  assert.equal(sanitizeExternal("plain title"), "plain title");
  assert.equal(sanitizeExternal("evil\u001b[2J\u001b[Hclear"), "evilclear");
  assert.equal(sanitizeExternal("osc\u001b]0;spoof\u0007done"), "oscdone");
  assert.equal(sanitizeExternal("c0\u0007\u0008\u000bbytes\u009b31m"), "c0bytes31m");
  assert.equal(sanitizeExternal("tabs\tand\nnewlines\nstay"), "tabs\tand\nnewlines\nstay");
  assert.equal(sanitizeExternal(null), "");
});
