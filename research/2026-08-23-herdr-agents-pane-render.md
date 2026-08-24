---
title: "Herdr agents pane — row layout, metadata tokens, render purity"
date: 2026-08-23
topic: herdr-agents-pane-render
repo: /Users/canerakca/Desktop/workspace/herdr
commit: d6dae883
method: direct source reading (rg/sed) plus a delegated codebase-analyzer pass
status: evidence
---

# Herdr agents pane — row layout, metadata tokens, render purity

All paths below are relative to `/Users/canerakca/Desktop/workspace/herdr` at commit `d6dae883`.

## 1. How an agent row is built and drawn

Herdr separates **row layout configuration** from **reported metadata values**.

- `[ui.sidebar.agents]` and `[ui.sidebar.spaces]` define typed rows, token order, per-token
  styling, per-agent overrides, and spacing — `src/config/sidebar.rs:103-132`,
  `src/config/sidebar.rs:372-430`.
- Pane reporters patch runtime metadata tokens. Pane tokens live on `TerminalState`; workspace
  tokens live on `Workspace` — `src/terminal/state.rs:120-142`, `src/workspace.rs:177-205`.
- Expanded desktop sidebar rendering resolves configured tokens against current state and
  metadata — `src/ui/sidebar/tokens.rs:38-142`, `src/ui/sidebar.rs:1209-1405`,
  `src/ui/sidebar.rs:1432-1549`.

### 1.1 Rows are a static, config-declared shape

Rows are `Vec<Vec<Token>>`; each inner vector renders as exactly one line
(`src/config/sidebar.rs:7-35`). Hard caps, quoted:

```rust
const MAX_SIDEBAR_ROWS: usize = 16;
const MAX_SIDEBAR_TOKENS_PER_ROW: usize = 16;
const DEFAULT_SIDEBAR_ROW_GAP: u16 = 0;
```
— `src/config/sidebar.rs:7-9`

Violations fail config deserialization with `"sidebar layouts may contain at most 16 rows"` /
`"sidebar rows may contain at most 16 tokens"` — `src/config/sidebar.rs:21-35`.

### 1.2 The agent token vocabulary is closed

```rust
pub enum AgentSidebarToken {
    StateIcon, StateText, Workspace, Tab, Pane, Agent,
    TerminalTitle, TerminalTitleStripped,
    Custom(String),
    Styled { token: Box<AgentSidebarToken>, style: SidebarTokenStyle },
}
```
— `src/config/sidebar.rs:103-132`

Custom tokens are written `$name` in config, 1–32 ASCII alphanumeric / `_` / `-`
(`src/config/sidebar.rs:187-207`, `src/config/sidebar.rs:280-348`). Styled token objects accept
only `fg`, `bold`, `dim`; colors must be `#RGB` or `#RRGGBB`; unknown fields are rejected
(`src/config/sidebar.rs:152-162`, `src/config/sidebar.rs:45-93`).

Defaults are compact — agents: `[state_icon, workspace, tab]`, then `[agent]`; spaces:
`[state_icon, workspace]`, then `[branch, git_status]`; both `row_gap` default `0`
(`src/config/sidebar.rs:390-425`). `rows_by_agent` replaces the general agent layout when the
effective canonical agent matches (`src/config/sidebar.rs:382-387`).

### 1.3 Resolution, truncation, and height

`agent_rows` / `space_rows` convert configured tokens into `ResolvedToken` values. Missing
optional values are removed; **a row disappears when all its configured tokens resolve to
nothing** — `src/ui/sidebar/tokens.rs:38-89`, `src/ui/sidebar/tokens.rs:100-142`. Pane custom
tokens are read from `AgentPanelEntry.tokens` (`src/ui/sidebar/tokens.rs:76-80`).

Separators are `" · "`, except a state icon or a following git-status token, which use a single
space — `src/ui/sidebar/tokens.rs:144-152`.

`resolved_token_spans` computes fixed widths for icons/arrows, computes text widths, drops
flexible tokens that do not fit, re-enables later flexible tokens when space permits, distributes
remaining width, truncates with `truncate_end`, and applies per-token style overrides —
`src/ui/sidebar.rs:1012-1186`, `src/ui/sidebar.rs:1188-1207`.

Agent entry height is derived from the number of **resolved** agent rows —
`src/ui/sidebar.rs:196-221`, `src/ui/sidebar.rs:545-564`. `row_gap` is inserted between ordinary
entries; worktree children stay packed — `src/ui/sidebar.rs:233-237`, `src/ui/sidebar.rs:566-571`.

Collapsed desktop and mobile views use fixed compact layouts and ignore the configured multi-row
layout entirely — `src/ui/sidebar.rs:789-878`, `src/ui/mobile.rs:532-565`,
`src/ui/mobile.rs:589-658`.

