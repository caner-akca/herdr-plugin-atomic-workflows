---
title: "Atomic workflow status, lifecycle, extension API, and session identity"
date: 2026-08-23
topic: atomic-workflow-status-and-extension-api
package: "@bastani/atomic"
version: 0.9.13
root: /Users/canerakca/.bun/install/global/node_modules/@bastani/atomic
method: delegated codebase-analyzer pass plus direct orchestrator reads of dist/ TypeScript sources and docs
status: evidence
---

# Atomic workflow status, lifecycle, extension API, and session identity

Package version confirmed by `node -e "require('.../package.json')"` → `@bastani/atomic 0.9.13`
(`type: module`). Paths below are relative to
`/Users/canerakca/.bun/install/global/node_modules/@bastani/atomic`. The published `dist/` ships
readable TypeScript sources plus `.d.ts`, so every claim here is source-anchored.

## 1. The extension event surface has no workflow events

`dist/core/extensions/api-types.d.ts:22-59` enumerates every `ExtensionAPI.on()` overload:

```
resources_discover, session_info_changed, session_start, session_before_switch,
session_before_fork, session_before_compact, session_compact, session_shutdown,
session_before_tree, session_tree, context, before_provider_request,
before_provider_headers, after_provider_response, before_agent_start, agent_start,
agent_end, agent_settled, turn_start, turn_end, message_start, message_update,
message_end, tool_execution_start, tool_execution_update, tool_execution_end,
model_select, thinking_level_select, tool_call, tool_result, user_bash,
project_trust, input
```

**No workflow run or stage event appears in that union.** At runtime `createExtensionAPI()` stores
arbitrary event names in a handler map (`dist/core/extensions/loader-api.js:8-16`), but
`ExtensionRunner` only invokes handlers when Atomic explicitly emits a matching host event
(`dist/core/extensions/runner.js:279-329`), and workflow execution never calls
`ExtensionRunner.emit()` for run/stage lifecycle.

The other capabilities an extension does have (`api-types.d.ts:60-140`): `registerTool`,
`registerCommand`, `registerShortcut`, `registerFlag`/`getFlag`, `getWorkflowResources`,
`refreshWorkflowResources?`, `registerMessageRenderer`, `registerMarkdownTransformer`,
`registerEntryRenderer`, `sendMessage`/`sendMessages`, `sendUserMessage`, `appendEntry`,
`setSessionName`/`getSessionName`, `setLabel`, `exec`, `getActiveTools`/`getAllTools`/`setActiveTools`.

`pi.events` is a separate arbitrary bus (`dist/core/event-bus.d.ts:1-8`;
`dist/core/extensions/loader-api.js:181-189`). Workflow code uses it only for `mcp.scope.set`
(`builtin/workflows/src/extension/mcp.ts:74-108`) and `atomic:workflow-stage-late-message`
(`builtin/workflows/src/extension/wiring.ts:274-300`). It does **not** publish run/stage lifecycle
there.

**Consequence:** a third-party Atomic extension cannot subscribe to workflow lifecycle today
without an Atomic core change.

## 2. The lifecycle callbacks that do exist — `RunOpts`

`dist/builtin/workflows/src/authoring.d.ts:183-220` (documented at `docs/workflows.md:3694-3758`):

```ts
readonly onRunStart?:  (snapshot: RunSnapshot) => void;
readonly onStageStart?: (runId: string, snapshot: RunSnapshot) => void;
readonly onStageEnd?:   (runId: string, snapshot: RunSnapshot) => void;
readonly onRunEnd?:     (runId: string, status: RunStatus, result?: WorkflowOutputValues,
                         error?: string, exitReason?: string) => void;
```

These are options to the programmatic `run()` API, not an ambient event feed.
`run()` validates the definition/inputs, enforces `maxDepth`, creates a `RunSnapshot`, records it in
the store, then invokes `onRunStart` **before** the executor `try` block
(`builtin/workflows/src/engine/run.ts:105-129`, `:131-235`, `:213-220`).

