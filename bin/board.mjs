#!/usr/bin/env node
// Popup board: renders the watcher's aggregate state. q / esc / ctrl+c closes.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp/atomic-workflows-plugin";
const boardPath = path.join(STATE_DIR, "board.json");

const GLYPH = {
  running: "▶",
  awaiting_input: "⏸?",
  paused: "⏸",
  pending: "…",
  completed: "✓",
  failed: "✗",
  blocked: "⛔",
  skipped: "-",
};

function render() {
  process.stdout.write("\x1b[2J\x1b[H");
  console.log("\x1b[1m Atomic workflows \x1b[0m  (q to close)\n");
  let board = null;
  if (existsSync(boardPath)) {
    try {
      board = JSON.parse(readFileSync(boardPath, "utf8"));
    } catch {
      board = null;
    }
  }
  if (!board) {
    console.log("  watcher state not found — is the watcher running?");
    console.log("  restart it via the plugin action: Restart workflow watcher");
    return;
  }
  // Age of the watcher's last write, not a session timer: the watcher rewrites
  // board.json every ~2s, so a healthy age oscillates 0-2s. Growth means the
  // watcher is dead.
  const age = Math.round((Date.now() - board.updatedAt) / 1000);
  const freshness =
    age > 5
      ? `\x1b[31m⚠ watcher stale — last update ${age}s ago (right-click → Restart workflow watcher)\x1b[0m`
      : `\x1b[2mwatcher live · refreshed ${age}s ago\x1b[0m`;
  if (board.projects.length === 0) {
    console.log(`  no active workflow runs\n\n  ${freshness}`);
    return;
  }
  for (const project of board.projects) {
    console.log(`\x1b[1m ${path.basename(project.cwd)}\x1b[0m  ${project.cwd}`);
    console.log(`   panes: ${project.panes.join(", ")}`);
    for (const run of project.runs) {
      console.log(`   ${GLYPH[run.status] ?? "?"} \x1b[1m${run.name}\x1b[0m [${run.status}]`);
      for (const stage of run.stages) {
        if (stage.status === "pending") continue;
        console.log(`      ${GLYPH[stage.status] ?? "?"} ${stage.name} (${stage.status})`);
      }
    }
    console.log("");
  }
  console.log(`  ${freshness}`);
}

render();
const timer = setInterval(render, 1000);

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (key) => {
  const s = String(key);
  if (s === "q" || s === "\x1b" || s === "\x03") {
    clearInterval(timer);
    process.stdout.write("\x1b[2J\x1b[H");
    process.exit(0);
  }
});
