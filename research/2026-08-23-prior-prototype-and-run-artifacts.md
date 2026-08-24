---
title: "Prior prototype (herdr-atomic-monitor) and empirical Atomic run-state facts"
date: 2026-08-23
topic: prior-prototype-and-run-artifacts
subjects:
  - /Users/canerakca/Desktop/workspace/herdr-atomic-monitor
  - /Users/canerakca/.atomic
method: direct file reads plus shell probes run from inside a live Atomic session in a Herdr pane
status: evidence
---

# Prior prototype and empirical Atomic run-state facts

Nothing under either subject path was modified. Every empirical claim below shows the command that
produced it.

## 1. What the prototype is

```
$ find . -type f -not -path "./.git/*"
./bin/herdr-atomic-clear.sh
./bin/herdr-atomic-demo.sh
./bin/herdr-atomic-report.sh
./.atomic/workflows/fix-herdr-issue.workflow.ts
./.atomic/workflows/README.md
./.atomic/workflows/reproduce-herdr-bug.workflow.ts
./.atomic/workflows/repro-agent.prompt.md
./install.sh
./README.md
./herdr-plugin.toml
./HANDOFF.md
```

It is a **display-only push reporter**, not a monitor. Atomic workflows call a bash script at each
stage boundary; the script shells out to `herdr pane report-metadata` on the pane Atomic runs in.
Herdr is passive throughout.

`README.md:5-9`:

> When Atomic runs inside a Herdr pane, this plugin pushes the current workflow stage, run counter,
> and model onto that pane's sidebar row using Herdr's display-only pane metadata. It uses
> `pane report-metadata` only, so it **never overrides Herdr's own agent detection** — the colored
> state dot still comes from Herdr; this plugin only enriches the text.

## 2. The manifest, field by field

`herdr-plugin.toml` in full:

```toml
id = "atomic.monitor"
name = "Atomic Monitor"
version = "0.1.0"
min_herdr_version = "0.8.0"
description = "Surface Atomic agent-session and workflow status in the Herdr sidebar via display-only pane metadata."
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "demo"
title = "Atomic Monitor: run sidebar demo"
contexts = ["pane"]
command = ["bash", "bin/herdr-atomic-demo.sh"]

[[actions]]
id = "clear"
title = "Atomic Monitor: clear tokens"
contexts = ["pane"]
command = ["bash", "bin/herdr-atomic-clear.sh"]
```

Decisive observation: the prototype declares **only `[[actions]]`**. It uses none of
`[[startup]]`, `[[events]]`, `[[panes]]`, or `[[link_handlers]]` (all available per
`src/app/api/plugins/manifest.rs:12-35`). There is no background process, no event-driven cleanup,
and no polling. The "plugin" is a convenience wrapper around two manually invoked scripts; the real
integration is the workflow-side push.

## 3. The scripts

### `bin/herdr-atomic-report.sh`

Argv construction (`:62-74`):

```bash
args=(pane report-metadata "$pane" --source "$SOURCE")
[ -n "$display_agent" ] && args+=(--display-agent "$display_agent")
[ -n "$stage" ] && args+=(--token "stage=$stage")
[ -n "$run" ]   && args+=(--token "run=$run")
[ -n "$model" ] && args+=(--token "model=$model")
...
[ -n "$label" ] && args+=(--state-label "working=$label")
[ -n "$ttl_ms" ] && args+=(--ttl-ms "$ttl_ms")
```

- Source is the fixed string `SOURCE="atomic:monitor"` (`:26`).
- Pane comes from `HERDR_PANE_ID` or `--pane` (`:29`, `:42`).
- Herdr binary from `HERDR_BIN_PATH` else `herdr` on PATH (`:27`).
- **Fail-open**: no pane resolvable → warn to stderr and `exit 0` (`:56-59`), documented at `:20-23`.
- `HERDR_ATOMIC_DRYRUN=1` prints the command instead of running it (`:76-79`).

It reads **no filesystem state, no process table, and no socket**. It is purely a formatter for
three scalar values the workflow already holds.

