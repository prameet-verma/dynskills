# ADR-014: Session activation writes to a watched directory and injects instructions; revisions use injection only

**Status:** Accepted

## Context

§9.4 allows success only when the current session can actually receive the skill. None of the three harnesses documents same-turn availability for a skill written to disk. Claude Code also needs `/reload-skills` for a skills directory created after the session started.

## Decision

- **New skills:** activation installs the evaluated artifact into the harness's watched project skills directory and verifies its hash. The response also returns the full `SKILL.md` as `instructions`, so the root agent provably receives it in the current turn (strategy 3 of §9.2).
- **Revisions of a saved skill (§10.6):** these use instruction injection only. The saved copy is replaced only when the user approves persistence (ADR-005). The activator also refuses to overwrite a persisted skill.

## Consequences

- Activation never claims more than it can verify.
- Until persistence, a revised skill exists only in the current conversation. The saved older version stays installed, so other sessions still see the old one.
