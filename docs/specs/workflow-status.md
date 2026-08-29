# Workflow status in the herdr sidebar

Goal: show active atomic workflow runs (name + current stage) under the agent
rows in herdr's sidebar, with a popup board for detail.

## Findings that drove the design

### Atomic side — where workflow state can be observed

- Atomic's extension API (`pi.on(...)`) has **no `workflow_*` hooks** and its
  `pi.events` bus never carries workflow lifecycle. An extension cannot
  subscribe to run/stage changes. (Verified against `@bastani/atomic` 0.9.13,
  `docs/extensions.md` + full grep of `dist/builtin/workflows/`.)
- Workflow run directories (`.atomic/workflows/runs/<id>/`) hold only artifacts
  and transcripts — no state files.
- **The chosen signal:** the workflow extension's opt-in status writer
  (`dist/builtin/workflows/src/extension/status-writer.ts`). With
  `{ "statusFile": true }` in `~/.atomic/agent/extensions/workflow/config.json`
  (global) or `<project>/.atomic/extensions/workflow/config.json`, atomic
  writes `<cwd>/.atomic/workflows/status.json` on **every** store update via
  temp-file + rename (torn reads impossible), with a guaranteed flush on
  terminal states. It contains the full `StoreSnapshot`: every run's
  `status` (`pending|running|paused|completed|failed|killed`) and every
  stage's `status` (`running|awaiting_input|…`) plus names and timings.
- Fallback signal (unused for now): `workflow.run.start` / `workflow.stage.*` /
  `workflow.run.end|blocked` custom entries in the session JSONL — always on,
  but an append-only log that needs folding and survives compaction rewrites.

Conclusion: **no atomic extension is required.** One config file opts into a
machine-readable status feed per project.

### Herdr side — where status can be displayed

- `herdr pane report-metadata --source plugin:… --token key=value` stores
  arbitrary per-pane tokens (key ≤32 chars `[A-Za-z0-9_-]`, value ≤80 chars,
  ≤32 keys/pane). Tokens support `--ttl-ms` (used here as a dead-man's switch)
  and are **not** cleared on agent exit and **not** persisted across server
  restart.
- Agent sidebar rows are configurable (`[ui.sidebar.agents] rows`) and accept
  **custom `$token` placeholders**; a row whose tokens are all empty elides to
  zero height — that is the "sublayout that only appears when a workflow runs".
- Do **not** use `report-agent` for this: hook-state reports would fight the
  real pi/atomic lifecycle integration for state authority (and are rejected
  when the integration owns the session). Metadata tokens are the documented
  lane for cosmetic/status info.
- Plugin v1 cannot draw native sidebar UI and there is no plugin hook for
  metadata/token change events, so the watcher is a small daemon rather than
  event hooks. Richer detail goes in a plugin **popup pane** (the board).

## Architecture

```
atomic (workflow ext, statusFile=true)
  └─ writes <cwd>/.atomic/workflows/status.json     (atomic rename, every update)

herdr plugin "atomic.workflows"
  [[startup]] → bin/start-watcher.mjs → detached bin/watcher.mjs
      every 2s:
        herdr agent list  →  panes + cwds
        read each cwd's status.json → fold active runs
        herdr pane report-metadata <pane> --source plugin:atomic.workflows
            --token wf=<run name> --token wf_stage=<stage> --ttl-ms 15000
        write $STATE/board.json (aggregate, for the popup)

  [[actions]] open-board → popup pane bin/board.mjs (renders board.json, q closes)

herdr sidebar (user config, shipped in README)
  [ui.sidebar.agents] rows += [ { $wf }, { $wf_stage } ]   ← elides when empty
```

## Failure behavior

- Watcher dies → tokens expire via 15 s TTL; sidebar row disappears.
- Workflow finishes → next tick explicitly clears tokens (faster than TTL).
- Herdr server restart → tokens are gone by design; the `[[startup]]` hook
  respawns the watcher, which re-reports within one tick.
- status.json missing (project not opted in) → project simply never shows.

## Future work

- Upstream idea: teach herdr's bundled pi/atomic integration to report the
  project's status.json path itself, removing the `agent list` polling.
- `agent.view.set` projection ("workflows only" sidebar filter) bound to an
  action.
- Windows support (paths + `platforms` in the manifest).
