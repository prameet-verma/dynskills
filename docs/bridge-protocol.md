# Bridge protocol

The root agent drives a generation run through `dynskills run …` commands ([ADR-012](adr/012-cli-bridge.md)). Each command is one process: it reads JSON input, advances the run's state machine, and prints one JSON object on stdout. The `next` field tells the agent exactly what to do next. This guide is the contract for harness integrators; the implementation is `src/orchestrator/orchestrator.ts` and `src/cli/index.ts`.

## Conventions

- **Global options:** `--root <dir>` (default: nearest directory with `.git`, else the cwd). `run` commands always print JSON; `--json` only affects the other commands.
- **Input files:** `--input <file>` takes a path or `-` for stdin. Input that is not JSON fails with an error of category `schema`.
- **Harness:** chosen once with `run start --harness claude|codex|opencode` (default `claude`; `claude-code` is accepted as an alias). Later commands use the harness stored in the run.
- **Schemas:** the files `schemaPath` points to are in [`schemas/`](../schemas/): `context-analysis-result`, `clarification-response`, `skill-draft` (plus `context-packet` and `context-request` for reference).

## Response envelope

Every response, whatever the command, has these fields:

```json
{
  "status": "awaiting_analysis",
  "runId": "run_9b3fc128442d",
  "state": "CONTEXT_ANALYSIS",
  "next": "Read the Context Packet at packetPath and …",
  "budget": { "consumedMs": 32, "remainingMs": 59968, "paused": false, "clarificationRoundsUsed": 0 }
}
```

