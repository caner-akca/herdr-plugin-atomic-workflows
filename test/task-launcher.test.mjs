import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowCommand, parsePluginPaneOpen } from "../bin/task-launcher.mjs";

test("workflow commands serialize typed inputs without shell interpolation", () => {
  assert.equal(
    buildWorkflowCommand("herdr-bug-pipeline", {
      issue: 123,
      repo_dir: "/tmp/herdr repo",
      simplify: "on",
      review: true,
    }),
    '/workflow herdr-bug-pipeline issue=123 repo_dir="/tmp/herdr repo" simplify="on" review=true',
  );
});

test("workflow command rejects unsafe names", () => {
  assert.throws(() => buildWorkflowCommand("bad workflow", {}), /invalid workflow name/);
  assert.throws(() => buildWorkflowCommand("good", { "bad-key": 1 }), /invalid workflow input name/);
});

test("extracts permanent pane and tab identity from Herdr response", () => {
  const pane = parsePluginPaneOpen(JSON.stringify({
    result: {
      type: "plugin_pane_opened",
      plugin_pane: { pane: { pane_id: "w1:p4", tab_id: "w1:t4" } },
    },
  }));
  assert.equal(pane.pane_id, "w1:p4");
  assert.equal(pane.tab_id, "w1:t4");
});

