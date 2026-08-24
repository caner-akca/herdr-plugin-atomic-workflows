---
title: "Herdr plugin system, API/event boundary, and pane identity"
date: 2026-08-23
topic: herdr-plugin-and-api-boundary
repo: /Users/canerakca/Desktop/workspace/herdr
commit: d6dae883
method: direct source reading (rg/sed) by the orchestrator after the delegated pass aborted
status: evidence
---

# Herdr plugin system, API/event boundary, and pane identity

All paths are relative to `/Users/canerakca/Desktop/workspace/herdr` at commit `d6dae883`.

## 1. The plugin manifest — every capability a plugin has

`src/app/api/plugins/manifest.rs:12-35`:

```rust
#[derive(serde::Deserialize)]
struct RawPluginManifest {
    id: String,
    name: String,
    version: String,
    min_herdr_version: Option<String>,
    description: Option<String>,
    platforms: Option<Vec<RawPlatform>>,
    build: Vec<RawPluginManifestBuild>,
    startup: Vec<RawPluginManifestStartup>,
    actions: Vec<RawPluginManifestAction>,
    events: Vec<RawPluginManifestEventHook>,
    panes: Vec<RawPluginManifestPane>,
    link_handlers: Vec<RawPluginManifestLinkHandler>,
}
```

Five capability kinds, all of them **"run this argv"**:

| Kind | Shape | Source |
|---|---|---|
| `build` | `{ platforms?, command: Vec<String> }` | `manifest.rs:37-42` |
| `startup` | `{ platforms?, command: Vec<String> }` | `manifest.rs:44-49` |
| `actions` | `{ id, title, description?, contexts: Vec<PluginActionContext>, platforms?, command }` | `manifest.rs:51-62` |
| `events` | `{ on: String, platforms?, command }` | `manifest.rs:64-69` |
| `panes` | `{ id, title, description?, platforms?, placement, width?, height?, command }` | `manifest.rs:71-84` |
| `link_handlers` | `{ id, title, pattern, action, platforms? }` | `manifest.rs:86-94` |

Platforms are a closed set — `linux | macos | windows`, anything else is
`invalid_plugin_platform` (`manifest.rs:96-116`). Id caps: `PLUGIN_ID_MAX_CHARS = 120`,
`PLUGIN_ACTION_ID_MAX_CHARS = 120` (`manifest.rs:8-9`).

**There is no rendering capability.** A plugin cannot register a sidebar row, a sub-layout, a
custom widget, or a draw callback. It can only (a) run a command, and (b) open a *terminal pane*
running a command.

### 1.1 Plugin panes are real terminal panes

```rust
pub enum PluginPanePlacement { #[default] Overlay, Popup, Split, Tab, Zoomed }
```
— `src/api/schema/plugins.rs:445-452`

Control methods: `plugin.pane.open`, `plugin.pane.focus`, `plugin.pane.close` —
`src/api/schema.rs` (`PluginPaneOpen` / `PluginPaneFocus` / `PluginPaneClose`), params at
`src/api/schema/plugins.rs:455-465`. A plugin pane is a PTY running the plugin's argv, placed by
one of the five placements. It is *not* a sub-layout of an agents-pane row.

## 2. Execution model

`startup` commands run once per plugin at startup, sorted by `plugin_id`, filtered by
`enabled && plugin_manifest_available(plugin) && !plugin.startup.is_empty()` —
`src/app/api/plugins/runtime.rs:189-215`.

Event hooks are fire-and-forget subprocess launches per matching event —
`src/app/api/plugins/runtime.rs:218-262`:

```rust
pub(crate) fn run_plugin_event_hooks(&mut self, event: &crate::api::schema::EventEnvelope) {
    let event_name = event.event.dot_name();
    if !crate::api::schema::PLUGIN_HOOK_EVENT_KINDS.contains(&event.event) { return; }
    ...
    let _ = self.start_plugin_command(&plugin, None, Some(event_name.to_string()),
                                      hook.command.clone(), &context, event_json.clone());
}
```

Plugin stdout/stderr is captured with a byte cap (`read_capped_plugin_output`,
`src/app/api/plugins/runtime.rs:~283`), and command logs are ring-buffered to
`PLUGIN_COMMAND_LOG_LIMIT` entries (`runtime.rs:265-272`), readable via `plugin.log.list`.

**Plugin stdout is not a data channel into Herdr state.** It is captured for logging only. To
change Herdr state a plugin must call back through the Herdr CLI/API (e.g.
`herdr pane report-metadata`), exactly as the prior prototype does.

## 3. The plugin hook event set (closed)

`src/api/schema/events.rs:286-309`:

