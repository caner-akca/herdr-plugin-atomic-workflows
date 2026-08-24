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
