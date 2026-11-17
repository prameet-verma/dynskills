# ADR-017: Installed skill files are excluded from freshness and change detection

**Status:** Accepted

## Context

Discovery reports existing skills as evidence, so their `SKILL.md` paths appeared among the files a skill's fingerprint depended on. Saving a revised skill changes its own `SKILL.md`, so the skill then looked stale to itself on every later run.

## Decision

Paths under `.claude/skills/`, `.agents/skills/`, `.opencode/skills/`, `.dynamic-skills/` and `.dynamic-skills-runtime/` are excluded from:

- context fingerprints (§10.6)
- the repository-change check before activation (§17)

## Consequences

- A skill is judged only by the project files it relies on.
- Changes to other skills never invalidate it. Duplication with other skills is still checked by the evaluation engine.
