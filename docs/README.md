# Dynamic Skills documentation

Reference documentation for Dynamic Skills, a TypeScript tool that generates Agent Skills just in time for coding agents. The project [README](../README.md) covers installation and a short overview; [TechDesign.md](../TechDesign.md) is the design. These guides describe what the code under `src/` actually does, and call out where it differs from the design.

## Guides

| Guide | What it covers |
| --- | --- |
| [Architecture](architecture.md) | Module map (src/ ↔ TechDesign ↔ exports), the lifecycle of one run, on-disk state, the state machine |
| [Bridge protocol](bridge-protocol.md) | JSON contract of every `dynamic-skills run …` command: inputs, statuses, response fields, errors, exit codes, idempotency, locking, budget |
| [Configuration](configuration.md) | Every key of `dynamic-skills.config.json`, validation rules, environment variables |
| [Evaluation](evaluation.md) | Generation checks and finding codes, behavioural smoke eval, revision policy, baseline comparison, `validate` |
| [Security](security.md) | The §16 controls as implemented, and what is not protected against |

- [Harness adapters](adapters.md): per-harness skill directories, activation and reload behaviour, native plugins (`init --native`), ownership rules, and how to add a harness.

## Who each guide is for

**Harness integrators** (people wiring Dynamic Skills into a coding agent, or writing the bootstrap skill prompt) need the [bridge protocol](bridge-protocol.md) first: it is the only interface the root agent sees. [Configuration](configuration.md) and [security](security.md) tell them what the user can tune and what guarantees they can rely on. **Contributors** should start with [architecture](architecture.md) to find the module that owns a behaviour, then [evaluation](evaluation.md) when changing what makes a skill pass or fail. **Reviewers** checking a generated skill will mostly want [evaluation](evaluation.md) and [security](security.md).

## Other references

- [Architecture Decision Records](adr/README.md) — ADR-010 to ADR-017 (ADR-001 to ADR-009 are in [TechDesign.md §21](../TechDesign.md#21-architectural-decision-records)):
  - [010](adr/010-single-package.md) One installable package, one folder per logical module
  - [011](adr/011-typescript-toolchain.md) Build with TypeScript 7; lint with typescript-eslint on TypeScript 6
  - [012](adr/012-cli-bridge.md) A JSON request–response CLI bridge with persisted run state
  - [013](adr/013-cross-process-budget.md) The 60-second budget uses the OS monotonic clock across processes
  - [014](adr/014-activation-and-revisions.md) Session activation writes to a watched directory and injects instructions; revisions use injection only
  - [015](adr/015-p0-evidence-kept.md) P0 evidence is never dropped, even past the packet's token budget
  - [016](adr/016-static-evaluation-stand-ins.md) Static baseline comparison and a deterministic stand-in host for benchmarks
  - [017](adr/017-skill-files-are-not-context.md) Installed skill files are excluded from freshness and change detection
- [Performance benchmarks](../benchmarks/README.md) — how `dynamic-skills benchmark` measures §18.7 metrics and the 60 s SLA.
- [JSON Schemas](../schemas/) — what the host must write for `analyze`, `clarify` and `compile`.