Stage callbacks fire from `createWorkflowStageFactory()`
(`runs/foreground/executor-stage-factory.ts:95-133`, `:414-420`), the first real stage call
(`runs/foreground/executor-stage-call.ts:161-195`), replay stages
(`executor-stage-replay.ts:59-78`), child-workflow boundaries (`executor-child-boundary.ts:182-212`)
and prompt nodes (`executor-prompt-nodes.ts:119-164`). Stage completion records the terminal
snapshot before `onStageEnd` (`executor-stage-factory.ts:301-357`).

Terminal paths: normal completion → `engine/run.ts:596-621`; external cancellation → `killed`
(`runs/foreground/executor-lifecycle.ts:372-403`); ordinary failure → `failed`
(`engine/run-terminal-failure.ts:12-52`); **recoverable provider failure stays `running` with
blocked metadata and does NOT call `onRunEnd`** (`executor-lifecycle.ts:439-480`); graceful quit
pauses without a terminal `run.end` (`engine/run.ts:427-443`).

Known gap: nested `ctx.workflow()` runs forward *stage* callbacks through `childRunOptions` but
**not** `onRunStart`/`onRunEnd` (`engine/run.ts:323-346`,
`engine/primitives/workflow.ts:119-132`). The bundled runtime supplies no custom callbacks at all —
named dispatch builds `RunOpts` without those fields (`extension/runtime.ts:161-175`).

## 3. ⭐ The status file — the one machine-readable live status door that ships today

`docs/workflows.md:3484`:

> | `statusFile` | `false` | Write a derived status file; defaults under `.atomic/workflows/status.json` when enabled |

Config lives at `.atomic/extensions/workflow/config.json` (project) or
`~/.atomic/agent/extensions/workflow/config.json` (global) — `docs/workflows.md:3440-3475`.

Implementation, `dist/builtin/workflows/src/extension/status-writer.ts`, header comment verbatim
(`:1-17`):

```
 * Status file writer — subscribes to store updates and emits an atomic
 * status JSON file for CI polling.
 *
 * Behaviour:
 * - Only active when config.statusFile === true.
 * - Default path: <projectRoot>/.atomic/workflows/status.json
 * - Atomic write via temp-file + rename (no torn reads by CI consumers).
 * - Flushes on every store update; guaranteed to flush on run terminal states
 *   (completed | failed | killed).
 * - Write errors surfaced as level:"warning" WorkflowNotice via store;
 *   duplicate errors are deduplicated so one notice per distinct error message.
```

Path resolution (`status-writer.ts:30`, `:62-69`):

```ts
const DEFAULT_STATUS_SUBPATH = join(CONFIG_DIR_NAME, "workflows", "status.json");
export function resolveStatusFilePath(config, opts = {}) {
    if (config.statusFilePath) return config.statusFilePath;
    const root = opts.projectRoot ?? process.cwd();
    return join(root, DEFAULT_STATUS_SUBPATH);
}
```

Atomic write (`status-writer.ts:79-85`):

```ts
export async function atomicWriteJson(path, content) {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, path);
}
```

Subscription and payload (`status-writer.ts:165-168`):

```ts
const unsubscribeStore = store.subscribe((snap: StoreSnapshot) => {
    pendingContent = JSON.stringify(snap, null, 2);
    void ensureDrain();
});
```

Wired into the extension runtime at `extension/extension-runtime-state.ts:37`, `:83`, `:230` —
`createStatusWriter(store, runtimeConfigRef.current)`, recreated on config change. When
`statusFile` is false it returns a no-op writer (`status-writer.ts:109-111`), and
`docs/workflows.md:3864` confirms the default-false path deliberately avoids the full snapshot
clone cost.

### 3.1 The payload schema

`dist/builtin/workflows/src/shared/store-types.ts:368-372`:

