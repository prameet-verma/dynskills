# ADR-015: P0 evidence is never dropped, even past the packet's token budget

**Status:** Accepted

## Context

§5.3 sets an initial packet budget of about 12,000 tokens and says P0 discovery (languages, runtimes, frameworks, structure, instructions, build and test configuration) must be available before semantic analysis.

## Decision

When the packet is over budget, content is removed lowest-priority first: non-P0 excerpts, then source excerpts, then configuration contents, then non-P0 evidence, then instruction contents, then P0 excerpts. P0 evidence entries are never removed. If P0 evidence alone exceeds the budget, the packet goes over and records why in `discoveryLimits.reasons`.

## Consequences

- Analysis always sees the facts that define the project.
- Very large monorepos can exceed the budget; this repository, with its 8 fixtures, comes out at about 15.8k tokens. The budget is a "proposed default, to be adjusted through benchmarking" (§5.3). If overruns are common in practice, the next step is to summarise P0 evidence per workspace rather than drop it.