Design note the author wrote at `:6-9`: "This never sets semantic agent state, so it does not fight
Herdr's own agent detection or affect waits/notifications/rollups."

### `bin/herdr-atomic-clear.sh`

```bash
args=(pane report-metadata "$pane" --source "$SOURCE"
  --clear-token stage --clear-token run --clear-token model
  --clear-state-labels --clear-display-agent)
```
— `:27-29`. Cleanup is **manual and enumerated**: it names the three tokens it set. It is not
wired to any Herdr event and does not run if the workflow dies.

### `bin/herdr-atomic-demo.sh`

Drives a fake 5-stage run with `--ttl-ms 600000` per report and clears at the end (`:31-46`).
Its purpose is stated at `:4-6`: "Proves the reporter works without needing a real workflow."

### Workflow-side inlining

`.atomic/workflows/fix-herdr-issue.workflow.ts:13-23` (and the same block at
`reproduce-herdr-bug.workflow.ts:15-23`):

```ts
const pane = process.env.HERDR_PANE_ID;
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const a = ["pane", "report-metadata", pane, "--source", "atomic:monitor",
  "--display-agent", "atomic", "--ttl-ms", "1800000", "--token", `stage=${s.stage}`];
if (s.run) a.push("--token", `run=${s.run}`);
if (s.model) a.push("--token", `model=${s.model}`);
const p = spawnSync(herdr, a, { encoding: "utf8" });
```

Each report is wrapped as a durable `ctx.tool` node (`README.md:80-87`), and the TTL is 30 minutes.

## 4. Install side effects

`install.sh:9-23` copies the two `.workflow.ts` files and one `.prompt.md` into
`${ATOMIC_CODING_AGENT_DIR:-$HOME/.atomic/agent}/workflows`. It writes nothing into Herdr. The
Herdr-side install is a separate manual `herdr plugin link ~/Desktop/workspace/herdr-atomic-monitor`
(`README.md:25`).

## 5. HANDOFF.md — stated limitations and hard-won facts

Discovery gotchas the author marked "don't re-learn them" (`HANDOFF.md:63-69`):

> - User-scope dir is `~/.atomic/agent/workflows/` (NOT `~/.atomic/workflows/`, which is only run
>   artifacts).
> - Every `.ts` in that dir is loaded as a workflow, so **no shared helper modules** there — the tiny
>   sidebar reporter is **inlined** into each workflow.
> - The Atomic runtime here is **Node, not Bun** — workflows use `node:*` built-ins
>   (`child_process`, `fs`, `url`, `crypto`), never `Bun.*`.

