# ADR-011: Build with TypeScript 7; lint with typescript-eslint on TypeScript 6

**Status:** Accepted

## Context

The project uses the latest toolchain: Node 26.13.1 and TypeScript 7.0.2. TypeScript 7 is the native compiler and no longer ships the JavaScript compiler API. typescript-eslint 8.x needs that API and declares `typescript <6.1` as a peer dependency. pnpm `overrides` and `packageExtensions` do not change how peer dependencies resolve.

## Decision

- `typescript` in `devDependencies` is pinned to **6.0.3**. Only typescript-eslint uses it.
- TypeScript **7.0.2** is installed under the alias `typescript7`. The `build` and `typecheck` scripts call `node node_modules/typescript7/bin/tsc` directly.

## Consequences

- Builds and type-checks use TypeScript 7. ESLint parses with TypeScript 6, so lint rules never see TypeScript 7-only syntax. That is acceptable while the code stays within syntax both versions share.
- When typescript-eslint supports TypeScript 7, remove the alias and go back to a single `typescript` dependency.
