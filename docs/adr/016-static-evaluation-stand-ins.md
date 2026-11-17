# ADR-016: Static baseline comparison and a deterministic stand-in host for benchmarks

**Status:** Accepted

## Context

§8.3 asks for skill-versus-no-skill comparison when a skill is promoted. §18.7 asks for benchmarks of end-to-end active time. Both normally involve an LLM, and the core owns none (ADR-001).

## Decision

- **Baseline (§8.3).** The behavioural eval case is scored statically twice: once against the skill, and once against the repository's own instructions, which is what the host has without the skill.
  - The result records coverage for each, the lift and any prohibitions the skill adds, with a verdict of `improves`, `no_improvement` or `regresses`.
  - It runs when a skill is promoted or revised (`baselineComparison: "promotion-only"`, the default), on every run (`"always"`), or never.
  - It is advisory, so promotion is not blocked, and the result is stored in the bundle.
  - A host simulation can replace the static mode later through `mode: "host_simulation"`.
- **Benchmarks (§18.7).** A deterministic stand-in builds the Context Analysis Result from the packet and uses the deterministic compiler. LLM time is excluded unless it is simulated with `--host-latency-ms`, which counts against the SLA.

## Consequences

- Both run in milliseconds and in CI, with no model access.
- Static coverage is a proxy for usefulness. It shows whether a skill adds guidance beyond the repository instructions, not whether an agent performs better with it.
