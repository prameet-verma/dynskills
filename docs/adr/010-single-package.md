# ADR-010: One installable package, one folder per logical module

**Status:** Accepted

## Context

§12.1 proposes a monorepo with about 15 packages. §12.1 also says the first implementation should avoid separately deployable services and that "these are logical modules within a single installable toolchain".

## Decision

Ship one npm package, `dynamic-skills`. Each logical package from §12.1 is a folder under `src/` with its own `index.ts` barrel, and the `src/index.ts` root re-exports all of them.

## Consequences

- One `npx dynamic-skills` install, with no build ordering between packages.
- Module boundaries are folder conventions, not package boundaries, so circular imports are only caught in review.
- Any folder can be split into its own package later without changing callers, because each one already has a barrel.