State-label metadata overrides the displayed state *text* for keys such as `idle`, `working`,
`blocked`, `done`, `unknown`. It does **not** change the state icon or the semantic state —
`src/ui/sidebar.rs:545-552`, `src/terminal/metadata.rs:432-453`.

## 2. Pane metadata tokens: the exact grammar and limits

Wire shape (`src/api/schema/panes.rs:399-426`):

```rust
pub struct PaneReportMetadataParams {
    pub pane_id: String,
    pub source: String,
    pub agent: Option<String>,
    pub applies_to_source: Option<String>,
    pub title: Option<String>,
    pub display_agent: Option<String>,
    pub state_labels: HashMap<String, String>,
    pub tokens: HashMap<String, Option<String>>,   // ← the whole token surface
    pub clear_title: bool,
    pub clear_display_agent: bool,
    pub clear_state_labels: bool,
    pub seq: Option<u64>,
    pub ttl_ms: Option<u64>,                       // 1 ..= 86_400_000
}
```

Validation constants, quoted verbatim from `src/app/api_helpers.rs:202-208`:

```rust
pub(super) const METADATA_TTL_MAX_MS: u64 = 86_400_000;
pub(super) const METADATA_SOURCE_MAX_CHARS: usize = 80;
const METADATA_TTL_MIN_MS: u64 = 1;
const MAX_METADATA_TOKEN_KEYS_PER_REQUEST: usize = 16;
pub(super) const MAX_METADATA_TOKEN_KEYS_PER_RESOURCE: usize = 32;
const MAX_METADATA_TOKEN_KEY_LEN: usize = 32;
const MAX_METADATA_TOKEN_VALUE_LEN: usize = 80;
```

Normalization (`src/app/api_helpers.rs:243-278`):

- Empty patch → error `"missing token to set or clear"`.
- More than 16 keys in one request → error.
- Key must be non-empty, ≤32 bytes, ASCII alphanumeric or `_`/`-`, else
  `"invalid metadata token key: {key}"`.
- Value: trimmed, **all control characters filtered out**, truncated to 80 chars; an empty
  normalized value becomes a *clear*. Documented transformation: `"  review\nready  "` →
  `"reviewready"`.

Additional handler-level rejections (`src/app/api/panes.rs:1385-1427`): stale `seq`,
process-exit-blocked reports, more than 32 tokens per resource, more than 32 sequenced token
sources. Stale sequenced reports return a successful **no-op** (`src/app/api/panes.rs:1392-1393`).

TTL applies only to the keys in the current patch; updating a key without TTL removes its previous
expiry — `src/metadata_tokens.rs:43-67`. Expiry removes tokens at or before the current time and
emits pane/workspace update events — `src/metadata_tokens.rs:91-103`,
`src/app/actions.rs:1067-1106`, `src/app/runtime.rs:436-449`.

Tokens are runtime-only: restore initializes them empty — `src/persist/restore.rs:405-423`.

## 3. Verdict: can pane metadata tokens render a nested workflow list?

**NO — not as a nested list.** Proof, in four independent structural limits:

1. **The value type is a flat scalar map.** `tokens: HashMap<String, Option<String>>`
   (`src/api/schema/panes.rs:414`). There is no array, no nested object, no repeated-key form.
   Every value is one ≤80-char, control-character-free single-line string
   (`src/app/api_helpers.rs:208`, `:267-275`).
2. **Control characters are stripped**, so a caller cannot smuggle `\n` into one token to fake
   multiple lines — `src/app/api_helpers.rs:269-272`.
3. **The row count is static and owned by user config, not by the reporter.** Rows are declared in
   `[ui.sidebar.agents].rows` and capped at 16 (`src/config/sidebar.rs:7`, `:21-35`). Nothing in
   the metadata path can add a row; `AgentPanelEntry.tokens` only fills slots that the user's
   config already names (`src/ui/sidebar/tokens.rs:76-80`).
4. **Per-pane token capacity is 32** (`src/app/api_helpers.rs:206`), and a row holds ≤16 tokens
   (`src/config/sidebar.rs:8`).

The only representable approximation is **fixed-arity slotting**: the user pre-declares N rows of
`$wf1`, `$wf2`, … in their own config, and a reporter packs one workflow per slot. That is a
degenerate list — arity is chosen by the human editing `config.toml`, an unconfigured slot renders
nothing (`src/ui/sidebar/tokens.rs:38-89`), and the practical ceiling is 16 rows / 32 tokens with
80 chars each.

There is **no sub-layout, tree, or child-row primitive** for an agent entry. The only nesting the
sidebar knows is workspace→worktree-child grouping, which is computed from workspace state, not
from metadata (`src/ui/sidebar.rs:233-237`, `src/ui/sidebar.rs:566-571`).

