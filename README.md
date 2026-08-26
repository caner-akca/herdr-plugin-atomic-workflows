# herdr-atomic-plugin

A small campaign cockpit for Herdr and Atomic. It ranks an issue queue, lets
you select several issues, and opens one durable Herdr tab and one isolated
Atomic session for each selected issue.

The plugin deliberately stops there. Workflow logic, evidence, code changes,
questions, pause/resume, and interruption remain inside each Atomic pane.

## Requirements

- Herdr 0.8.2 or newer.
- Atomic with the workflow extension and `statusFile` support.
- A Herdr workflow repository containing:
  - `herdr-triage-queue` with `mode="rank-only"`, `repo_dir`, and a typed
    `shortlist` output.
  - `herdr-bug-pipeline` with `repo_dir`.
  - `herdr-issue-triage` with `repo_dir`, forwarded by the pipeline.

Direct workflow runs remain compatible: an empty `repo_dir` falls back to
`ctx.cwd`.

## Setup

Link the local plugin:

```bash
herdr plugin link /path/to/herdr-atomic-plugin
```

The startup hook starts the watcher. During development, restart it after a
watcher change with the **Restart workflow watcher** action.

For compact task rows, add these optional sidebar tokens to
`~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "workspace", "tab"],
  ["agent", "state_text"],
  [{ token = "$task", fg = "#89b4fa", bold = true }],
  [{ token = "$phase", dim = true }, { token = "$progress", dim = true }],
  [{ token = "$attention", fg = "#f38ba8" }, { token = "$wf_cost", dim = true }],
]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace", "branch"],
  [{ token = "$wf_active", dim = true }, { token = "$wf_needy", fg = "#f38ba8" }],
]
```

Then run `herdr server reload-config`.

## Daily use

1. Open the Herdr repository as a Herdr workspace.
2. Invoke **Start issue campaign**. A focused `Issue queue` tab runs:

   ```text
   /workflow herdr-triage-queue mode="rank-only" shortlist_size=15 repo_dir="..."
   ```

3. Open **Workflow board** after ranking completes.
4. Use `j`/`k` to move, `space` to select, `a` to select the first five
   `fix-now` recommendations, `x` to clear, and `enter` to launch. A launch is
   intentionally capped at five tasks.
5. The plugin creates one background tab per selected issue and starts:

   ```text
   /workflow herdr-bug-pipeline issue=123 repo_dir="..." simplify="on" review=true
   ```

   Press `p` to switch the shortlist area to cached open pull requests. The
   same `j`/`k`, `space`, `x`, and `enter` keys launch up to five isolated
   review tasks:

   ```text
   /workflow herdr-code-review target="123" repo_dir="..."
   ```

6. On a task row, `enter` focuses its real Atomic pane. Answer questions and
   use Atomic controls there.

The board also retains the old run ledger: `l` opens legacy manually-started
workflow runs and `h` opens history. `b` returns to tasks.

## Identity and isolation

Every campaign and task has a UUID-backed manifest under Herdr's plugin state
directory:

```text
tasks/<task-id>/
├── task.json
├── project/.atomic/extensions/workflow/config.json
├── project/.atomic/workflows/status.json
├── sessions/
└── atomic-artifacts/
```

Atomic runs in `project/`, while the workflow's typed `repo_dir` points at the
real repository. Consequently, parallel tasks for the same repository cannot
overwrite one shared status file. `task.json` permanently binds task,
campaign, pane, tab, Atomic session, and workflow run identities.

Launching is deduplicated by repository + task kind + issue number. Selecting
an issue that already has an open task reuses that task instead of opening a
second run.

## Deliberate non-features

This version does not inject answers or Atomic control commands, create or
publish PRs, monitor CI, schedule hosts, provision VMs, archive tasks, or infer
semantic lifecycle phases with a model. The board shows Atomic's deterministic
run/stage state and focuses the pane where richer control already exists.

Manually started Atomic sessions are still shown through the older cwd-based
compatibility view, but only when exactly one pane owns that cwd. Managed task
panes always use task identity.

## Development checks

```bash
node --test test/*.test.mjs
node --check bin/watcher.mjs
node --check bin/board.mjs
```
