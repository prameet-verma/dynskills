# dynskills

**Dynamic Skills for coding agents.** Package and command: `dynskills` (`dynamic-skills` also works as an alias).

A **Just-in-Time Skill Synthesizer** for AI coding agents. When an agent has no skill that covers a specialised task, Dynamic Skills does four things:

1. Discovers the live repository context.
2. Compiles a small, evidence-grounded [Agent Skill](https://openagentskills.dev/docs/specification).
3. Evaluates the skill.
4. Activates it in the current session.

The host agent stays in charge of the task throughout.

Dynamic Skills supports Claude Code, OpenAI Codex and OpenCode, and produces one portable skill format for all three. It has no agent runtime, database or server of its own. See [docs/architecture.md](docs/architecture.md) for the architecture.

## Requirements

- Node.js ≥ 26 (`.nvmrc` pins 26.13.1)
- pnpm 12 (for development)

## Install

```bash
npm install -g dynskills                 # puts `dynskills` (and the `dynamic-skills` alias) on PATH
dynskills init                           # detect harnesses, install the bootstrap skill (project scope)
dynskills init --harness claude,codex,opencode --global
dynskills init --native                  # also install native plugins (Claude Code/Codex marketplaces, OpenCode live-registry plugin)
dynskills doctor                         # diagnose installation and compatibility
```

Install it globally rather than running it through `npx`. Coding agents call the `dynskills` command directly on every step of a run.

### Install from a checkout (local testing)

```bash
pnpm install
pnpm install:local       # build, pack, install into ~/.local/share/dynskills, link into ~/.local/bin
pnpm uninstall:local     # remove it again
```

The linked command runs with the Node ≥ 26 binary it was installed with, even when your shell defaults to an older Node. Make sure `~/.local/bin` is on your `PATH`.

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
dynskills validate ./my-skill   # structural, conciseness, portability and security checks
dynskills inspect               # discovery profile for the current repository
dynskills list                  # persisted bundles and generated skills
dynskills clean [--all]         # remove expired ephemeral runs and session installs
dynskills benchmark             # §18.7 benchmarks (repository checkout; see benchmarks/README.md)
```

Saved skills are reused only after a freshness check. A stale one is revised instead, with a version bump: a minor version when it is augmented and a major version when it is regenerated. Before activation, files the skill relies on are re-checked, and a change since discovery blocks activation. Promoting a skill records a baseline comparison against the repository's own instructions.

Optional configuration goes in `dynamic-skills.config.json` (see [docs/configuration.md](docs/configuration.md)). The defaults work without one.

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
  cli/                        `dynskills` CLI
skills/dynamic-skill-bootstrap/  the always-discoverable bootstrap skill
schemas/                      published JSON Schemas
fixtures/                     test repositories
```

## Known limitations

- **Live-session tests cover Claude Code only.** Four tests run in real Claude Code sessions: discovery, explicit invocation, a clarification round with a global save, and automatic invocation. The Codex and OpenCode adapters are tested only against their documented skill directories, in temporary folders, because no authenticated Codex or OpenCode CLI was available here. Run `pnpm test:harness` to repeat the Claude Code tests; they start real sessions.
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

## License

dynskills is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Copyright (C) 2026 Prameet Verma.

- **Free to use.** You can use dynskills for any purpose, including commercial work.
- **Share your changes.** If you distribute a modified version, or let others use it over a network, you must publish its complete source under the same licence.
- **Generated skills are yours.** The skills and other files dynskills generates from your repository aren't covered by the AGPL; [NOTICE](NOTICE) grants this as an additional permission.

Changes you keep private and never distribute or offer to others don't have to be published; no open-source licence can require that.