Required manual user configuration (`HANDOFF.md:109-117`, `README.md:29-42`):

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "agent", "state_text"],
  ["$stage", "$run", "$model"],
  ["workspace", "tab"],
]
```

> Tokens only appear if your sidebar layout references them. — `README.md:31`

This is direct confirmation of the fixed-arity slotting constraint: the *user*, not the reporter,
decides how many token slots exist.

Reliability preconditions (`HANDOFF.md:13-36`):

> The earlier session was blocked because the **running Herdr server was stale** (older than the
> on-disk binary): every runtime CLI call failed with
> `Json(Error("data did not match any variant of untagged enum WireResponse"))`, and the server
> didn't even know `pane.current` / `agent.explain`.
> …
> Two binaries exist on this machine: `~/.local/bin/herdr` (0.8.0) and `/opt/homebrew/bin/herdr`
> (0.7.1) — make sure the one that launches the server and the one on `PATH` are the **same
> version**.
> Only when those 4 commands succeed will the workflows and the sidebar reporter work.

Fail-open behaviour reaffirmed (`HANDOFF.md:105-107`):

> It's **fail-open** (no `HERDR_PANE_ID` → no-op) and only paints when CLI↔server is healthy.

Known TODOs (`HANDOFF.md:122-133`) are about the repro workflow's verdict classification and
bootstrap resilience — neither concerns the monitor design.

Security-relevant finding the author reproduced (`HANDOFF.md:146-151`):

> **#2012** (`pane current` trusts inherited `$HERDR_PANE_ID`): **REPRODUCED** manually against a
> fresh 0.8.0 server. Same external caller, only the env var changed: `HERDR_PANE_ID=w1:p1 → pane
> current` returned w1:p1; `HERDR_PANE_ID=w1:p2` returned w1:p2; `w1:p99` → `pane_not_found`. So it
> checks the pane *exists* but never that the caller *owns* it.

**Any pane-addressed status door inherits this trust weakness.** It must be named as an explicit
trust transition in the design.

## 6. Proven vs unproven (prototype)

| Claim | Status | Evidence |
|---|---|---|
| Atomic workflow stages can push scalar status onto a Herdr pane row via `pane report-metadata` | **Proven** | scripts + inlined workflow reporters + `HANDOFF.md:103-107` describing live use |
| Fail-open outside Herdr | **Proven by construction** | `herdr-atomic-report.sh:56-59` |
| The demo drives a visible 5-stage row update | **Claimed, self-described as a self-test** | `herdr-atomic-demo.sh:4-6`; no captured output in the repo |
| Tokens appear only when user config names them | **Proven** | `README.md:31`; corroborated by `src/ui/sidebar/tokens.rs:38-89` |
| A **nested list** of concurrent workflows can be shown | **Never attempted** | prototype shows exactly three scalars for one run; no multi-run handling anywhere |
| Cleanup on crash | **Not implemented** | `clear` is a manual action; `[[events]]` is unused in `herdr-plugin.toml`; only the 30-minute TTL bounds staleness |
| Herdr-side polling of Atomic state | **Never attempted** | no script reads any Atomic file or process |
| Multi-session / multi-pane correctness | **Unvalidated** | reporter targets exactly one `HERDR_PANE_ID` |

## 7. Empirical facts about on-disk Atomic run state

### 7.1 The run directory has no status file

```
$ ls /Users/canerakca/.atomic/workflows/runs | wc -l
27

$ find dd7f99ec-f2d0-480f-93bf-a88ad84b2796
dd7f99ec-.../artifact-e63b7dbd-.../implementation-notes.md
dd7f99ec-.../transcripts/65dcf89a5983ca10-2026-08-23-fix-herdr-issue-2868-....md.transcript.md
dd7f99ec-.../transcripts/ec9249a2f89ba4f1-orchestrator-report.md.transcript.md
dd7f99ec-.../artifact-43af809d-.../review-reviewer-a.json
dd7f99ec-.../artifact-43af809d-.../orchestrator-report.md
dd7f99ec-.../artifact-43af809d-.../review-reviewer-b.json
dd7f99ec-.../artifact-43af809d-.../review-round-latest.json
dd7f99ec-.../artifact-a81e68dd-...

$ find 01bd8954-f73a-4f94-a57a-c4b790e6cfba
01bd8954-.../transcripts/e7bb5e2f3552e923-orchestrator-receipt.md.transcript.md
01bd8954-.../artifact-6c6b9b23-.../review-completion-reviewer.json
01bd8954-.../artifact-6c6b9b23-.../review-risk-reviewer.json
01bd8954-.../artifact-6c6b9b23-.../review-evidence-reviewer.json
01bd8954-.../artifact-6c6b9b23-.../goal-ledger.json
01bd8954-.../artifact-6c6b9b23-.../orchestrator-receipt.md
01bd8954-.../artifact-6c6b9b23-.../review-round-latest.json
```

Only `artifact-<uuid>/` and `transcripts/` subtrees. The files are **workflow-authored artifacts**
(goal ledgers, review JSON, receipts), whose names and schemas are chosen by each workflow, not by
the runtime.

Decisive negative probe:

```
$ find . \( -name "*.pid" -o -name "*lock*" -o -name "*status*" \
          -o -name "*heartbeat*" -o -name "state.json" -o -name "run.json" \)
(no output)

