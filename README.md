# herdr-atomic-plugin

Herdr plugin that surfaces **atomic workflow runs** in the herdr sidebar:
each agent pane whose project has an active workflow gets a sublabel with the
run name and current stage, and a popup board shows every run and stage.

## Setup

1. Opt atomic into its machine-readable workflow status feed (once, global):

   ```bash
   mkdir -p ~/.atomic/agent/extensions/workflow
   echo '{ "statusFile": true }' > ~/.atomic/agent/extensions/workflow/config.json
   ```

2. Link (or install) the plugin:

   ```bash
   herdr plugin link /path/to/herdr-atomic-plugin
   ```

3. Add the workflow rows to your herdr sidebar config
   (`~/.config/herdr/config.toml`), then `herdr server reload-config`:

   ```toml
   [ui.sidebar.agents]
   rows = [
     ["state_icon", "workspace", "tab"],
     ["agent", "state_text"],
     [{ token = "$wf", fg = "#89b4fa", bold = true }],
     [{ token = "$wf_stage", dim = true }],
     [{ token = "$wf_cost", dim = true }],
   ]

   # optional: workspace-level rollups on the Spaces rows
   [ui.sidebar.spaces]
   rows = [
     ["state_icon", "workspace", "branch"],
     [{ token = "$wf_active", dim = true }, { token = "$wf_needy", fg = "#f38ba8" }],
   ]
   ```

   The `$wf` rows take zero vertical space while no workflow is running.

4. Start the watcher (happens automatically at server startup via the plugin
   startup hook; to start it now):

   ```bash
   herdr plugin action invoke atomic.workflows.restart-watcher
   ```

## Use

- Run any atomic workflow (`/workflow <name>` or the `workflow` tool) in a
  pane — within ~2 s the sidebar shows `run-name` and its current stage,
  including `needs input: <stage>` when a stage is waiting on you.
- When a stage starts **waiting for input**, the sidebar token, the board,
  and a system notification (`herdr notification show`, following your
  `[ui.toast]` delivery config) all carry the **actual question and choices**
  from the stage's pending prompt — one toast per stage, re-armed when the
  stage moves on.
- The board shows per-stage elapsed time and model, failure details
  (`failureKind/failureCode`, retry countdown, resumable), atomic notices,
  and pending-stage counts. Scroll with `j`/`k` (or arrows), `g`/`G` to jump.
- **Cost telemetry:** per-stage and per-run USD cost + turn counts (from
  atomic's `modelAttempts[].usage`) in the board, and a `$wf_cost` sidebar
  token. This data exists *only* in the live status file — nothing else
  records it.
- **History:** press `h` on the board for the run ledger — every observed
  run's outcome, duration, and final cost, journaled by the watcher to
  NDJSON under the plugin state dir (`ledger/*.ndjson`, greppable) before
  atomic's session-start wipe destroys it. Runs that vanish mid-flight are
  recorded as `lost`; dead-file verdicts as `dead` (both marked as watcher
  verdicts, not atomic's word).
- **Workspace rollups:** `$wf_active` / `$wf_needy` tokens for the Spaces
  sidebar rows show per-workspace workflow load.
- **Workflows-only view:** the *Toggle workflows-only view* action filters
  herdr's Agents sidebar to panes with an active workflow (most
  attention-worthy first). The projection is transient in herdr; the watcher
  reapplies it on startup while toggled on.
- **Transcript deep links:** on the board, stages with a session transcript
  and runs with rendered transcripts get `[1]`-`[9]` markers — press the
  digit to open the file in a viewer tab (session `.jsonl` files are
  rendered entry-by-entry; `q` closes). Note: atomic prunes run artifacts
  after ~30 days.
- **Control verbs (dormant):** the board has a run cursor (`n`/Tab) and
  `p`/`r`/`i`/`Q` pause/resume/interrupt/quit keys, wired to a local bridge
  socket the watcher hosts. Actually delivering a verb needs an optional
  atomic extension that is **deliberately not bundled** (it would execute
  commands inside your atomic sessions — a trust decision each user should
  make by hand). Without it, verbs answer "no atomic bridge for this
  project" and nothing else changes. See `bin/install-extension.mjs` and
  the bridge protocol in `bin/watcher.mjs` if you want to build and audit
  your own: an extension connects to `<state-dir>/bridge.sock`, sends
  `{type:"hello", protocol:1, paneId, sessionId, cwd}`, and executes
  `{type:"command", text:"/workflow …"}` messages via `pi.sendUserMessage`
  — reject any text not starting with `/workflow `.
- **Stale/dead detection:** atomic's status file has no heartbeat, and a
  killed atomic leaves `status: "running"` on disk forever. While a run
  claims to be actively executing, no status write for 45 s marks it
  `(stale?)` and 5 min marks it `[dead?]` — paused and awaiting-input runs
  are exempt (their silence is expected).
- Open the board: right-click → **Workflow board**, or:

  ```bash
  herdr plugin action invoke atomic.workflows.open-board
  ```

  Optional keybinding:

  ```toml
  [[keys.command]]
  key = "prefix+shift+w"
  type = "plugin_action"
  command = "atomic.workflows.open-board"
  description = "workflow board"
  ```

## How it works

See `specs/workflow-status.md`. Short version: atomic atomically rewrites
`<project>/.atomic/workflows/status.json` on every workflow state change; a
small watcher daemon maps herdr agent panes to their projects, folds that file
into two ≤80-char metadata tokens per pane (`wf`, `wf_stage`, TTL'd so stale
state self-erases), and herdr's sidebar row templates render them.