```rust
pub const PLUGIN_HOOK_EVENT_KINDS: &[EventKind] = &[
    WorkspaceCreated, WorkspaceUpdated, WorkspaceClosed, WorkspaceRenamed, WorkspaceMoved,
    WorkspaceReordered, WorkspaceFocused,
    WorktreeCreated, WorktreeOpened, WorktreeRemoved,
    TabCreated, TabClosed, TabRenamed, TabMoved, TabFocused,
    PaneCreated, PaneClosed, PaneFocused, PaneMoved, PaneExited,
    PaneAgentDetected, PaneAgentStatusChanged,
];
```

Relevant facts:

- `PaneExited` and `PaneClosed` are hookable → a plugin **can** get a cleanup trigger when the
  pane running Atomic dies.
- There is **no timer/tick event**. A plugin that wants to poll must run a long-lived `startup`
  process and do its own sleeping.
- `PaneAgentStatusChanged` fires on Herdr's own detection, not on Atomic-internal state.

Plugin invocation context is derived per event (`src/app/api/plugins/context.rs:39-160`) and
carries `workspace_id`, `workspace_label`, `workspace_cwd`, `worktree`, `tab_id`, `tab_label`,
`focused_pane_id`, `focused_pane_cwd`, `focused_pane_agent`, `focused_pane_status`,
`selected_text`, `invocation_source`, `correlation_id`, `clicked_url`, `link_handler_id`
(`context.rs:5-30`).

## 4. Environment handed to a plugin command

`src/app/api/plugins/env.rs:15-30`:

```rust
vec![
    ("HERDR_PLUGIN_ROOT",       plugin.plugin_root.clone()),
    ("HERDR_PLUGIN_CONFIG_DIR", config_dir),
    ("HERDR_PLUGIN_STATE_DIR",  state_dir),
]
```

Extended in `src/app/api/plugins/runtime.rs:39-80` with, at minimum:
`HERDR_ENV=1`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_BIN_PATH`
(from `std::env::current_exe()`), and conditionally `HERDR_PLUGIN_ACTION_ID`,
`HERDR_PLUGIN_EVENT`, `HERDR_PLUGIN_EVENT_JSON`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`,
`HERDR_PANE_ID`, `HERDR_PLUGIN_CLICKED_URL`, `HERDR_PLUGIN_LINK_HANDLER_ID`.

`HERDR_PLUGIN_STATE_DIR` is a per-plugin writable directory — the natural home for a plugin's own
cache/state (`src/plugin_paths.rs`).

## 5. Pane identity, and how a pane process learns it

`src/pane.rs:143-151`:

```rust
cmd.env(crate::integration::HERDR_WORKSPACE_ID_ENV_VAR, workspace_id);
cmd.env(crate::integration::HERDR_TAB_ID_ENV_VAR, tab_id);
cmd.env(crate::integration::HERDR_PANE_ID_ENV_VAR, pane_id);
...
cmd.env_remove(crate::integration::HERDR_PANE_ID_ENV_VAR);
```

Constants (`src/integration/env.rs:8-10`):

```rust
pub(crate) const HERDR_PANE_ID_ENV_VAR: &str      = "HERDR_PANE_ID";
pub(crate) const HERDR_TAB_ID_ENV_VAR: &str       = "HERDR_TAB_ID";
pub(crate) const HERDR_WORKSPACE_ID_ENV_VAR: &str = "HERDR_WORKSPACE_ID";
```

So **every process spawned in a Herdr pane inherits `HERDR_PANE_ID`** — this is the correlation
key between a Herdr pane and a process running inside it, and it is what the prior prototype used.

Known caveat, reproduced by the prototype author (see the prototype research doc, §5): Herdr issue
**#2012** — `pane current` trusts an inherited `$HERDR_PANE_ID` and only checks the pane *exists*,
never that the caller *owns* it. Any child process, including a nested/unrelated one, can therefore
address a pane it does not own. This is a **trust transition to make explicit** in any design that
accepts pane-addressed status reports.

`HERDR_ENV=1` (`src/main.rs:11-12`) is the nested-herdr guard; `HERDR_BIN_PATH` names the binary
that launched the server.

## 6. The status-report doors that already exist

From `src/api/schema.rs:197-206`, three pane report methods:

| Method | Params struct | Purpose |
|---|---|---|
| `pane.report_agent` | `PaneReportAgentParams` | claim/report which agent runs in a pane |
| `pane.report_agent_session` | `PaneReportAgentSessionParams` | report the agent's **session identity** |
| `pane.report_metadata` | `PaneReportMetadataParams` | display-only tokens + labels + display name |

`PaneReportAgentSessionParams` (`src/api/schema/panes.rs:384-396`):

```rust
pub struct PaneReportAgentSessionParams {
    pub pane_id: String,
    pub source: String,
    pub agent: String,
    pub seq: Option<u64>,
    pub agent_session_id: Option<String>,
    pub agent_session_path: Option<String>,
    pub session_start_source: Option<String>,
}
```