## 4. Render purity and the multiplicative-cost rule

`AGENTS.md:31`:

> **Render is pure.** `compute_view()` handles geometry and mutations. `render()` takes
> `&AppState` and only draws. Never mutate state during render.

`AGENTS.md:40-56` (multiplicative performance paths):

> Treat work reachable from view computation, rendering, background-pane resizing, PTY parsing,
> detection, and client frame fanout as multiplicative. … Inside pane-scaled render and layout
> loops: Use narrow terminal-state accessors. Do not collect aggregate input state, format
> terminal snapshots, inspect process trees, perform filesystem I/O, or allocate when one scalar
> fact is enough. … When a change adds or widens work in one of these loops, profile fixed geometry
> with 1 and at least 15 populated panes and report the scaling delta. Use `just bench-render-scale`.

This forbids reading a status file, polling a socket, or spawning a process from the sidebar
render/layout path.

## 5. Runtime/client boundary rule (verbatim)

`AGENTS.md:68-81`:

> Herdr is migrating toward a server-owned runtime protocol with the TUI as one client. New work
> should not deepen the current server/TUI coupling.
>
> Before adding state, API fields, events, commands, or socket messages, classify the feature:
>
> - Shared runtime/session fact: belongs in server state and should be exposed through the JSON
>   API/event path when practical.
> - TUI presentation state: belongs only in the TUI/client layer.
>
> Do not add new shared behavior that only works through the private TUI client socket. Use neutral
> server/API names, not UI-surface names like sidebar, row, card, or widget.
>
> Examples:
> - Pane/agent metadata, process state, terminal state, events: server/runtime.
> - Sidebar layout, token placement, colors, selection, modals, mouse/viewport state: TUI/client.

**Consequence for this feature:** "which Atomic workflows are running in this session and what is
their status" is a *shared runtime/session fact* and must travel the server/API/event path. "How a
workflow list is laid out under an agent row" is *TUI presentation state*.

## 6. Data flow, end to end

1. CLI parses `--token NAME=VALUE`, `--clear-token NAME`, `--seq`, `--ttl-ms`, and presentation
   fields — `src/cli/pane.rs:1437-1575`, `src/cli/spec.rs:677-694`.
2. API validates pane, source, TTL, token patch, presentation text, state labels —
   `src/app/api/panes.rs:1290-1369`; helpers at `src/app/api_helpers.rs:202-279`.
3. Handler rejects stale/blocked/over-capacity reports — `src/app/api/panes.rs:1385-1427`.
4. Token patches apply to `terminal.metadata_tokens`; changed tokens bump `terminal.revision`,
   reschedule expiry, and emit `PaneUpdated` — `src/app/api/panes.rs:1428-1459`.
5. Presentation fields forward as `HookMetadataReported` into `TerminalState::set_agent_metadata`
   — `src/app/api/panes.rs:1438-1452`, `src/app/actions.rs:2857-2887`.
6. `Workspace::pane_details` copies token values into `AgentPanelEntry`, which the expanded sidebar
   resolves and renders — `src/workspace/aggregate.rs:38-69`, `src/ui/sidebar.rs:149-180`.

Metadata methods are classified as UI-changing requests (`src/api/mod.rs:22-35`, `:68-73`). In
headless mode a changed request triggers a full render, geometry computation, in-memory buffer
render, frame build, and stream to clients — `src/server/headless.rs:3580-3595`, `:3693-3701`,
`src/server/render_stream.rs:304-345`, `src/server/headless.rs:4478-4512`.

Tokens are exposed on the API surface: `WorkspaceInfo.tokens`, `PaneInfo.tokens`, `AgentInfo.tokens`
— `src/app/creation.rs:444-466`, `:492-516`, `src/api/schema/agents.rs:183-205`.

## 7. Render cost

Sidebar height per agent entry is `number of resolved rows` (`src/ui/sidebar.rs:545-564`), so a
fixed-arity slot design costs `rows × panes` span resolution per render. `resolved_token_spans`
allocates per row (`src/ui/sidebar.rs:1012-1186`). `just bench-render-scale` is the prescribed
scaling harness (`AGENTS.md:56`).

## 8. Open code-answerable questions still unresolved

None material to the design decision. Two follow-ups deferred as non-blocking:

- Exact allocation count inside `resolved_token_spans` per row was not profiled; `AGENTS.md:56`
  prescribes `just bench-render-scale` as the measurement, which belongs in the test plan rather
  than in research.
- `src/ui/sidebar.rs` line anchors for the collapsed/mobile paths were taken from the delegated
  analyzer pass and spot-checked, not re-read line by line.
