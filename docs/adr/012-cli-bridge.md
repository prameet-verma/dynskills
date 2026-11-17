# ADR-012: A JSON request–response CLI bridge with persisted run state

**Status:** Accepted

## Context

The root agent owns the LLM (ADR-001). Semantic analysis and skill drafting therefore happen in the host. §3.2 asks for request–response communication with no message broker or orchestration server, and clarification pauses can last minutes.

## Decision

Each generation step is one CLI command: `run start`, `analyze`, `clarify`, `compile`, `persist`, `status` and `cancel`.

- Every command reads its JSON input, advances the §4.1 state machine, and prints a JSON response whose `next` field tells the agent exactly what to do.
- Run state is stored in `.dynamic-skills-runtime/sessions/<session>/runs/<run>/run.json`, alongside the packet, analysis, draft and evaluation files.
- A per-run lock file serialises concurrent commands.
- An identical repeat of the last request returns the cached response (§4.3 idempotency).

## Consequences

- Works with any harness that can run a shell command. No plugin API is needed for the core flow.
- Each step pays process start-up time, which the benchmarks measure as part of active time.
- The host must write JSON files. The schemas in `schemas/` are what it follows.