```ts
export interface StoreSnapshot {
    readonly runs: readonly RunSnapshot[];
    readonly notices: readonly WorkflowNotice[];
    readonly version: number;
}
```

`RunSnapshot` (`store-types.ts:285-366`), fields relevant to a monitor:

```ts
id, name, inputs, status: RunStatus, stages: StageSnapshot[], toolNodes?,
startedAt, endedAt?, durationMs?, accumulatedDurationMs?, pausedDurationMs?,
pausedAt?, quitAt?, pauseActor?, resumeActor?, resumeSource?, origin?, resumedAt?,
result?, error?, exited?, exitReason?,
failureKind?, failureCode?, failureRecoverability?, failureDisposition?,
retryAfterMs?, blockedAt?, failureMessage?, failedStageId?, failedToolNodeId?,
resumable?,
parentRunId?,    // "Parent workflow run when this snapshot is an internal child workflow run.
                 //  Hidden from top-level status lists."
parentStageId?,
rootRunId?,      // "Top-level workflow run that owns this nested run tree."
resumedFromRunId?, resumeFromStageId?,
pendingPrompt?   // set when a BACKGROUND run calls ctx.ui.*; foreground runs never set it
```

`StageSnapshot` (`store-types.ts:161-206`): `id, name, status: StageStatus, parentIds,
executionOrder?, nodeKind?, toolStatus?, topologyState?, startedAt?, endedAt?, durationMs?,
result?, error?, failureKind?, failureCode?, failureRecoverability?, failureDisposition?,
retryAfterMs?, failureMessage?, skippedReason?, replayKey?, promptAnswerState?, promptFootprint?,
replayedFromStageId?`.

`WorkflowNotice` (`store-types.ts:377-387`): `{ id, runId?, stageId?, level: "info"|"warning"|"error",
message, createdAt, requiresAck?, ackedAt? }`.

### 3.2 What the status file does NOT contain

`StoreSnapshot` has exactly three keys. It carries **no session id, no pid, no cwd, no host
process identity, and no heartbeat timestamp.** A reader can see `version` increment and can stat
the file's mtime, but the file itself never says *which Atomic session* produced it or *whether
that session is still alive*. This is the central identity gap for any external consumer.

## 4. The state machine

`dist/builtin/workflows/src/shared/store-types.ts:8-19` and
`src/shared/authoring-contract-stage.d.ts:26`:

```ts
export type WorkflowExitStatus = "completed" | "skipped" | "cancelled" | "blocked" | "failed";
export type RunStatus   = "pending" | "running" | "paused" | WorkflowExitStatus | "killed";
export type StageStatus = "pending" | "running" | "awaiting_input" | "paused" | "blocked"
                        | "completed" | "failed" | "skipped";
export type ToolNodeStatus = "pending" | "running" | "completed" | "failed" | "cached" | "cancelled";
```

Important asymmetry: **`awaiting_input` is a StageStatus, not a RunStatus.** A run awaiting a human
answer still reads `status: "running"`; the awaiting signal lives on the stage, or on
`RunSnapshot.pendingPrompt` / `StageInputRequest` for background runs
(`store-types.ts:62-121`, `:359-366`).

Failure taxonomy (`store-types.ts:42-55`):

```ts
WorkflowFailureKind          = "auth" | "rate_limit" | "provider" | "cancelled" | "unknown";
WorkflowFailureRecoverability= "recoverable" | "non_recoverable" | "unknown";
WorkflowFailureDisposition   = "active_blocked" | "terminal_killed" | "terminal_failed";
WorkflowFailureCode          = "login_required" | "missing_api_key" | "invalid_api_key"
                             | "forbidden_config" | "unknown_model" | "rate_limited"
                             | "quota_limited" | "provider_unavailable" | "cancelled" | "unknown";
```

