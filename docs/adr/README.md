# Architecture Decision Records

ADR-001 to ADR-009 are in the project's design document, which isn't public. The records here continue that numbering and cover decisions made during implementation.

| ADR | Decision | Status |
| --- | --- | --- |
| [010](010-single-package.md) | One installable package, one folder per logical module | Accepted |
| [011](011-typescript-toolchain.md) | Build with TypeScript 7; lint with typescript-eslint on TypeScript 6 | Accepted |
| [012](012-cli-bridge.md) | A JSON request–response CLI bridge with persisted run state | Accepted |
| [013](013-cross-process-budget.md) | The active-processing budget uses the OS monotonic clock across processes | Accepted |
| [014](014-activation-and-revisions.md) | Session activation writes to a watched directory and injects instructions; revisions use injection only | Accepted |
| [015](015-p0-evidence-kept.md) | P0 evidence is never dropped, even past the packet's token budget | Accepted |
| [016](016-static-evaluation-stand-ins.md) | Static baseline comparison and a deterministic stand-in host for benchmarks | Accepted |
| [017](017-skill-files-are-not-context.md) | Installed skill files are excluded from freshness and change detection | Accepted |
| [018](018-two-minute-budget.md) | The active-processing budget is 120 seconds, and the deterministic compile is a last resort | Accepted |
