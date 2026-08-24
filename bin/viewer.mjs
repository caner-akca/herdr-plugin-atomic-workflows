#!/usr/bin/env node
// Transcript/artifact viewer pane (opened by the board's deep links).
// VIEW_TARGET env = file to show. Session .jsonl files are rendered one
// entry per block (type + any text-ish fields); everything else is raw.
// j/k/arrows scroll, space/b page, g/G jump, q/esc closes the pane.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const target = process.env.VIEW_TARGET || process.argv[2] || "";

function textish(value, depth = 0) {
  // Pull human-readable strings out of an entry without assuming a schema.
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => textish(v, depth + 1)).filter(Boolean).join("\n");
  if (value && typeof value === "object" && depth < 3) {
    const keys = ["text", "content", "message", "summary", "thinking", "data"];
    return keys.map((k) => (value[k] !== undefined ? textish(value[k], depth + 1) : "")).filter(Boolean).join("\n");
  }
  return "";
}

function loadLines() {
  if (!target) return ["no VIEW_TARGET given"];
  if (!existsSync(target)) {
    return [
      `file not found: ${target}`,
      "",
      "(atomic prunes run artifacts after ~30 days, and stage session files",
      " live outside the project — this one may be gone)",
    ];
  }
  const raw = readFileSync(target, "utf8");
  if (!target.endsWith(".jsonl")) return raw.split("\n");
  const lines = [];
  let i = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    i += 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      lines.push(`── [${i}] (unparseable line)`);
      continue;
    }
    const kind = entry.type ?? "?";
    const sub = entry.customType ? ` · ${entry.customType}` : entry.role ? ` · ${entry.role}` : "";
    lines.push(`\x1b[1m── [${i}] ${kind}${sub}\x1b[0m`);
    const body = textish(entry).trim();
    if (body) for (const l of body.split("\n")) lines.push(`   ${l}`);
  }
  return lines.length ? lines : ["(empty session file)"];
}

const lines = loadLines();
let offset = 0;

function render() {
  const rows = process.stdout.rows || 24;
  const visible = Math.max(4, rows - 3);
  offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - visible)));
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(`\x1b[1m ${path.basename(target)} \x1b[0m \x1b[2m${offset + 1}-${Math.min(lines.length, offset + visible)}/${lines.length} · q close · j/k/space scroll\x1b[0m`);
  for (const line of lines.slice(offset, offset + visible)) console.log(line);
}

render();
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (key) => {
  const s = String(key);
  const rows = process.stdout.rows || 24;
  const page = Math.max(4, rows - 3);
  if (s === "q" || s === "\x1b" || s === "\x03") {
    process.stdout.write("\x1b[2J\x1b[H");
    process.exit(0);
  } else if (s === "j" || s === "\x1b[B") offset += 1;
  else if (s === "k" || s === "\x1b[A") offset -= 1;
  else if (s === " " || s === "f") offset += page;
  else if (s === "b") offset -= page;
  else if (s === "g") offset = 0;
  else if (s === "G") offset = lines.length;
  else return;
  render();
});
process.stdout.on("resize", render);
