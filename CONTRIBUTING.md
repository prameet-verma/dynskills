# Contributing to dynskills

Thanks for helping improve dynskills. This guide covers setting up the project, the checks a change must pass, and how contributions are licensed.

## Licensing of contributions

dynskills is licensed under the [GNU AGPL v3.0](LICENSE) (`AGPL-3.0-only`).

**Every pull request must accept the [Contributor License Agreement](CLA.md).** The pull request template has a CLA checkbox: tick it, and keep it ticked. The **CLA agreement** check fails until the box is ticked, and pull requests can't be merged while it fails. Ticking the box covers that contribution and all your later ones.

The CLA explained:

- **You keep the copyright** in your code.
- **You give the maintainer a broad licence to it**, including the right to release it under other terms, such as a commercial licence alongside the AGPL. This lets the project offer dual licensing without asking every past contributor.
- **You confirm the code is yours to contribute.** If your employer owns what you write, get their permission first.

If you distribute a modified version of dynskills, or let others use one over a network, the AGPL requires you to publish its source. Opening a pull request here is the easiest way to do that.

## Setting up

You need Node.js 26 (`.nvmrc` pins 26.13.1) and pnpm 12.

```bash
nvm use
npm install -g pnpm@12  # Node 26 no longer ships Corepack
pnpm install
pnpm build
```

To try your build as a real command, install it locally:

```bash
pnpm install:local       # links `dynskills` into ~/.local/bin (needs ~/.local/bin on PATH)
pnpm uninstall:local
```

Don't test it through `npx`. The bootstrap skill and plugins are designed never to fall back to `npx`.

## Checks

Every pull request must pass all four:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Other commands:

| Command | What it does |
| --- | --- |
| `pnpm bench` | Runs the benchmark scenarios in `benchmarks/`. Add `-- --host-latency-ms 15000` to simulate LLM time. |
| `pnpm test:harness` | Runs tests in **real Claude Code sessions** on your account. Opt-in, slow, and they use model quota. Run them when you change the bootstrap skill, the bridge protocol or activation. |

**TypeScript versions.** The project builds with TypeScript 7, installed as `typescript7`. The `typescript` 6 package exists only for typescript-eslint, so don't upgrade it on its own.

## Where things live

| Path | Contents |
| --- | --- |
| `src/` | One folder per module, each with an `index.ts` barrel. See [docs/architecture.md](docs/architecture.md) for the module map. |
| `src/contracts/` | Shared types. Change these with care, because every module depends on them. |
| `skills/dynamic-skill-bootstrap/` | The bootstrap skill that `dynskills init` installs. |
| `plugins/` | Native plugins for Claude Code, Codex and OpenCode. |
| `schemas/` | JSON Schemas for the files the host agent writes. |
| `fixtures/`, `benchmarks/` | Sample repositories and benchmark scenarios. |
| `test/` | Vitest suites, mirroring `src/`. |
| `docs/` | Reference guides and [ADRs](docs/adr/README.md). |

## Conventions

- **Imports.** The code is ESM (`nodenext`): relative imports end in `.js`, and type-only imports use `import type`.
- **Strict TypeScript.** `noUncheckedIndexedAccess` and `verbatimModuleSyntax` are on. Don't silence them with `any` or non-null assertions when a check would do.
- **Errors.** Throw `DynamicSkillsError` (via `dsError`) with a category, so the CLI can return structured JSON.
- **Tests.** Every behaviour change needs a test, and every bug fix a regression test. Tests must not touch your real home directory or network; use temporary directories and the `homeDir` options.
- **No secret-shaped strings.** GitHub push protection rejects commits containing anything that looks like a real API key, even a fake one. Build fake keys at runtime, as `FAKE_STRIPE_KEY` in `test/orchestrator/helpers.ts` does.
- **Bootstrap skill copies.** The Claude Code and Codex plugins each carry a copy of `skills/dynamic-skill-bootstrap/SKILL.md`. After editing the original, copy it to both, and a test will check they still match.
- **Harness facts.** Behaviour that depends on Claude Code, Codex or OpenCode (skill folders, reload rules, plugin formats) must match that harness's current official docs. Cite the source in your pull request.
- **Docs.** If you change behaviour described in `docs/`, update the guide in the same pull request. Record a significant design decision as a new ADR in `docs/adr/`.

## Adding a harness

Follow the steps in [docs/adapters.md](docs/adapters.md#adding-a-harness). Every adapter must pass the shared contract suite in `test/adapters/adapters.contract.test.ts`.

## Pull requests

1. **Discuss large changes first.** For new features or behaviour changes, open an issue before writing code.
2. **Keep pull requests focused.** One change per pull request.
3. **Describe the change.** Say what changed and why, and how you tested it. Mention any live harness tests you ran.
4. **Write clear commits.** Use a short imperative subject line, such as "Fix reload hint for new skill directories".

## Releasing (maintainers)

Publishing a GitHub release publishes the same version to npm automatically, through `.github/workflows/release.yml`. The workflow uses npm trusted publishing, so no npm token is stored in the repository, and npm shows a provenance badge linking each version to the workflow run that built it.

1. Bump the version: `npm version patch --no-git-tag-version` (or `minor`/`major`). This also updates every other copy of the version (the CLI, plugin manifests and bootstrap skills) through `scripts/sync-version.mjs`. Commit and push to `main`.
2. Wait for the **CI** checks on that commit to pass.
3. Create a GitHub release whose tag is `v` plus the version, for example `v0.2.0`, pointing at that commit:
   ```bash
   gh release create v0.2.0 --target main --generate-notes
   ```
4. The **Release** workflow checks that the tag matches `package.json`, runs all checks, and publishes. A release marked as a pre-release is published under the npm tag `next` instead of `latest`.

A version can be published only once, so fix a failed release by bumping the version again.

## Reporting bugs and security issues

For bugs, open an issue. Include your `dynskills --version`, your harness and its version, and the output of `dynskills doctor --json`, with anything sensitive removed.

**Don't report security problems in public issues.** Use the private **Report a vulnerability** form in the repository's Security tab. [docs/security.md](docs/security.md) describes what dynskills protects against.
