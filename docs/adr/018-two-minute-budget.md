# ADR-018: The active-processing budget is 120 seconds, and the deterministic compile is a last resort

**Status:** Accepted. Supersedes the 60-second figure in §3, §5 and §18.

## Context

The budget counts the host agent's own thinking time, for example writing the analysis and the SkillDraft. In live Claude Code runs, a full run with a host-written draft took 37–58 seconds, which leaves little margin under 60 seconds.

Under that pressure, agents took the deterministic compile early. In one real run, the agent used 18 seconds on the analysis, then chose `--deterministic` "to stay inside its time budget" with 39 seconds still left. The protocol said only "if you're short on time", with no numbers. The deterministic compile also kept only the analysis constraints whose wording matched cited evidence. That run's observed facts were all dropped, so the skill had no grounded project constraints and failed the grounding check as generic.

## Decision

- **Budget.** The default and maximum active-processing budget is **120 seconds** (`DEFAULT_ACTIVE_BUDGET_MS`). Configuration can still only lower it.
- **When to compile deterministically.** Compile responses state the remaining budget. They tell the host to write a draft unless fewer than **20 seconds** remain (`DETERMINISTIC_COMPILE_THRESHOLD_MS`) or it can't produce a valid draft. The bootstrap skill says the same.
- **Grounding in the deterministic compile.** The deterministic compile also turns each **observed** analysis fact into a project constraint, citing that fact's own source. Inferred claims are never used this way.

## Consequences

- A generation can take up to two minutes of active time before it degrades. Time spent waiting for the user is still excluded.
- Hosts write drafts in the common case, so skills are project-specific.
- When the deterministic compile is used, it keeps the facts the host read directly.
