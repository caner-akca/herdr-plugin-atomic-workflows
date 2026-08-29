import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assembleHandoff,
  assertServableArtifact,
  findNamedArtifact,
  fixWorktree,
  latestRunDirs,
  listArtifacts,
  stagedDiff,
} from "../lib/telegram-artifacts.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "tg-artifacts-"));
  const repo = path.join(root, "herdr");
  const triage = path.join(repo, ".local", "triage", "issue-42", "runs", "2026-08-28-run");
  const pipeline = path.join(repo, ".local", "workflow-runs", "herdr-bug-pipeline", "issue-42-abc123");
  mkdirSync(triage, { recursive: true });
  mkdirSync(pipeline, { recursive: true });
  writeFileSync(path.join(triage, "report.md"), "# Triage: issue #42 — t\n\n| Question | Answer |\n|---|---|\n| Can it be reproduced? | **yes** — proof |\n");
  writeFileSync(path.join(triage, "why.md"), "# Why\n\n## Root cause conclusion\n\nThe cause.\n\n## Why fixing matters\n\nUsers lose panes.\n\n## Next\n");
  writeFileSync(path.join(triage, "repro-driver.json"), JSON.stringify({ schema_version: 1 }));
  writeFileSync(path.join(triage, "repro.cast"), '{"version":2}\n[0.1,"o","x"]\n');
  writeFileSync(path.join(pipeline, "integration-evidence.md"), "# E\n- Gates: GREEN | x\n- Final tree still equals last gated tree: yes\n");
  writeFileSync(path.join(pipeline, "pr-draft.md"), "fix: it\n");
  writeFileSync(path.join(pipeline, "empty.log"), "");
  return { root, repo, triage, pipeline };
}

test("run dirs, listings, and named lookups resolve the newest runs", () => {
  const { repo, triage, pipeline } = fixture();
  const dirs = latestRunDirs(repo, 42);
  assert.equal(dirs.triage, triage);
  assert.equal(dirs.pipeline, pipeline);
  assert.equal(dirs.review, null);
  const items = listArtifacts(repo, 42);
  assert.ok(items.length >= 5);
  assert.ok(items.every((item, i) => item.id === `a${i + 1}`));
  assert.ok(!items.some((item) => item.name === "empty.log"), "zero-byte files are skipped");
  assert.equal(findNamedArtifact(repo, 42, ["repro-driver.json"]).name, "repro-driver.json");
  assert.equal(findNamedArtifact(repo, 42, ["nope.md"]), null);
  assert.deepEqual(listArtifacts(repo, 999), []);
});

test("only files inside the workflow-owned roots are servable", () => {
  const { root, repo, triage } = fixture();
  assert.ok(assertServableArtifact(repo, path.join(triage, "report.md")));
  const secret = path.join(root, "secret.txt");
  writeFileSync(secret, "no");
  assert.throws(() => assertServableArtifact(repo, secret), /outside the workflow-owned roots/);
  const link = path.join(triage, "escape.md");
  symlinkSync(secret, link);
  assert.throws(() => assertServableArtifact(repo, link), /outside the workflow-owned roots/);
});

test("staged diff comes from the retained fix worktree only", () => {
  const { root, repo } = fixture();
  const worktrees = path.join(root, "herdr-worktrees");
  const tree = path.join(worktrees, "issue-42-pipeline-abcd1234");
  mkdirSync(tree, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: tree, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.invalid"]);
  git(["config", "user.name", "t"]);
  writeFileSync(path.join(tree, "a.rs"), "fn main() {}\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  writeFileSync(path.join(tree, "a.rs"), "fn main() { fixed(); }\n");
  git(["add", "."]);
  assert.equal(fixWorktree(repo, 42), tree);
  const result = stagedDiff(repo, 42);
  assert.match(result.diff, /fixed\(\)/);
  assert.ok(stagedDiff(repo, 999).error);
});

test("the handoff digest is rationale-first and names what is missing", () => {
  const { repo } = fixture();
  const digest = assembleHandoff(repo, 42, (file) => readFileSync(file, "utf8"));
  assert.ok(!digest.error);
  assert.match(digest.summary, /^Handoff: herdr issue #42/);
  assert.match(digest.summary, /Root cause:\nThe cause\./);
  assert.match(digest.summary, /Why fixing matters:\nUsers lose panes\./);
  assert.match(digest.summary, /- Gates: GREEN/);
  const names = digest.files.map((file) => path.basename(file));
  assert.deepEqual(names.sort(), ["integration-evidence.md", "pr-draft.md", "report.md", "repro-driver.json", "why.md"].sort());
  assert.ok(assembleHandoff(repo, 999, () => "").error, "no triage run → explicit error");
});
