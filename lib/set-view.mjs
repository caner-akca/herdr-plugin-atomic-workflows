// Toggle a "workflows only" projection over herdr's Agents view:
// agents whose panes carry our wf token, most attention-worthy first.
// The view is transient (dies with the herdr server); a marker file lets
// the watcher reapply it on plugin startup.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request } from "./herdr-socket.mjs";
import { STATE_DIR } from "./plugin-state.mjs";

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

export async function toggle() {
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

