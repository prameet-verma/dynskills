# Dynamic Skills

A **Just-in-Time Skill Synthesizer** for AI coding agents. When an agent has no skill that covers a specialised task, Dynamic Skills does four things:

1. Discovers the live repository context.
2. Compiles a small, evidence-grounded [Agent Skill](https://openagentskills.dev/docs/specification).
3. Evaluates the skill.
4. Activates it in the current session.

The host agent stays in charge of the task throughout.

Dynamic Skills supports Claude Code, OpenAI Codex and OpenCode, and produces one portable skill format for all three. It has no agent runtime, database or server of its own. See [`TechDesign.md`](TechDesign.md) for the architecture.

## Requirements

- Node.js ≥ 26 (`.nvmrc` pins 26.13.1)
- pnpm 12 (for development)

## Install

```bash
npx dynamic-skills init                      # detect harnesses, install the bootstrap skill (project scope)
npx dynamic-skills init --harness claude,codex,opencode --global
npx dynamic-skills init --native             # also install native plugins (Claude Code/Codex marketplaces, OpenCode live-registry plugin)
npx dynamic-skills doctor                    # diagnose installation and compatibility
```

`init` installs `skills/dynamic-skill-bootstrap` into each harness's native skills directory:

| Harness | Project | Personal |
| --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `.agents/skills/` | `~/.agents/skills/` |
| OpenCode | `.opencode/skills/` | `~/.config/opencode/skills/` |

## How a run works

The root agent drives a run through a request–response bridge. Each command prints JSON with a `status` and a `next` instruction for the agent to follow.

```text
run start  --task "…"        → reuse_existing | awaiting_analysis        (preflight + parallel discovery + Context Packet)
run analyze  <runId> --input → awaiting_analysis (targeted discovery) | awaiting_clarification | awaiting_skill_draft
run clarify  <runId> --input → awaiting_clarification | awaiting_skill_draft   (SLA paused while the user answers; max 3 rounds)
run compile  <runId> --input → revision_required | active | failed             (render → evaluate in parallel → activate)
                 (or --deterministic to compile without an LLM draft)
run persist  <runId> --choice project|personal|ephemeral|discard              (explicit user approval)
                 [--harnesses codex,opencode | --all-harnesses]               (identical copies per harness)
run status | cancel <runId>
```

How the work is split:

- **Host LLM:** interprets the Context Packet (`ContextAnalysisResult`) and drafts the skill (`SkillDraft`). The schemas the host must follow are in [`schemas/`](schemas).
- **Core:** everything deterministic. That covers scanning, limits, redaction, validation, gap analysis, clarification rounds, rendering, evaluation, activation, storage and freshness.

Rules every run follows:

- **Time budget.** Each run has a hard limit of **60 s of active processing**, measured on a monotonic clock that is carried across CLI calls. Time spent waiting for the user to answer is not counted.
- **Expiry.** If the budget runs out, the run degrades gracefully and never skips its checks.
- **Evaluation gate.** A skill that fails a mandatory evaluation is never activated.

## Other commands

```bash
dynamic-skills validate ./my-skill   # structural, conciseness, portability and security checks
dynamic-skills inspect               # discovery profile for the current repository
dynamic-skills list                  # persisted bundles and generated skills
dynamic-skills clean [--all]         # remove expired ephemeral runs and session installs
dynamic-skills benchmark             # §18.7 benchmarks (repository checkout; see benchmarks/README.md)
```

Saved skills are reused only after a freshness check. A stale one is revised instead, with a version bump: a minor version when it is augmented and a major version when it is regenerated. Before activation, files the skill relies on are re-checked, and a change since discovery blocks activation. Promoting a skill records a baseline comparison against the repository's own instructions.

Optional configuration goes in `dynamic-skills.config.json` (see TechDesign §19). The defaults work without one.

## Layout

```text
src/
  contracts/                  shared, versioned interfaces (§5–§11)
  core/                       clock, hashing, tokens, safe fs, redaction, atomic writes, concurrency
  discovery/                  repository scanner + discovery providers (P0/P1)
  evidence-registry/          evidence provenance and claim classification
  context-packet/             Context Packet assembly, limits, targeted requests
  context-analyzer-contracts/ JSON Schema + semantic validation of host-produced JSON
  context-gap-analyzer/       skill sufficiency and gap analysis
  clarification-manager/      rounds, questions, assumption registry
  sla/                        ExecutionBudget (monotonic, pause-aware)
  skill-compiler/             compilation prompt, deterministic fallback, SKILL.md rendering
  eval-engine/                generation + behavioural evaluations, revision policy
  activation/                 activation strategies and verification
  storage/                    runtime dirs, staging, canonical bundles
  lifecycle/                  fingerprints, freshness, lifecycle transitions
  adapter-sdk/, adapters/     harness adapters (Claude Code, Codex, OpenCode)
  orchestrator/               state machine, run store, bridge commands
  cli/                        `dynamic-skills` CLI
skills/dynamic-skill-bootstrap/  the always-discoverable bootstrap skill
schemas/                      published JSON Schemas
fixtures/                     test repositories
```

## Known limitations

- **Live-session tests cover Claude Code only.** Codex and OpenCode adapters are tested against their documented skill directories in temp dirs, because their CLIs aren't installed here. Run `pnpm test:harness` to repeat the Claude Code tests (they start real sessions).
- **The packet can exceed its token budget in very large repositories.** P0 evidence is never dropped (ADR-015).
- **Baseline comparison is static.** It measures how much more of the task the skill covers than the repository instructions do, not how an agent performs with it (ADR-016).
- **Benchmarks exclude LLM time** unless it is simulated with `--host-latency-ms`.
- **`validate` warns about missing provenance metadata** on hand-written skills.

See [docs/](docs/README.md) for the reference guides and [docs/adr/](docs/adr/README.md) for implementation decisions.

## Development

```bash
nvm use            # Node 26.13.1
pnpm install
pnpm test          # vitest
pnpm typecheck     # TypeScript 7
pnpm lint          # ESLint 10 + typescript-eslint
pnpm build
pnpm bench          # benchmarks (core time; add -- --host-latency-ms 15000 to simulate LLM time)
DS_HARNESS_E2E=claude pnpm test:harness   # opt-in: real Claude Code sessions
```

`typescript` in `devDependencies` is pinned to 6.0.3 because typescript-eslint uses its compiler API, and TypeScript 7 no longer ships that API. The project itself builds and type-checks with TypeScript 7.0.2, installed under the alias `typescript7`.