This is the existing joint for "**this pane is running agent X, session Y, whose transcript is at
path Z**". It is the closest existing shared-runtime-fact door to what this feature needs, and it
already carries an opaque agent session id — but it carries **no workflow list**.

Also present: `pane.clear_agent_authority`, `pane.release_agent` (`src/api/schema.rs:203-206`) —
the existing cleanup doors.

## 7. Prior art: how other agents report state to Herdr

`src/integration/` ships per-agent reporter assets, one directory per agent, e.g.
`src/integration/assets/claude/herdr-agent-state.sh`, `.../codex/`, `.../cursor/`,
`.../copilot/`, `.../droid/`, `.../grok/`, `.../qodercli/`, `.../devin/`, `.../kilo/herdr-agent-state.js`,
`.../omp/herdr-agent-state.ts`, `.../pi/herdr-agent-state.ts`, plus a shared test at
`src/integration/assets/herdr-agent-state.test.ts`.

Notably `src/integration/assets/pi/herdr-agent-state.ts` exists — Atomic's upstream lineage is Pi,
so a Pi-shaped reporter is the closest existing template for an Atomic reporter. The registry that
installs these lives in `src/integration/registry.rs` with types in `src/integration/types.rs`,
targets in `targets.rs`, actions in `actions.rs`, and env in `env.rs`
(`src/integration/mod.rs:17` re-exports `apply_pane_base_env`, `HERDR_PANE_ID_ENV_VAR`,
`HERDR_TAB_ID_ENV_VAR`, `HERDR_WORKSPACE_ID_ENV_VAR`).

The pattern is uniform: **the agent pushes into Herdr through the CLI/API; Herdr never reaches into
the agent.**

## 8. The events/subscription surface for external clients

`src/api/schema.rs:210-216` exposes `events.subscribe` (`EventsSubscribeParams`) and `events.wait`
(`EventsWaitParams`), plus `pane.wait_for_output`. The full event kind set is `KNOWN_EVENT_KINDS`
(`src/api/schema/events.rs`), of which `PLUGIN_HOOK_EVENT_KINDS` (§3) is the plugin-visible subset.
The public JSON schema is published at `docs/next/api/herdr-api.schema.json`.

## 9. What a Herdr plugin alone can and cannot do (evidence-backed)

**Can:**

- Run a long-lived process at startup (`startup`, `runtime.rs:189-215`).
- React to 22 workspace/tab/pane lifecycle events, including `PaneExited`/`PaneClosed`
  (`events.rs:286-309`).
- Learn the pane/tab/workspace it was invoked for, via `HERDR_*` env and
  `HERDR_PLUGIN_CONTEXT_JSON` (`runtime.rs:39-80`).
- Write into per-plugin config/state dirs (`env.rs:15-30`).
- Call the full Herdr CLI/API, including `pane.report_metadata` and `pane.report_agent_session`.
- Open a terminal pane in one of five placements (`plugins.rs:445-452`).

**Cannot:**

- Render anything. No draw hook, no widget, no row, no sub-layout. The entire visual surface a
  plugin can influence for an agent row is the flat token map plus `display_agent`, `title`, and
  `state_labels` (`panes.rs:399-426`).
- Add a sidebar row. Row arity lives in user config, capped at 16 (`config/sidebar.rs:7`).
- Receive a timer/tick event; polling requires its own loop in a `startup` process
  (`events.rs:286-309` contains no timer kind).
- Return data to Herdr through stdout; output is capped and log-only (`runtime.rs:265-283`).

## 10. Project rules that constrain this feature

From `AGENTS.md` (quoted in full in the agents-pane research doc):

- `AGENTS.md:31` — render is pure; never mutate state during render.
- `AGENTS.md:40-56` — multiplicative cost paths; no filesystem I/O or process-tree inspection in
  pane-scaled render/layout loops; profile with 1 and ≥15 populated panes via
  `just bench-render-scale`.
- `AGENTS.md:68-81` — runtime/client boundary: shared runtime/session facts go through
  server/API/event paths; presentation state stays in the TUI/client; **use neutral server/API
  names, not UI-surface names like sidebar, row, card, or widget.**
- `AGENTS.md:30` — `AppState` is pure data, testable without PTYs or async.

## 11. Open code-answerable questions still unresolved

- Exact `start_plugin_command` timeout/kill policy for a long-lived `startup` process was not read
  line by line (`src/app/api/plugins/runtime.rs:30-120`); the design should not assume Herdr
  supervises or restarts it.
- Whether `plugin.pane.open` panes appear in the agents pane list was not confirmed; the design
  does not depend on it.