| Field | Meaning |
| --- | --- |
| `status` | One of `reuse_existing`, `awaiting_analysis`, `awaiting_clarification`, `awaiting_skill_draft`, `revision_required`, `active`, `completed`, `degraded`, `failed`, `invalid_input`, `status`. |
| `runId` | Stable for the whole run, across clarification pauses. |
| `state` | The run's [state](architecture.md#state-machine) after the command. |
| `next` | Plain-language instruction for the agent, including the exact next command. |
| `budget` | Active time consumed and remaining (ms), whether the budget is paused, and clarification rounds used. See [Budget](#budget). |

Command-specific fields are added at the top level. A `degraded` or `failed` response is still a normal response (exit code 0); it carries `error` (an `ErrorInfo`, below) and tells the agent to continue the task with its existing capabilities.

## Commands

### `run start`

```text
dynskills run start --task <text> [--harness <id>] [--scope <path>]… [--constraint <text>]… [--expected-outcome <text>] [--force-generate]
```

Creates a run, then runs preflight and discovery in the same process. `--scope` and `--constraint` are repeatable. `--force-generate` skips reuse of existing skills.

| `status` | `state` | Extra fields | `next` says |
| --- | --- | --- | --- |
| `reuse_existing` | `REUSE_EXISTING` | `skills` (inventory items); `freshness` when a saved Dynamic Skills bundle is reused | Load the named skill(s) with the native skill mechanism and continue. |
| `awaiting_analysis` | `CONTEXT_ANALYSIS` | `packetPath`, `schemaPath`, `packetSummary` {`languages`, `frameworks`, `evidence`, `estimatedTokens`}, `discovery` {`providers`[{`id`,`status`,`evidence`}], `evidence`, `filesRead`, `truncated`}, `revision` (only when this run revises a stale saved skill) | Read the packet, write a ContextAnalysisResult with this `runId`, submit with `run analyze`. |
| `degraded` | `DEGRADED` | `error` | Stop using Dynamic Skills for this task. |

Reuse happens in this order: a non-Dynamic-Skills existing skill whose name and description are sufficient for the task; otherwise a saved bundle (project or personal) that matches the task and whose context fingerprint is unchanged. A matching bundle whose fingerprint changed is not reused: the run revises it, and `revision` = {`name`, `scope`, `previousVersion`, `nextVersion`, `previousArtifactHash`, `decision` (`augment` → minor bump, `regenerate` → major bump), `reasons`, `changedComponents`, `note`}.

Thrown errors (exit 1): `mode: "off"`, an empty task, an invalid configuration file, an unknown harness.

### `run analyze <runId> --input <file>`

Valid in `CONTEXT_ANALYSIS`. Input: a `ContextAnalysisResult` ([schema](../schemas/context-analysis-result.schema.json)). Its `runId` must match, and every evidence `source` must be a packet evidence id or a path present in the packet.

| `status` | `state` | Extra fields | `next` says |
| --- | --- | --- | --- |
| `invalid_input` | `CONTEXT_ANALYSIS` | `issues` [{`path`, `message`, `severity`}], `schemaPath` | Fix and resubmit; how many attempts are left. |
| `awaiting_analysis` | `CONTEXT_ANALYSIS` | `packetPath`, `schemaPath`, `packetSummary`, `targetedDiscovery` {`fulfilled`, `rejected`}, `note` | The packet was extended; update the analysis and resubmit. |
| `awaiting_clarification` | `CLARIFICATION_PENDING` | `request` (ClarificationRequest), `schemaPath` | Ask all questions in one native interaction, submit with `run clarify`. The budget is paused. |
| `awaiting_skill_draft` | `COMPILATION` | `promptPath`, `schemaPath`, `assumptions`, `gaps` | Read the prompt, write a SkillDraft, submit with `run compile` (or `--deterministic`). |
| `degraded` | `DEGRADED` | `error` | Stop using Dynamic Skills. |

- **Bounded correction:** the third invalid submission degrades the run (category `schema`).
- **Targeted discovery:** runs when the analysis has `additionalContextRequests` with `priority: "required"` (or a gap needs it), at most 2 rounds per run, and only while more than 5,000 ms of budget remain. Requests that extend the packet return `awaiting_analysis`; if none could be fulfilled, the command continues to gap analysis. Rejected requests (traversal, absolute, sensitive, excluded paths) are listed with a reason.
- **Clarification** is requested when a gap's resolution is `ask_user` and rounds remain. When the round limit is reached, open questions become assumptions with status `round_limit_reached`.

### `run clarify <runId> --input <file>`

Valid in `CLARIFICATION_PENDING`. Input: a `ClarificationResponse` ([schema](../schemas/clarification-response.schema.json)):

```json
{ "runId": "run_…", "round": 1, "answers": [ { "questionId": "q_322bbe2ac419", "status": "answered", "answer": "Both" } ] }
```

`round` must equal the request's round; every question needs an entry; `status` is `answered` (with a non-empty `answer`), `declined` or `skipped`.

| `status` | `state` | Extra fields | Notes |
| --- | --- | --- | --- |
| `invalid_input` | `CLARIFICATION_PENDING` | `issues`, `request` | The budget stays paused. No attempt limit. |
| `awaiting_clarification` | `CLARIFICATION_PENDING` | `request`, `schemaPath` | Another round (at most `maximumClarificationRounds`, ≤ 3). |
| `awaiting_skill_draft` | `COMPILATION` | `promptPath`, `schemaPath`, `assumptions`, `gaps` | |
| `degraded` | `DEGRADED` | `error` | |

A valid response resumes the budget. Answered questions are appended to the task's constraints as `User clarified — <question>: <answer>`. Declined and skipped questions become assumptions (`asm_…` ids) with that status.

### `run compile <runId> (--input <file> | --deterministic) [--behavioural-result <file>]`

Valid in `COMPILATION`. Input: a `SkillDraft` ([schema](../schemas/skill-draft.schema.json)), or `--deterministic` to let the core build the draft from the analysis. `--behavioural-result` takes a `BehaviouralEvalResult` from a host simulation, which replaces the static smoke eval. Passing neither `--input` nor `--deterministic` is a `configuration` error.

The command validates the draft, applies deterministic fixes, renders, evaluates ([evaluation.md](evaluation.md)), stages the artifact, re-checks that files the skill relies on have not changed, and activates through the harness adapter.

| `status` | `state` | Extra fields |
| --- | --- | --- |
| `revision_required` | `COMPILATION` | `hints` (strings), `evaluation` (summary, when evaluation ran), `attemptsLeft` |
| `active` | `PERSISTENCE_PENDING` | see below |
| `failed` | `FAILED` | `error`, plus context (below) |
| `degraded` | `DEGRADED` | `error` (budget expired or a stage timed out) |

An invalid draft does **not** return `invalid_input`: it returns `revision_required` with the schema issues as `hints`, or `failed` when no attempt remains. Every `compile` call counts as an attempt; the run allows `maximumRevisionAttempts + 1` (default 2).

Fields of an `active` response:

| Field | Meaning |
| --- | --- |
| `skill` | {`name`, `skillId` (`name@<12 hex>`), `installedPath`, `tokenCount`} |
| `instructions` | The full `SKILL.md`. Apply it to the current task now. |
| `requiresReload` | `true` when the harness skills directory was created by this activation. |
| `invocationHint` | How to invoke the skill natively. |
| `evaluation` | {`status`, `checks` {check → status}, `behavioural`, `tokenCount`, `durationMs`, `hints` (≤ 10)} |
| `deterministicFixes` | What the core changed in the draft (renames, truncations, dedupes). |
| `assumptions` | Assumption records carried by the run. |
| `lifetime` | Always `"ephemeral"` at this point. |
| `skillVersion` | `1.0.0` for a new skill, or the bumped version of a revision. |
| `revision` | Present when the run revises a saved skill. The revised version is delivered only through `instructions`; the saved copy is unchanged until `persist` ([ADR-014](adr/014-activation-and-revisions.md)). |
| `baseline` | Present when `evaluation.baselineComparison` is `"always"` ([evaluation.md](evaluation.md#baseline-comparison)). |
| `repositoryChanges` | {`uncited`, `note`}: packet files that changed during generation but are not cited by the skill. |

Context on `failed` responses: `hints` and `evaluation` (mandatory evaluation failed); `stagedDir` (hash mismatch or adapter failure; adapter failure also has `evaluation`); `changedFiles`, `stagedDir` and a top-level `fallbackAction` (category `repository_changed`: a file the skill cites changed after discovery).

### `run persist <runId> --choice <choice> [--harnesses <list>] [--all-harnesses]`

Valid in `ACTIVE` or `PERSISTENCE_PENDING`. Call it only after the user chose (§10.4). `--choice` is `project`, `personal`, `ephemeral` or `discard`; anything else is a `configuration` error.

- `--harnesses claude,codex,opencode` also installs into those harnesses. The run's own harness is always included.
- `--all-harnesses` adds every harness `detectHarnesses` finds (PATH binaries and project/home config markers).

| Choice | Effect |
| --- | --- |
| `project` / `personal` | Verify the staged artifact still matches its evaluated hash; run the baseline comparison (unless `baselineComparison: "never"`); remove the session install (new skills only); install byte-identical copies into each harness's project or personal skills directory; verify each copy's hash; write the canonical bundle (`.dynamic-skills/bundles/<name>` or `~/.dynamic-skills/bundles/<name>`). A revision replaces the saved bundle and records the old version in `history`. |
| `ephemeral` | No change. A new skill stays installed for the session until `dynskills clean`; for a revision, the saved version stays unchanged. |
| `discard` | Remove the session install (new skills only) and the staged directory. |

Response: `status: "completed"`, `state: "COMPLETED"`, plus `persistence` {`choice`, `path`?}, `skillVersion`, `installs` [{`harness`, `scope`, `path`, `artifactHash`, `installedAt`}] for project/personal, and `baseline` when one ran. If the baseline verdict is not `improves`, `next` suggests discarding the skill.

If saving fails, the run still completes and the skill stays ephemeral: `persistence.choice` is `"ephemeral"`, and the response has `persistenceError` and, if some harnesses were already written, `partialInstalls`.

### `run status <runId>`

Valid in any state. Read-only: no lock, no idempotency record, no budget check. `status` is always `"status"`. Extra fields: `task` (description), `history` [{`from`, `to`, `at`, `note`?}], `skill`, `evaluation`, `persistence`, `error`, `metrics`. `next` is `Run is waiting for \`dynskills run <cmd> <runId>\`.` for `CONTEXT_ANALYSIS` (analyze), `CLARIFICATION_PENDING` (clarify), `COMPILATION` (compile), `ACTIVE`/`PERSISTENCE_PENDING` (persist); otherwise `Run is finished.`

### `run cancel <runId>`

Valid in any state.

| Run state | Result |
| --- | --- |
| Terminal | `status: "status"`, `next: "Run already finished."` |
| `ACTIVE` / `PERSISTENCE_PENDING` | The session install is removed; `status: "completed"`, `persistence.choice` recorded as `discard`. |
| Anything else | The budget is resumed if paused; `status: "degraded"`, error category `invalid_state`, message `Cancelled by the root agent`. |

## Errors and exit codes

When a command cannot produce a response (wrong state, unknown run, bad arguments, invalid configuration), it prints:

```json
{
  "status": "error",
  "error": {
    "category": "invalid_state",
    "component": "orchestrator",
    "message": "Run is in CONTEXT_ANALYSIS; `compile` is not valid now",
    "recoverable": true,
    "fallbackAction": "Run `dynskills run analyze run_…`.",
    "runId": "run_…"
  }
}
```

`error` is an `ErrorInfo`: `category`, `component`, `message`, `recoverable`, `fallbackAction`, and optionally `runId` and `elapsedActiveMs`. An error that is not a `DynamicSkillsError` (for example a missing input file) is reported as {`category: "internal"`, `component: "cli"`, `message`, `recoverable: false`} with no `fallbackAction`.

| Exit code | When |
| --- | --- |
| 0 | A response was printed, including `invalid_input`, `revision_required`, `degraded` and `failed`. |
| 2 | Error with category `invalid_state`: unknown or malformed `runId`, command not valid in the current state (`fallbackAction` names the expected command), another command holds the run lock, or an illegal transition. |
| 1 | Any other error: `configuration` (bad flags, `mode: "off"`, invalid config, unknown harness), `schema` (input is not JSON), `internal`. |

Commander's own usage errors (missing required option, unknown command) are printed as plain text on stderr, not JSON (for example `error: required option '--task <text>' not specified`, exit 1).

## Idempotency (§4.3)

Each mutating command (`analyze`, `clarify`, `compile`, `persist`, `cancel`) records `lastRequest` = {`command`, `inputHash`, `stateBefore`, `response`} in `run.json`. `inputHash` is SHA-256 of the command name and the stable-stringified input:

| Command | Hashed input |
| --- | --- |
| `analyze`, `clarify` | The parsed JSON input |
| `compile` | {`draft`?, `deterministic`?, `hostBehaviouralResult`?} |
| `persist` | {`choice`, `harnesses`} (`harnesses` is `null` when no extra harness was given) |
| `cancel` | `null` |

If the new request has the same command and hash as `lastRequest`, the stored response is returned verbatim, before any state check, budget check or side effect, including its old `budget` numbers. Only the most recent request is remembered. A replayed invalid `analyze` does not use up a correction attempt. A request that threw an error is not recorded. `start` is not idempotent: each call creates a new run.

## Locking

Mutating commands take an exclusive per-run lock: `.lock` in the run directory, created with `O_EXCL`. A second concurrent command fails with `invalid_state` ("Another command is already operating on this run", exit 2) and should be retried after the first finishes. A lock older than 2 minutes is treated as stale and broken. `status` does not lock.

## Budget

Each run has an active-processing budget (`execution.activeBudgetMs`, default and maximum 60,000 ms) measured on the OS monotonic clock across processes ([ADR-013](adr/013-cross-process-budget.md)).

- **What counts:** everything from `run start` onwards, including the time between commands, when the host LLM is reading the packet and writing JSON. Process start-up counts too.
- **What does not count:** the wait for the user. The budget pauses when a run enters `awaiting_clarification` and resumes on the next valid `clarify`. An invalid `clarify` keeps it paused. Pauses never reset the budget.
- **Expiry check:** at the start of every mutating command, if the budget is expired and not paused, and the run is not terminal, `ACTIVE` or `PERSISTENCE_PENDING`, the run degrades with category `sla_expired` and `metrics.timedOut: true`. No skill is activated and no check is skipped.
- **Stage timeouts:** discovery gets min(12,000 ms, remaining); targeted discovery min(6,000 ms, remaining); evaluation min(10,000 ms, remaining); activation min(5,000 ms, remaining). Each is also aborted when the budget runs out. A timeout degrades the run with `sla_expired`.
- **Thresholds:** targeted discovery runs only with more than 5,000 ms left; an LLM revision (`revision_required`) is offered only with at least 8,000 ms left, otherwise the run fails.
- **After activation** the budget no longer applies: `persist` and `cancel` work whatever the remaining time. `metrics.activeMs` records active time at activation (or when the run degraded or failed).
- After a reboot the open segment is charged by wall-clock delta instead.

## Worked example

Abbreviated output of a real run (paths shortened, `next` trimmed).

```text
$ dynskills run start --task "Add Stripe refund support to the billing service payment gateway"
{ "status": "awaiting_analysis", "runId": "run_9b3fc128442d", "state": "CONTEXT_ANALYSIS",
  "budget": { "consumedMs": 32, "remainingMs": 59968, "paused": false, "clarificationRoundsUsed": 0 },
  "packetPath": ".dynamic-skills-runtime/sessions/sess_demo/runs/run_9b3fc128442d/context-packet.json",
  "schemaPath": "…/schemas/context-analysis-result.schema.json",
  "packetSummary": { "languages": ["TypeScript"], "frameworks": ["Express@4.19.2", "Vitest@2.0.5", "Zod@3.23.8"], "evidence": 17, "estimatedTokens": 1709 },
  "discovery": { "providers": [ { "id": "manifest", "status": "ok", "evidence": 3 }, … ], "evidence": 17, "filesRead": 5, "truncated": false } }

$ dynskills run analyze run_9b3fc128442d --input analysis.json      # one critical unknown
{ "status": "awaiting_clarification", "state": "CLARIFICATION_PENDING",
  "budget": { "consumedMs": 167, "remainingMs": 59833, "paused": true, … },
  "request": { "runId": "run_9b3fc128442d", "round": 1, "maximumRounds": 3,
               "questions": [ { "id": "q_322bbe2ac419", "question": "Should refunds be partial, full, or both?", "reason": "…", "required": true } ] },
  "schemaPath": "…/schemas/clarification-response.schema.json" }

$ dynskills run clarify run_9b3fc128442d --input answers.json
{ "status": "awaiting_skill_draft", "state": "COMPILATION",
  "budget": { "consumedMs": 172, "remainingMs": 59828, "paused": false, "clarificationRoundsUsed": 1 },
  "promptPath": "…/runs/run_9b3fc128442d/compile-prompt.md", "schemaPath": "…/schemas/skill-draft.schema.json",
  "assumptions": [], "gaps": [ … ] }

$ dynskills run compile run_9b3fc128442d --input draft.json
{ "status": "active", "state": "PERSISTENCE_PENDING",
  "skill": { "name": "stripe-refund-integration", "skillId": "stripe-refund-integration@d8dbf56e725f",
             "installedPath": "<repo>/.claude/skills/stripe-refund-integration", "tokenCount": 369 },
  "instructions": "---\nname: stripe-refund-integration\n…",
  "requiresReload": true, "invocationHint": "The skill is invocable as /stripe-refund-integration …",
  "evaluation": { "status": "pass", "checks": { "structural": "pass", "grounding": "pass", … }, "behavioural": "pass", "hints": [] },
  "deterministicFixes": [], "assumptions": [], "lifetime": "ephemeral", "skillVersion": "1.0.0" }

$ dynskills run persist run_9b3fc128442d --choice project
{ "status": "completed", "state": "COMPLETED", "next": "Saved in this project as v1.0.0 for claude. …",
  "persistence": { "choice": "project", "path": "<repo>/.dynamic-skills/bundles/stripe-refund-integration" },
  "skillVersion": "1.0.0",
  "installs": [ { "harness": "claude", "scope": "project", "path": "<repo>/.claude/skills/stripe-refund-integration", "artifactHash": "d8dbf56e…", "installedAt": "…" } ],
  "baseline": { "skillCoverage": 1, "baselineCoverage": 0.667, "lift": 0.333, "prohibitionsAdded": 1, "verdict": "improves", "trigger": "promotion", … } }

$ dynskills run persist run_9b3fc128442d --choice project            # identical repeat → cached response
$ dynskills run cancel run_9b3fc128442d
{ "status": "status", "state": "COMPLETED", "next": "Run already finished.", … }
```

## Notes for integrators

- When `requiresReload` is true, the `active` response includes `reloadInstruction` (for Claude Code: run `/reload-skills`), and `next` repeats it. Claude Code does not watch a skills directory created after the session started, so every activation into such a directory in the same session asks for a reload.
- `request.maximumRounds` is the configured `execution.maximumClarificationRounds`, and `budget.clarificationRoundsUsed` includes the round being asked.
- After a skill is active, an unexpected error in `persist` (for example, the staged artifact was modified after evaluation) is returned as that error, with its own category (such as `security`). The run stays in `PERSISTENCE_PENDING`.
- A `repository_changed` failure is recoverable. `error.fallbackAction` says to start a new run so discovery sees the current files, or to continue with existing capabilities.
