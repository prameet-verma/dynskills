# Evaluation

Every generated skill is evaluated after rendering and before activation (TechDesign §8). This guide lists what each check looks for, which failures block activation, and how revisions and the baseline comparison work. The code is in `src/eval-engine/`.

## How a report is built

`evaluateSkill` runs the seven generation checks and the behavioural smoke eval concurrently and aggregates them into a `SkillEvaluationReport` (saved as `evaluation-report.json` in the run directory).

- Each finding has a `code`, `severity` (`error`, `warning` or `info`), `message` and optional `path`.
- A check's status is `fail` if it has any error, `warning` if it has any warning, else `pass`.
- A check that throws produces one error finding `check_error`.
- Report status: `fail` if any **mandatory** check failed, or if the behavioural eval failed and `evaluation.behaviouralSmokeEval` is `"required"`; otherwise `warning` if anything is not `pass`; otherwise `pass`.
- `revisionHints`: one string per error and warning, formatted `[<check> <path>] <message>`, errors of mandatory checks first. Errors from non-mandatory checks are listed as warnings.
- Before evaluation, `compile` always applies deterministic fixes to the draft (`applyDeterministicFixes`: normalise and de-collide the name, truncate the description to 1024 characters, drop empty or duplicate items, merge duplicate constraints, sanitise reference file names). Fixes are reported in the `active` response as `deterministicFixes`.

A failed mandatory check is never downgraded to a warning and never bypassed to meet the budget (§8.1, §8.6).

## Generation checks

| Check | Mandatory | Purpose |
| --- | --- | --- |
| `structural` | yes | Frontmatter, name and description rules, file layout, links |
| `grounding` | when `requireEvidence` (always true in runs) | Project constraints cite known evidence |
| `scope` | no | Relevance to the task, irrelevant dependencies |
| `duplication` | yes | Name collisions, near-duplicate skills, copied instructions |
| `conciseness` | yes | Token limits, repetition, generic advice |
| `portability` | yes | No harness-specific frontmatter or machine paths |
| `security` | yes | Instruction-only artifact, no secrets, no dangerous instructions |

### structural (`structural.ts`)