`WorkflowDetailsStatus = "accepted" | "running" | WorkflowExitStatus | "killed" | "noop"` and
`WorkflowAction = "list" | "get" | "inputs" | "run" | "status" | "interrupt" | "resume"`
(`authoring.d.ts` / `authoring-contract-stage.d.ts:31-33`) — so a `status` action exists on the
in-process workflow tool surface.

## 5. Concurrency and nesting

Multiple root runs can be active in one session: dispatch allocates a run id and launches a
**detached** background run that returns `{ status: "running" }` immediately
(`extension/dispatcher.ts:150-200`, `runs/background/runner.ts:99-184`,
`runs/background/startup-admission.ts:33-55`). `defaultConcurrency` defaults to `4` and `maxDepth`
to `4` (`docs/workflows.md:3480-3484`).

Nesting is expressed on the snapshot itself: `parentRunId`, `parentStageId`, `rootRunId`
(`store-types.ts:349-354`). The comment on `parentRunId` is decisive for a monitor's display rule:

> Parent workflow run when this snapshot is an internal child workflow run. **Hidden from top-level
> status lists.**

So a correct monitor shows runs where `parentRunId` is absent, and treats `rootRunId` as the
grouping key for a nested tree.

## 6. Session identity and environment variables

`docs/environment-variables.md:31-38` — the bash session environment snapshot injected into every
built-in, factory-created, direct, **workflow-stage**, and isolated bash execution:

| Atomic variable | Pi alias | Value |
|---|---|---|
| `ATOMIC_SESSION_ID` | `PI_SESSION_ID` | Active session ID |
| `ATOMIC_SESSION_FILE` | `PI_SESSION_FILE` | Active JSONL file; omitted for unsaved/ephemeral sessions |
| `ATOMIC_PROVIDER` | `PI_PROVIDER` | Active provider; omitted when no model is selected |
| `ATOMIC_MODEL` | `PI_MODEL` | Active model ID; omitted when no model is selected |
| `ATOMIC_REASONING_LEVEL` | `PI_REASONING_LEVEL` | Active reasoning level |

`docs/environment-variables.md:38`: Atomic **clears these ten reserved names before overlaying the
current snapshot**, "preventing stale metadata from another session or workflow stage", and the
snapshot is taken when execution begins so resumes and model changes are reflected. SDK
`createBashTool()` exposes it by default; `exposeSessionEnvironment: false` opts out.

`docs/environment-variables.md:21`: `AI_AGENT=atomic` is set by the CLI, RPC, and compiled binary
entry points and **forced into every Atomic-owned child-process environment**, including
bash/tool commands, subagent and workflow runners, MCP servers, and the intercom broker.

Application config vars (`:7-16`): `ATOMIC_CODING_AGENT_DIR` (default `~/.atomic/agent`),
`ATOMIC_CODING_AGENT_SESSION_DIR`, `ATOMIC_PACKAGE_DIR`, `ATOMIC_OFFLINE`,
`ATOMIC_SKIP_VERSION_CHECK`, `ATOMIC_TELEMETRY`, `ATOMIC_REDUCED_MOTION`.

**Correlation consequence:** an Atomic workflow *stage's* bash execution sees both
`ATOMIC_SESSION_ID` (who Atomic is) and the inherited `HERDR_PANE_ID` (which Herdr pane Atomic runs
in). That intersection is the only place both identities exist together today, and it is exactly
what the prior prototype exploited.

## 7. RPC — what an external process can drive

`docs/rpc.md:1-60`. RPC mode is `atomic --mode rpc`, a **stdin/stdout JSONL protocol on a
subprocess you start yourself**. Commands in, responses and events out, strict LF framing, no size
limit. There is no listening socket, no port, no auth handshake — the transport *is* the pipe.

Consequence: an already-running interactive Atomic session in a Herdr pane is **not reachable** over
RPC by a sibling process. RPC only helps a supervisor that spawned Atomic itself. A Herdr plugin
observing a user-launched Atomic session cannot use it.

## 8. Persistence and notifications

