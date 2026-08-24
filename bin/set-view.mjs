#!/usr/bin/env node
// Toggle a "workflows only" projection over herdr's Agents view:
// agents whose panes carry our wf token, most attention-worthy first.
// The view is transient (dies with the herdr server); a marker file lets
// the watcher reapply it on plugin startup.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request } from "./herdr-socket.mjs";

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp/atomic-workflows-plugin";
const SOURCE = "plugin:atomic.workflows";
export const VIEW_MARKER = path.join(STATE_DIR, "view-on");

export async function applyView() {
  await request("agent.view.set", {
    source: SOURCE,
    label: "workflows",
    filter: { op: "exists", field: { token: "wf" } },
    sort: [{ field: "attention", order: "desc" }],
  });
}

async function toggle() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(VIEW_MARKER)) {
    await request("agent.view.clear", { source: SOURCE });
    rmSync(VIEW_MARKER, { force: true });
    console.log("workflows-only agent view cleared");
  } else {
    await applyView();
    writeFileSync(VIEW_MARKER, String(Date.now()));
    console.log("workflows-only agent view set (invoke again to clear)");
  }
}

// Run only when invoked directly (the watcher imports applyView/VIEW_MARKER).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  toggle().catch((err) => {
    console.error(`agent view toggle failed: ${err.message}`);
    process.exit(1);
  });
}