| Code | Severity | Trigger |
| --- | --- | --- |
| `skill_md_missing` | error | No `SKILL.md` at the skill root. |
| `frontmatter_missing` | error | `SKILL.md` does not start with `---`, or the block is not closed. |
| `frontmatter_invalid` | error | Frontmatter is not valid YAML or not a mapping. |
| `name_missing` | error | `name` absent or empty. |
| `name_too_long` | error | `name` longer than 64 characters. |
| `name_invalid` | error | `name` does not match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. |
| `name_dir_mismatch` | error | `name` differs from the directory name (`expectedDirName`, default the skill name). |
| `skill_name_mismatch` | error | Frontmatter `name` differs from the artifact's name. |
| `description_missing` | error | `description` absent or blank. |
| `description_too_long` | error | `description` longer than 1024 characters. |
| `frontmatter_unknown_key` | error | A key other than `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. |
| `compatibility_invalid` | error | `compatibility` not a string, or longer than 500 characters. |
| `license_invalid` | error | `license` not a string. |
| `metadata_missing` | warning | No `metadata`, or any of the provenance keys missing: `dynamic-skills.run-id`, `dynamic-skills.generator-version`, `dynamic-skills.skill-version`, `dynamic-skills.context-fingerprint`. |
| `metadata_invalid` | error | `metadata` is not a mapping. |
| `metadata_not_string` | error | A `metadata` value is not a string. |
| `body_empty` | error | Nothing after the frontmatter. |
| `unexpected_file` | error | A file outside `SKILL.md`, `references/…`, `assets/…` (`scripts/…` is left to the security check). |
| `link_absolute` | error | A Markdown link target starting with `/`. |
| `link_outside_skill` | error | A relative link that resolves outside the skill directory. |
| `broken_reference` | error | A relative link to a file that is not in the skill. |
| `unreferenced_file` | warning | A `references/` file not linked from any Markdown file. |

External links (`http:`, `mailto:` …) and pure anchors are ignored.

### grounding (`grounding.ts`)

Mandatory when the compilation policy has `requireEvidence: true`. `buildCompilationRequest` always sets it, so grounding is mandatory in every run. When it is false, errors are downgraded to warnings.

| Code | Severity | Trigger |
| --- | --- | --- |
| `skill_md_missing` | error | No `SKILL.md`. |
| `no_project_constraints` | warning | No `## Project constraints` section. |
| `constraint_ungrounded` | error | A bullet under `## Project constraints` has no [evidence marker](#evidence-references-in-skillmd), or an empty one. |
| `unknown_evidence_id` | error | A cited `ev_…` id is not in the run's evidence registry, or a provenance evidence id is unknown. |
| `unsupported_assumption` | error | A cited `asm_…` id is not a recorded assumption; an id listed under `## Assumptions` is not recorded; or a provenance assumption id is unknown. |
| `unknown_evidence_path` | error | A cited path is not a path the registry knows from the packet. |

Duplicate findings (same code and message) are reported once.

### scope (`scope.ts`) — never mandatory

| Code | Severity | Trigger |
| --- | --- | --- |
| `description_off_task` | warning | The description shares no keywords with the task (description, scope, expected outcome). |
| `description_no_trigger` | warning | The description contains none of the words `use`, `when`, `for`. |
| `body_off_task` | warning | Fewer than 30% (`SCOPE_BODY_COVERAGE_MIN = 0.3`) of the task's keywords appear in the body. |
| `irrelevant_dependency` | warning | `SKILL.md` mentions a library from `KNOWN_DEPENDENCIES` (about 70 well-known frameworks, databases and tools) or installs a package (`npm install`, `pnpm add`, `pip install`, `go get` …) that appears nowhere in the task, the analysis, the known paths or the discovery evidence claims. |
| `scope_ok` | info | No other finding; reports keyword coverage. |

Keywords are stemmed, non-stopword terms of at least 3 characters.

### duplication (`duplication.ts`)

| Code | Severity | Trigger |
| --- | --- | --- |
| `name_collision` | error | The name equals (case-insensitively) an existing skill's name. The skill being revised is not counted. In runs this is normally prevented by the deterministic fix, which renames to `name-2`, `name-3` … |
| `duplicate_existing_skill` | warning | Keyword Jaccard similarity of the descriptions ≥ 0.8 (`DESCRIPTION_SIMILARITY_WARN`). |
| `repeats_repository_instructions` | warning | At least 3 (`COPIED_LINES_WARN`) body lines of ≥ 40 characters (`COPIED_LINE_MIN_LENGTH`) are copied verbatim (after normalising bullets, whitespace and case) from repository instruction files in the packet. |

### conciseness (`conciseness.ts`)

Tokens are estimated as ASCII characters / 4 plus one per non-ASCII character, taking the larger of that estimate and the skill's `tokenCount`.

| Code | Severity | Trigger |
| --- | --- | --- |
| `skill_too_long` | error | `SKILL.md` above `generation.maximumSkillTokens` (default 5000). |
| `skill_over_target` | warning | Above `generation.targetSkillTokens` (default 2000). |
| `duplicate_lines` | warning | A body line of ≥ 20 characters (not a heading) appears more than once. |
| `generic_advice` | warning | The body contains a phrase from `GENERIC_ADVICE_PHRASES` ("write clean code", "follow best practices", "handle errors gracefully" …, 14 phrases). |
| `tokens` | info | No other finding; reports the token count. |

### portability (`portability.ts`)

| Code | Severity | Trigger |
| --- | --- | --- |
| `harness_specific_frontmatter` | error | Frontmatter has any of `disable-model-invocation`, `user-invocable`, `argument-hint`, `model`, `context`, `agent`, `hooks`, `when_to_use`, `mode`, `tools`. (These also fail `frontmatter_unknown_key`.) |
| `allowed_tools_experimental` | warning | Frontmatter has `allowed-tools`. |
| `absolute_path` | error | Any file contains `/Users/<name>`, `/home/<name>`, `/root/` or a Windows drive path `C:\…`. |
| `harness_specific_content` | warning | Any file mentions `.claude/`, `.codex/`, `.opencode/`, `AskUserQuestion`, `TodoWrite`, `ExitPlanMode`, `apply_patch`, `$ARGUMENTS` or `/reload-skills`. |

### security (`security.ts`)

| Code | Severity | Trigger |
| --- | --- | --- |
| `path_traversal` | error | A file path that is absolute, has a drive letter, a backslash, a NUL, or an empty, `.` or `..` segment. |
| `scripts_not_allowed` | error | A file under `scripts/`. |
| `executable_artifact` | error | A file with an executable or script extension (`.sh`, `.py`, `.js`, `.ts`, `.exe`, `.jar` … 27 extensions) or content starting with `#!`. |
| `secret_detected` | error | `redactSecrets` finds a likely secret in any file ([security.md](security.md#redaction)). |
| `dangerous_instruction` | error | A line matches a dangerous pattern (below) and is not phrased as a prohibition. |
| `<pattern>_prohibition_outside_boundaries` | warning | A line matches a pattern but is phrased as a prohibition (`Do not …`, `Never …`, `Avoid …`) outside `### Boundaries` of `SKILL.md`. Inside `### Boundaries` it is allowed. |

Dangerous patterns (`DANGEROUS_INSTRUCTIONS`):

| Pattern | Matches |
| --- | --- |
| `pipe_to_shell` | `curl`/`wget`/`iwr` piped into `sh`/`bash`/`zsh` …; `iex`, `Invoke-Expression` |
| `destructive_delete` | `rm -rf` on `/`, `~`, `$HOME` or `/*` |
| `disable_safety` | `--dangerously-skip-permissions`, `--no-sandbox`, `--yolo`, `bypassPermissions`, or "disable/bypass/skip … permissions/sandbox/approval/safety/guardrails" |
| `read_secrets` | cat/print/echo/upload … of `.env`, credentials, SSH keys, `~/.aws/`, `.npmrc`, `.netrc`, private keys |
| `prompt_injection` | "ignore/disregard/override/forget … previous/system/all … instructions/prompts/rules" |
| `exfiltration` | "send/upload/post … to http(s):// or a webhook"; `curl` with data/form/upload flags to a URL |
| `modify_global_instructions` | `~/.claude`, `~/.codex`, `~/.config/opencode`; "modify … global/user-level … instructions/settings/config" |
| `install_mcp` | "install/add/register/configure/enable … mcp", `mcp add`, `mcpServers` |
| `permission_change` | `chmod 777`, `chmod a+rwx` |

## Evidence references in SKILL.md

`renderSkill` ends every bullet under `## Project constraints` with an evidence marker, which the grounding check parses:

```markdown
- All payment provider calls go through PaymentGateway in src/payments/gateway.ts <sub>evidence: CLAUDE.md, ev_41ce6e7fb8ae</sub>
```

- The marker is the literal `<sub>evidence: `, a comma-separated list of references, then `</sub>` at the end of the line.
- A reference is a packet evidence id (`ev_` + 12 hex), a repository-relative path known from the packet (`./` and trailing `/` are normalised), or an assumption id (`asm_…`).
- References containing `,` or `<` are dropped when rendering, and `<sub>` tags are stripped from statement text, so a statement cannot forge a marker.
- The host never writes markers; it lists references in `projectConstraints[].evidence` of the SkillDraft and the renderer appends them.
- Assumptions the skill relies on are rendered under `## Assumptions` as `` - `asm_…`: <statement> ``.

## Behavioural smoke eval

`createBehaviouralEvalCase` derives one case per run (saved as `behavioural-eval-case.json`):

- `expectedActions`: the first 3 project-constraint statements and first 2 verification items of the draft (or, without a draft, constraints and conventions from the analysis); at most 5. If none, `Complete: <task>`.
- `prohibitedActions`: the first 3 boundaries with "Do not / Never / Avoid" removed, plus two generic ones ("Modify unrelated modules outside the task scope", "Add new dependencies that the project does not already use").
- `id`: `beh_` + 12 hex of a hash of the case.

`runBehaviouralSmokeEval` scores `SKILL.md` statically (no LLM), with `BEHAVIOURAL_THRESHOLDS`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `TERM_COVERAGE_THRESHOLD` | 0.5 | An expected action is covered when ≥ 50% of its keywords appear anywhere in `SKILL.md`. |
| `PROHIBITED_MATCH_THRESHOLD` | 0.8 | A prohibited action is violated when one body line (not a heading, not under `### Boundaries`, not phrased as a prohibition or condition such as "unless", "only if") contains ≥ 80% and at least 2 of its keywords. Actions with fewer than 2 keywords are skipped. |
| `FAIL_BELOW` | 0.6 | Coverage below 60%, or any violation → `fail`. |
| `PASS_AT` | 0.8 | Coverage below 80% → `warning`; otherwise `pass`. |

Findings: `prohibited_action_instructed` (error), `expected_action_missing` (error when coverage < 60%, else warning), `coverage` (info).

`compile --behavioural-result <file>` replaces this static eval with a host-run `BehaviouralEvalResult` (`mode: "host_simulation"`).

## Revision policy

`planRevision` (§8.6) decides what happens after a failed report:

| Condition (checked in order) | Action |
| --- | --- |
| Report `pass` or `warning` | `activate` |
| No budget left | `abort` |
| Behavioural eval passed and every mandatory error code is deterministically fixable, and fixes were not yet applied | `deterministic_fix` |
| Attempts used ≥ maximum | `abort` |
| Remaining budget < 8,000 ms (`DEFAULT_MINIMUM_LLM_REVISION_MS`) | `abort` |
| Otherwise | `llm_revision` |

Deterministically fixable codes: `name_invalid`, `name_too_long`, `description_too_long`, `frontmatter_unknown_key`, `metadata_not_string`, `metadata_invalid`, `frontmatter_missing`, `frontmatter_invalid`, `skill_name_mismatch`, `name_collision`.

How the orchestrator uses it in `run compile`:

- Fixes are applied to every draft before evaluation, so it calls `planRevision` with `deterministicFixApplied: true` and the `deterministic_fix` action never occurs.
- `llm_revision` → response `revision_required` with `hints` and `attemptsLeft`; the host resubmits a revised draft (or `--deterministic`). Anything else → `failed`; the skill is not activated.
- `attemptsUsed` is the number of earlier `compile` calls; the maximum is `execution.maximumRevisionAttempts` (default 1), so a run gets two compiles.
- A draft that fails schema validation skips evaluation and is handled the same way: `revision_required` while attempts and at least 8,000 ms remain, otherwise `failed`.

## Baseline comparison

`compareWithBaseline` (§8.3, [ADR-016](adr/016-static-evaluation-stand-ins.md)) scores the behavioural case twice with the static smoke eval: against the skill, and against the repository's own instruction files from the packet (what the host has without the skill).

| Field | Meaning |
| --- | --- |
| `skillCoverage`, `baselineCoverage` | Share of expected actions covered (rounded to 3 decimals). |
| `lift` | `skillCoverage − baselineCoverage`. |
| `prohibitionsAdded` | Prohibited actions whose keywords the skill covers and the baseline does not. |
| `verdict` | `regresses` if lift < 0; `improves` if lift ≥ 0.05 (`BASELINE_MIN_LIFT`) or `prohibitionsAdded` > 0; else `no_improvement`. |
| `trigger` | `promotion`, `revision`, `regression` or `always`. |
| `mode` | Always `static` today. |

When it runs depends on `evaluation.baselineComparison`: on `run persist --choice project|personal` (trigger `promotion`, or `revision` when revising a saved skill) unless the setting is `never`; and additionally on every successful `compile` when it is `always`. The result is advisory: it never blocks activation or persistence. It is stored in the bundle record and returned as `baseline`; `persist`'s `next` suggests discarding a skill whose verdict is not `improves`.

## `dynamic-skills validate <dir>`

`validate` evaluates an existing skill directory with a subset of the checks: `structural`, `conciseness`, `portability` and `security`. It does not run `grounding`, `scope`, `duplication` or the behavioural eval, because it has no run context.

- The directory is read recursively; symlinks are ignored.
- Token limits are the defaults (2000 target, 5000 maximum); the config file is not read.
- `name_dir_mismatch` compares `name` with the directory's basename.
- Status: `fail` if any of the four checks failed, `warning` if any is not `pass`, else `pass`. Exit code 1 on `fail`.
- Hand-written skills get `metadata_missing` warnings, since only generated skills carry provenance metadata.

## Differences from TechDesign §8

- §8.4's report has no `duplication` check; the code adds it, plus `artifactHash`, `behavioural.result` and `revisionHints`.
- `scope` is never mandatory, and `grounding` is mandatory only through `requireEvidence` (hard-coded to true for runs).
- §8.6 "prefer deterministic fixes" is implemented as always applying fixes before the first evaluation, not as a revision step.