`persistRuns` defaults to `true` (`extension/config-loader.ts:49-64`, `:183-190`). When enabled and
`pi.appendEntry` exists (`extension/workflow-ports.ts:5-17`), typed custom session entries are
appended to the session JSONL: `workflow.run.start` (`shared/persistence-session-entries.ts:143-165`),
`workflow.stage.start` (`:167-181`), `workflow.stage.progress` (`:183-191`), `workflow.stage.end`
(`:194-226`), `workflow.run.end` (`:244-272`), `workflow.run.blocked` (`:275-290`).

The live store is the source of truth: `recordRunStart`/`recordRunEnd`/`recordRunBlocked` mutate
snapshots and `bumpAndNotify()` (`shared/store-run-methods.ts:72-75`, `:85-130`, `:133-149`);
invalidation listeners are called synchronously with observer failures isolated
(`shared/store-internal.ts:160-183`).

`workflowNotifications.enabled` defaults `true` with
`notifyOn: ["started","completed","failed","blocked","awaiting_input","paused","quit","resumed"]`
(`config-loader.ts:183-190`) — these are main-chat notices, not an external feed
(`extension/lifecycle-notifications.ts:207-230`, `:311-336`).

`session_before_compact` re-appends start entries for still-active runs and stages so in-flight
state survives compaction (`shared/persistence-compaction-policy.ts:31-71`).

## 9. Crash behaviour and liveness

There is **no heartbeat, pid file, or lock file** anywhere in the workflow runtime. Evidence:

- `status-writer.ts` writes only `StoreSnapshot` (`:166`), which has no liveness field
  (`store-types.ts:368-372`).
- A `SIGKILL`ed Atomic leaves the last-written `status.json` on disk with `status: "running"`
  forever; the writer's terminal-state flush guarantee (`status-writer.ts:9-10`) only covers
  *graceful* terminal transitions.
- Empirical confirmation for the run-artifact directory is in the prototype research doc, §7.

Any external consumer must therefore derive liveness itself — from file mtime, from the `version`
counter advancing, or from an independent process/pane liveness signal.

## 10. What an Atomic extension can push out today (evidence-backed)

- `pi.exec(command, args, options)` (`api-types.d.ts:~130`) — an extension can shell out, e.g. to
  `herdr pane report-metadata`.
- `pi.registerTool` / `registerCommand` — surfaces the LLM or user can invoke.
- `pi.appendEntry` — writes to the session JSONL.
- Lifecycle hooks it can actually observe: `session_start`, `session_shutdown`, `agent_start`,
  `agent_end`, `agent_settled`, `turn_*`, `tool_execution_*`, `model_select`.
- **It cannot observe workflow run/stage lifecycle** (§1). To do so today it would have to poll the
  status file like any other external reader, or Atomic core would have to emit new events.

## 11. What an external process can observe today without any Atomic change

1. **`.atomic/workflows/status.json`** when the user sets `statusFile: true` — full `StoreSnapshot`,
   atomically rewritten on every store update. Default is **off**.
2. **Session JSONL entries** `workflow.run.start` / `workflow.stage.*` / `workflow.run.end` /
   `workflow.run.blocked` when `persistRuns` is true (default). Requires knowing
   `ATOMIC_SESSION_FILE`.
3. **Nothing else.** No socket, no ambient RPC, no run-directory status file (§9 and the prototype
   research doc §7).

## 12. Open code-answerable questions still unresolved

- Whether `resolveStatusFilePath`'s `projectRoot` is passed by
  `extension-runtime-state.ts:83`/`:230` (the calls read `createStatusWriter(store, config)` with no
  third argument, implying `process.cwd()` — i.e. the **Atomic session cwd**, which for a Herdr pane
  is the pane's working directory). This should be confirmed before relying on the default path.
- Whether the `workflow` tool's `action: "status"` result (`WorkflowDetails`,
  `authoring.d.ts:234-254`) is reachable from outside the session; evidence so far says it is an
  in-process tool surface only.
