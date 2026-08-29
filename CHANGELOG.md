# Changelog

## 0.9.3 — 2026-08-29

- Restructure for publication: pure logic moved from `bin/` to `lib/`
  (entrypoints referenced by `herdr-plugin.toml` stay in `bin/`; tests import
  only `lib/`).
- Add `.env.example`, `config/telegram.json.example`, `justfile`, CI workflow,
  `package.json`, and this changelog.
- Design notes moved to `docs/design/`, specs to `docs/specs/`.
- No behavior changes.

## 0.9.2 — 2026-08-28

- Review hardening (cluster C): sanitize external terminal text everywhere it
  is displayed (OSC/CSI/ESC/C0/C1 stripped), refuse workflow argument values
  the pane tokenizer cannot round-trip, ledger index updates under the file
  lock with atomic writes.

## 0.9.1 — 2026-08-28

- Review hardening (cluster A): single verified watcher owner per state root
  (JSON identity, newest claimant wins, verified-command-line kills only),
  truthful liveness (a quiet status file is only ever *quiet*; terminal death
  requires pane evidence), launch admission under a cross-process lock,
  10-minute `launching` deadline, per-task failure isolation surfaced as
  `board.json.health`.

## 0.9.0 — 2026-08-28

- Telegram cockpit: long-polling daemon with a closed typed command grammar.
  Observe runs and cost, fetch any artifact, launch tasks after inline-button
  confirmation, and hand curated evidence digests to a maintainer chat whose
  decisions are recorded — never executed.

## 0.8.0 — 2026-08-27

- Campaign cockpit: UUID-backed task manifests, one isolated Atomic project
  per task, batch launches from the ranked issue board, PR review tasks,
  dedupe by repository + kind + target, five-task launch cap.

## 0.7.0 and earlier

- Event-driven watcher core, sidebar tokens, popup board, run ledger with
  cost, workflows-only agent view, stage-input notifications, initial release.
