# Configuration

Dynamic Skills works without configuration. To change a default, put a `dynamic-skills.config.json` at the repository root (the `--root` directory). The file may set any subset of keys; missing keys keep their defaults (`DEFAULT_CONFIG` in `src/contracts/index.ts`). Loading and validation are in `src/orchestrator/config.ts`.

```json
{
  "execution": { "maximumClarificationRounds": 1 },
  "discovery": { "maximumFiles": 20 },
  "evaluation": { "baselineComparison": "never" }
}
```

## When the file is read

- `run start` reads it once and stores the resolved config in the run's `run.json`. Later commands of that run use the stored copy, so editing the file mid-run has no effect on that run.
- `doctor` validates it (check `config`), `inspect` uses the discovery limits, `clean` uses `lifecycle.ephemeralRetentionHours`.
- `validate` does **not** read it: it always uses the default token limits.

## Keys

| Key | Default | Allowed | Effect |
| --- | --- | --- | --- |
| `version` | `"1.0"` | any string | Not read by the code. |
| `mode` | `"auto"` | `"auto"`, `"explicit"`, `"off"` | `"off"`: `run start` fails with a `configuration` error ("Dynamic Skills is disabled"). `"auto"` and `"explicit"` currently behave the same. |
| `execution.activeBudgetMs` | `60000` | `0 < n ≤ 60000` | Active-processing budget per run ([bridge-protocol.md](bridge-protocol.md#budget)). Can only be lowered. |
| `execution.maximumClarificationRounds` | `3` | `0`–`3` | Clarification rounds per run. `0` means never ask: open questions become assumptions. |
| `execution.maximumRevisionAttempts` | `1` | number | Extra `compile` attempts after the first. Total attempts = this + 1. |
| `discovery.mode` | `"hybrid"` | `"hybrid"`, `"programmatic"` | Not read by the code. |
| `discovery.parallel` | `true` | boolean | `false` runs discovery providers one at a time (concurrency 1) during runs. |
| `discovery.contextTokenBudget` | `12000` | number | Approximate token budget of the Context Packet. P0 evidence is kept even past it ([ADR-015](adr/015-p0-evidence-kept.md)). |
| `discovery.maximumFiles` | `30` | number | Maximum files whose content goes into the packet. |
| `discovery.maximumFileBytes` | `65536` | number | Maximum bytes read per file. |
| `discovery.maximumTotalBytes` | `524288` | number | Maximum bytes of file content in the packet. |
| `discovery.providerTimeoutMs` | `4000` | number | Timeout per discovery provider. A timed-out provider is reported with status `timeout`; the others still contribute. |
| `discovery.concurrency` | `6` | number | Maximum providers running at once (when `parallel` is true; `inspect` always uses it). |
| `generation.targetSkillTokens` | `2000` | ≤ `maximumSkillTokens` | Above this, the conciseness check warns. Also stated in the compile prompt. |
| `generation.maximumSkillTokens` | `5000` | number | Above this, the conciseness check fails (mandatory). |
| `generation.format` | `"agent-skills"` | `"agent-skills"` | Copied into the compilation policy; there is no other format. |
| `evaluation.generationChecks` | `"required"` | `"required"` | Not read by the code. Generation checks are always run and mandatory checks always gate activation. |
| `evaluation.behaviouralSmokeEval` | `"required"` | `"required"`, `"optional"` | `"required"`: a failed smoke eval blocks activation. Any other value: a failure is only a warning. |
| `evaluation.baselineComparison` | `"promotion-only"` | `"promotion-only"`, `"always"`, `"never"` | When the skill-versus-no-skill comparison runs: on `persist` to project/personal (`promotion-only`); also on every successful `compile` (`always`); never (`never`). See [evaluation.md](evaluation.md#baseline-comparison). |
| `lifecycle.defaultScope` | `"ephemeral"` | `"ephemeral"` | Not read by the code. New skills are always ephemeral until `persist`. |
| `lifecycle.requireApprovalForPersistence` | `true` | `true` | Cannot be disabled (§10.4). |
| `lifecycle.ephemeralRetentionHours` | `24` | number | `dynamic-skills clean` removes run directories (and ephemeral session installs) not updated for this long. `clean --all` uses 0. |

"number" means the loader only checks the type. Discovery limits that are negative or non-finite fall back to their defaults when the packet is built.

## Validation

`resolveConfig` deep-merges the file over the defaults and throws a `configuration` error (exit code 1 from the CLI; `doctor` reports `config: fail`) when:

| Rule | Error message |
| --- | --- |
| A key is not in `DEFAULT_CONFIG` | `unknown setting "<path>"` |
| A value's JSON type differs from the default's type | `"<path>" must be a <type>` |
| A section is not an object | `"<path>" must be an object` |
| `execution.activeBudgetMs` ≤ 0 or > 60000 | `… the 60-second SLA is a hard limit` |
| `execution.maximumClarificationRounds` < 0 or > 3 | `… must be between 0 and 3` |
| `generation.targetSkillTokens` > `generation.maximumSkillTokens` | `… cannot exceed maximumSkillTokens` |
| `lifecycle.requireApprovalForPersistence` is `false` | `… cannot be disabled (§10.4)` |

Enumerated string settings are checked against their allowed values: for example, `"mode": "manual"` fails with `"mode" must be one of "auto", "explicit", "off"`. A file that is not valid JSON fails with a parse error reported as category `internal`.

Constants that are not configurable: at most 3 invalid `analyze` submissions, at most 2 targeted-discovery rounds, the per-stage timeouts in `STAGE_BUDGET_MS` (discovery 12 s, evaluation 10 s, activation 5 s), and the 8 s minimum for an LLM revision.

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `DYNAMIC_SKILLS_SESSION_ID` | orchestrator, adapters | Session id for run directories (`.dynamic-skills-runtime/sessions/<id>/`). Must match `^[A-Za-z0-9_-]{1,80}$` for the orchestrator to use it. |
| `CLAUDE_SESSION_ID`, `CODEX_SESSION_ID`, `OPENCODE_SESSION_ID` | orchestrator | Fallbacks for the session id, in that order. Without any, the session id is `sess_<YYYY-MM-DD>`. |
| `PATH` (`Path`, and `PATHEXT` on Windows) | adapter SDK | Harness detection (`init`, `doctor`, `persist --all-harnesses`) and the adapters' `installed` capability look for the `claude`, `codex` and `opencode` binaries. |

Git is run with `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0` added to the environment when reading repository identity. No other environment variables are read.

## Differences from TechDesign §19

- The code adds `discovery.maximumFileBytes`, `maximumTotalBytes`, `providerTimeoutMs`, `concurrency` and `lifecycle.ephemeralRetentionHours`.
- `mode: "explicit"`, `discovery.mode`, `evaluation.generationChecks` and `lifecycle.defaultScope` are accepted but have no effect.
