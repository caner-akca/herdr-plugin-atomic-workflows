// Artifact resolution for the Telegram cockpit. Everything is read-only and
// contained: files are only ever served from the workflow-owned artifact
// roots of the configured repository, resolved fresh on every listing.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

const TEXT_LIKE = new Set([".md", ".json", ".log", ".patch", ".txt", ".cast"]);

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function newestDir(parent, prefix = "") {
  if (!existsSync(parent)) return null;
  const dirs = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(parent, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

/** Newest run directories for an issue (or PR, for reviews). */
export function latestRunDirs(repoRoot, number) {
  const triage = newestDir(path.join(repoRoot, ".local", "triage", `issue-${number}`, "runs"));
  const pipeline = newestDir(path.join(repoRoot, ".local", "workflow-runs", "herdr-bug-pipeline"), `issue-${number}-`);
  const review = newestDir(path.join(repoRoot, ".local", "workflow-runs", "herdr-code-review"), `pr-${number}-`);
  return { triage, pipeline, review };
}

/** Retained fix worktree for an issue, newest first. */
export function fixWorktree(repoRoot, issue) {
  return newestDir(path.resolve(repoRoot, "..", "herdr-worktrees"), `issue-${issue}-pipeline-`);
}

/** Flat, numbered artifact list across the issue's newest runs. */
export function listArtifacts(repoRoot, number) {
  const { triage, pipeline, review } = latestRunDirs(repoRoot, number);
  const items = [];
  for (const [source, dir] of [["triage", triage], ["pipeline", pipeline], ["review", review]]) {
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      const bytes = statSync(file).size;
      if (bytes === 0) continue;
      items.push({ source, name: entry.name, path: file, bytes });
    }
  }
  items.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source.localeCompare(b.source)));
  return items.map((item, index) => ({ id: `a${index + 1}`, ...item }));
}

/** Reject any path that escaped the repository's workflow-owned roots. */
export function assertServableArtifact(repoRoot, filePath) {
  const real = realpathSync(filePath);
  const allowedRoots = [
    path.join(realpathSync(repoRoot), ".local"),
    path.resolve(realpathSync(repoRoot), "..", "herdr-worktrees"),
  ];
  if (!allowedRoots.some((root) => existsSync(root) && isInside(realpathSync(root), real))) {
    throw new Error(`artifact is outside the workflow-owned roots: ${filePath}`);
  }
  return real;
}

export function findNamedArtifact(repoRoot, number, names) {
  for (const item of listArtifacts(repoRoot, number)) {
    if (names.includes(item.name)) return item;
  }
  return null;
}

const GIF_CASTS = {
  repro: ["repro.cast"],
  replay: ["repro-replay.cast"],
  fixed: ["fixed.cast", "repro-replay.cast"],
};

/** Convert one of the issue's casts to a GIF; returns the cast on failure. */
export function renderGif(repoRoot, number, which, outDir) {
  const cast = findNamedArtifact(repoRoot, number, GIF_CASTS[which] ?? []);
  if (!cast) return { error: `no ${which} recording found for #${number}` };
  mkdirSync(outDir, { recursive: true });
  const gifPath = path.join(outDir, `${number}-${which}.gif`);
  const converted = spawnSync("agg", ["--idle-time-limit", "2", cast.path, gifPath], { encoding: "utf8", timeout: 120_000 });
  if (converted.status === 0 && existsSync(gifPath) && statSync(gifPath).size > 0) {
    return { gifPath, castPath: cast.path };
  }
  return { castPath: cast.path, error: `agg failed: ${(converted.stderr || "").trim().slice(0, 200) || "unavailable"}` };
}

/** Staged diff of the retained fix worktree, as text (may be large). */
export function stagedDiff(repoRoot, issue) {
  const worktree = fixWorktree(repoRoot, issue);
  if (!worktree) return { error: `no retained fix worktree for #${issue}` };
  const diff = spawnSync("git", ["diff", "--cached"], { cwd: worktree, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (diff.status !== 0) return { error: `git diff failed: ${(diff.stderr || "").trim().slice(0, 200)}` };
  return { worktree, diff: diff.stdout };
}

function firstSection(markdown, heading) {
  const lines = String(markdown).split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n").trim();
}

/**
 * Assemble the maintainer handoff digest for one issue from the newest runs:
 * rationale-first summary text plus the files worth attaching. Purely
 * mechanical; missing pieces are skipped and named.
 */
export function assembleHandoff(repoRoot, issue, readFile) {
  const { triage, pipeline } = latestRunDirs(repoRoot, issue);
  if (!triage) return { error: `no triage run found for #${issue}` };
  const read = (dir, name) => {
    const file = dir ? path.join(dir, name) : "";
    return file && existsSync(file) ? readFile(file) : "";
  };
  const why = read(triage, "why.md") || read(pipeline, "why.md");
  const report = read(triage, "report.md");
  const prDraft = read(pipeline, "pr-draft.md");
  const evidence = read(pipeline, "integration-evidence.md");
  const missing = [];
  const lines = [`Handoff: herdr issue #${issue}`];
  const verdict = report.split("\n").filter((line) => line.startsWith("|")).slice(0, 6);
  if (verdict.length) lines.push("", ...verdict.map((line) => line.replaceAll("|", " ").replace(/\s+/g, " ").trim()));
  const rootCause = firstSection(why, "## Root cause conclusion");
  if (rootCause) lines.push("", "Root cause:", rootCause);
  const whyFix = firstSection(why, "## Why fixing matters");
  if (whyFix) lines.push("", "Why fixing matters:", whyFix);
  if (evidence) {
    const summaryLines = evidence.split("\n").filter((line) => /^- (Gates|Final tree|Evidence-time|Target execution host)/.test(line));
    if (summaryLines.length) lines.push("", "Evidence:", ...summaryLines);
  } else {
    missing.push("integration evidence (no pipeline run yet)");
  }
  if (!prDraft) missing.push("pr draft (no reviewed fix yet)");
  const files = [];
  for (const [dir, name] of [
    [triage, "report.md"], [triage, "why.md"], [triage, "repro-driver.json"],
    [pipeline, "integration-evidence.md"], [pipeline, "pr-draft.md"],
  ]) {
    const file = dir ? path.join(dir, name) : "";
    if (file && existsSync(file) && statSync(file).size > 0 && !files.some((existing) => path.basename(existing) === name)) {
      files.push(file);
    }
  }
  if (missing.length) lines.push("", `Not included: ${missing.join("; ")}.`);
  lines.push("", "Reply with the buttons below; free-text replies to this message are recorded as your rationale.");
  return { summary: lines.join("\n"), files, triageDir: triage, pipelineDir: pipeline };
}