$ find . -maxdepth 1 -type f
(no output)
```

**Answers:**
- (a) Is there a file naming a run's current status? **No.**
- (b) How would an external poller list *active* runs? **It cannot, from this directory.** A
  directory exists as soon as a run writes its first artifact and is never marked finished.
- (c) Timestamps for staleness? Only directory/file mtimes, which reflect artifact writes, not run
  liveness.
- (d) pid / lock / heartbeat? **None.**

### 7.2 The status file is opt-in and currently absent

```
$ find /Users/canerakca/Desktop/workspace -maxdepth 4 -path "*/.atomic/workflows/status.json"
(no output)
```

Consistent with `statusFile` defaulting to `false` (`docs/workflows.md:3484`). See the Atomic
research doc §3 for the writer's contract.

### 7.3 Durability state lives in Postgres, not in the run directory

```
$ ps aux | grep -i atomic
canerakca 84448 ... atomic
canerakca 57587 ... atomic
canerakca 84025 ... /Users/canerakca/.local/bin/herdr server
canerakca 57586 ... atomic          (tty s003)
canerakca 84447 ... atomic          (tty s005)
canerakca 95334 ... postgres: postgres atomic_workflows_dbos_sys 127.0.0.1(57700) idle
canerakca 59233 ... node .../jiti-cli.mjs .../builtin/intercom/broker/broker.ts
```

There is a `~/.atomic/postgres` directory (mode `drwx------`) and live
`atomic_workflows_dbos_sys` connections — DBOS durability. That store is a private implementation
detail with no documented external read contract; a monitor must not depend on it.

### 7.4 A sibling process cannot read another Atomic process's environment

```
$ ps eww -p $$          # own process
98150 ?? Ss 0:00.01 /bin/bash -c echo ... KEY=VALUE pairs visible

$ ps eww -p 84447       # another atomic process, same user
  PID   TT  STAT      TIME COMMAND
84447 s005  S+    10:29.97 atomic
                                     ← no environment returned
```

macOS withholds the environment of other processes. **A Herdr-side poller therefore cannot discover
which Atomic session runs in which pane by inspecting process environments.** Correlation must be
*pushed* by the Atomic side, which is the only place both identities are visible.

### 7.5 Both identities coexist exactly once — in an Atomic-executed shell

Run from inside a live Atomic workflow-stage bash execution, itself inside a Herdr pane:

```
$ env | grep -E "^(HERDR|ATOMIC|PI|AI_AGENT)" | sed 's/=.*/=<set>/' | sort
AI_AGENT=<set>
ATOMIC_CODING_AGENT=<set>
ATOMIC_INTERCOM_SESSION_ID=<set>
ATOMIC_MODEL=<set>
ATOMIC_PROVIDER=<set>
ATOMIC_REASONING_LEVEL=<set>
ATOMIC_SESSION_FILE=<set>
ATOMIC_SESSION_ID=<set>
HERDR_AGENT=<set>
HERDR_BIN_PATH=<set>
HERDR_ENV=<set>
HERDR_PANE_ID=<set>
HERDR_SOCKET_PATH=<set>
HERDR_TAB_ID=<set>
HERDR_WORKSPACE_ID=<set>
PI_MODEL=<set>
PI_PROVIDER=<set>
PI_REASONING_LEVEL=<set>
PI_SESSION_FILE=<set>
PI_SESSION_ID=<set>

$ echo "HERDR_PANE_ID=$HERDR_PANE_ID  ATOMIC_SESSION_ID=$ATOMIC_SESSION_ID"
HERDR_PANE_ID=w6:p1  ATOMIC_SESSION_ID=01a0306c-0bf9-7f82-b3c5-f9fe476a7904
```

Also note `HERDR_AGENT` is set, i.e. Herdr already classified this pane's agent.

Live versions:

```
$ herdr --version
herdr 0.8.2

$ node -e "console.log(require('@bastani/atomic/package.json').version)"
0.9.13
```

**This is the single most important empirical fact for the design:** the pane↔session join is
available, for free, in any shell Atomic runs — and nowhere else.

## 8. Open code-answerable questions still unresolved

- Whether Herdr's `PaneExited` hook fires reliably when only the Atomic *process* dies but the pane
  survives (e.g. Atomic quits back to a shell). Not probed; the design should not assume it.
- Whether the DBOS `atomic_workflows_dbos_sys` schema carries a queryable liveness row. Deliberately
  not investigated — it is undocumented and off-contract for external readers.
