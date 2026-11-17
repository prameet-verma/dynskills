# Implementation Progress

**Overall: ~97% of the full design document** · last updated 2026-11-16 · live page: https://claude.ai/artifact/FVyY6FphwNfXE28VkNW7Rf

Each workstream has a weight, which is its estimated share of the effort for the whole design document (Phase 6 excluded). Overall % is the sum of weight × % done. A workstream counts as 100% only once its tests pass.

| # | Workstream | TDD § | Weight | Done | Tests | Status |
|---|---|---|---:|---:|---:|---|
| 1 | Toolchain & scaffolding | §12.3 | 3 | 100% | — | ✅ |
| 2 | Contracts & core utilities | §5–§11, §16 | 6 | 100% | 13 | ✅ |
| 3 | Discovery, evidence registry, context packet, fixtures | §5.1–§5.5, §18.3 | 10 | 100% | 51 | ✅ |
| 4 | Schemas & validators, gap analysis, clarification, SLA budget | §5.4–§6, §15.4 | 9 | 100% | 80 | ✅ |
| 5 | Skill compiler & evaluation engine | §7, §8, §15.3 | 9 | 100% | 70 | ✅ |
| 6 | Storage, lifecycle, activation, adapters | §9–§11, §16.3 | 9 | 100% | 64 | ✅ |
| 7 | Orchestrator, CLI, bootstrap skill | §4, §13, §14 | 7 | 100% | 23 | ✅ |
| 8 | Core integration: typecheck, tests, lint, build | §18 | 5 | 100% | — | ✅ |
| 9 | README | — | 2 | 100% | — | ✅ |
| 10 | Repository-change check before activation | §17 | 3 | 100% | 2 | ✅ |
| 11 | Stale-skill revision and versioning | §10.6, Phase 5 | 6 | 100% | 2 | ✅ |
| 12 | Identical installs across harnesses | §10.5 | 3 | 100% | 1 | ✅ |
| 13 | Baseline (skill vs no skill) evaluation | §8.3 | 4 | 100% | 2 | ✅ |
| 14 | Native plugins, commands, OpenCode live registry | §9.3, §11.1, §14.2 | 8 | 100% | 45 | ✅ `init --native`; Claude plugin passes `claude plugin validate` |
| 15 | Performance benchmark suite | §18.7 | 5 | 100% | 15 | ✅ 12 scenarios |
| 16 | Tests inside real harness sessions | §18.6 | 7 | 60% | 3 live | 🟡 Claude Code 3/3 pass; Codex/OpenCode CLIs not installed here |
| 17 | docs/ reference guides and ADRs | — | 4 | 100% | — | ✅ 6 guides + 8 ADRs |
| | **Total** | | **100** | **~97%** | **368** | |

## Out of scope

- Phase 6 ecosystem work (§20): more adapters, community discovery providers, domain extensions. The design leaves it open-ended.

## Known limitations

See the README. The main one: in very large repos the packet can exceed its token budget, because P0 evidence is never dropped.

## What's left (§18.6)

- Live-session tests for **Codex** and **OpenCode**: their CLIs aren't installed on this machine.
- Live coverage of **clarification rounds** and **personal persistence** in Claude Code: both are covered by unit and end-to-end tests, but not yet in a real session.

## Log

- **2026-11-17:** Native integration is done for all three harnesses, and the `docs/` folder is complete (6 guides, 8 ADRs). A docs review found 6 bugs, now fixed with regression tests. 368 tests pass, and 3 of 3 live Claude Code tests pass.
- **2026-11-16:** Repository-change check, stale-skill revision and versioning, multi-harness installs, baseline comparison and the benchmark suite are done (318 tests). Fixed a bug where a saved skill looked stale to itself (ADR-017).
- **2026-11-16:** Re-scoped against the full design document. The earlier 100% covered only that pass's workstreams; overall is now 60%. Core work committed as 8a2988f on `feat/dynamic-skills-implementation`.
- **2026-11-16:** Integration complete. 296 tests, typecheck, lint and build pass. Fixed a false scope warning by passing discovery evidence to the scope check. CLI smoke-tested on this repo and two fixtures.
- **2026-11-16:** All four parallel workstreams complete (discovery 51, analysis 80, compiler 70, adapters 64 tests).
- **2026-11-16:** Toolchain, contracts and core done. Orchestrator, CLI and bootstrap skill written.
