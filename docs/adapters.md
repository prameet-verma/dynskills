# Harness adapters

This guide covers how Dynamic Skills integrates with Claude Code, Codex and OpenCode, and how to add another harness. The core is harness-agnostic (§11). Everything harness-specific lives in `src/adapters/<harness>/`, in `src/adapter-sdk/` (the shared base class and installers) and in `plugins/<harness>/`.

## At a glance

| | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Project skills | `.claude/skills/` | `.agents/skills/` | `.opencode/skills/` |
| Personal skills | `~/.claude/skills/` | `~/.agents/skills/` | `~/.config/opencode/skills/` |
| Activation, in order | watched directory → instruction injection → explicit reload | watched directory → instruction injection → explicit reload | live registration (plugin installed) → watched directory → instruction injection |
| Picks up new skills mid-session | Yes, for directories that existed when the session started; otherwise `/reload-skills` | Automatically; restart if a skill doesn't appear | Through the plugin's `ctx.skill.reload()` |
| Explicit invocation | `/<skill-name>`, or `/dynskills:generate-skill <task>` with the plugin | `$<skill-name>` | `@<skill-id>`, or `/dynamic-skills <task>` with the plugin |
| Native integration (`init --native`) | Local plugin marketplace; you run 2 commands | Local plugin marketplace; install from `/plugins` | Plugin file in `.opencode/plugins/`, loaded at startup |
| Tested in a live session | Yes (`pnpm test:harness`) | No, CLI not available here | No, CLI not available here |

## Installing

```bash
dynskills init --harness claude,codex,opencode            # bootstrap skill only
dynskills init --harness claude,codex,opencode --native   # plus native plugins
dynskills init --global ...                               # personal scope instead of project
```

- **Without `--native`:** `init` copies `skills/dynamic-skill-bootstrap` into each harness's skills directory and confirms the harness can discover it.
- **Codex extra file:** the Codex copy also gets `agents/openai.yaml` with its display name and `allow_implicit_invocation`. It's added only for the bootstrap, never for generated skills, which must stay byte-identical across harnesses (§10.5). It's left out of the hash comparison.
- **With `--native`:**
  - **Claude Code and Codex:** `init` copies a plugin marketplace into `.dynamic-skills/marketplaces/<harness>/` and prints the commands to finish the install. Dynamic Skills never runs `claude` or `codex` itself. The bootstrap then comes from the plugin, so the plain skill is not installed as well; otherwise it would be listed twice.
  - **OpenCode:** `init` installs the bootstrap skill and copies `plugins/opencode/dynskills.js` into `.opencode/plugins/`.
- **Re-running `init`:** this is safe. Files are compared with what Dynamic Skills wrote last time, recorded in `.dynamic-skills-install.json` or by a marker in the plugin file. A file someone has edited is reported as a `conflict` and left alone unless you pass `--force`.

### Claude Code plugin (`plugins/claude-code/`)

- `dynamic-skills/.claude-plugin/plugin.json`. It passes `claude plugin validate`.
- `skills/dynamic-skill-bootstrap/SKILL.md`, a byte-identical copy of the bootstrap. A test keeps it in sync.
- `skills/generate-skill/SKILL.md`, the explicit `/dynskills:generate-skill <task>` command. It has `disable-model-invocation: true`, and it runs the bootstrap protocol with `--force-generate`.
- `bin/dynskills`, a POSIX wrapper that Claude Code puts on the Bash tool's PATH. It uses an installed `dynskills` if there is one, otherwise `npx --yes dynamic-skills`, and guards against calling itself.
- There are no hooks. A SessionStart `reloadSkills` hook only re-finds skills that already exist at session start. It doesn't make Claude Code watch a directory created later.

### Codex plugin (`plugins/codex/`)

- A portable root `plugin.json` (`agent-plugins.org` schema) plus `skills/`, listed in `.agents/plugins/marketplace.json`.
- Codex documents no non-interactive install. After `codex plugin marketplace add <dir>`, install it from `/plugins`. Its skills are available from the next Codex session.

### OpenCode plugin (`plugins/opencode/dynskills.js`)

- One self-contained file, because OpenCode loads every `.js` or `.ts` file in a plugins directory as a plugin. It targets the V2 plugin API (`Plugin.define({ id, setup(ctx) })`).
- **Command:** it adds `/dynskills` through `ctx.command.transform`.
- **Live registration:** it reads `.dynamic-skills-runtime/live-skills/opencode.json` and registers each entry with `ctx.skill.transform`, adding or updating it by id. It watches that file and calls `ctx.skill.reload()` when it changes.
- **Fallbacks:** if `@opencode/plugin` can't be imported, it exports a plain `{ id, setup }` object. If `ctx.skill` is missing, it skips live registration.

## Activation in a running session

`loadSkillForSession` installs the evaluated artifact into the project skills directory. It then checks the installed files against the evaluated hash and returns the full `SKILL.md` as `instructions`, so the current turn receives the skill even if the harness hasn't noticed the new directory yet (ADR-014).

- **Reload flag.** `requiresReload` is true when the skills directory didn't exist before Dynamic Skills created it in the current session. The response's `reloadInstruction` and `next` give the harness's step, for example `/reload-skills`. A later session, which watches the directory from the start, gets no reload flag.
- **OpenCode with the plugin installed.** Activation also upserts the skill into the live-skills file and reports `live_skill_registration`. The plugin registers it on the model's next step, provided the plugin is loaded. The instructions are still returned, because nothing confirms that the plugin loaded.
- **Revisions of a saved skill.** These use instruction injection only. The saved copy is replaced only when the user persists the new version (ADR-014).

## Ownership and safety

- **Install records.** Every install Dynamic Skills makes is recorded with its hash:
  - project and session installs in `.dynamic-skills-runtime/installs/<harness>.json`
  - personal installs in `~/.dynamic-skills/installs/<harness>.json`
- **Ownership.** A skill directory counts as ours if one of two things is true:
  - the registry entry's hash still matches the files on disk, or
  - its `SKILL.md` frontmatter has a `dynamic-skills.*` metadata key.
- **Overwriting.** Session activation never overwrites a skill it didn't install, or a persisted skill. `saveSkill` and `removeSkill` refuse to touch a user's own skill with the same name.
- **Deactivation and `clean`.** Both remove only unmodified session installs. If you edited a generated skill, it stays.

## Adding a harness

1. Add the id to `HarnessId` and `HARNESS_IDS` in `src/contracts/index.ts`.
2. Create `src/adapters/<harness>/index.ts` with a class extending `BaseHarnessAdapter`. It must implement:
   - `id` and `binaryName`, the CLI name used for detection on PATH
   - `activationCapabilities`, in §9.2 preference order
   - `projectSkillsRel()` and `personalSkillsRel()`
   - `invocationHint(name)` and `reloadHint(name)`. `reloadHint` may return `undefined` when the harness watches directories live.
   - optionally, `harnessExtraFiles(name)` for bootstrap-only extras
3. Register the class in `createAdapter` (`src/adapters/index.ts`), and add detection to `detectHarnesses` (`src/adapter-sdk/detect.ts`).
4. Add the harness to the `describe.each` cases in `test/adapters/adapters.contract.test.ts`. Every adapter must pass the same contract suite (§18.2), which covers:
   - discovery and installation
   - activation with hash verification
   - refusal to overwrite a user's skill
   - removal of its own installs only
   - clarification delegation
5. For native integration, add `plugins/<harness>/` and a branch in `installNativeIntegration` (`src/adapter-sdk/native-integration.ts`) that copies files and returns any steps the user must run as `instruction` actions.

## Verification status

Facts the adapters depend on were checked against each harness's official docs on 2026-11-16:

- skill directories and live-reload behaviour
- plugin manifest and marketplace formats
- the OpenCode V2 skill registry API
- `$ARGUMENTS` in commands

These are still unverified, and the code is written so it doesn't depend on them:

- same-turn availability of a newly written skill in any harness (hence instruction injection)
- whether `@opencode/plugin` can be resolved from a project plugin file
- whether `codex plugin marketplace add` accepts absolute paths

Re-check the plugin formats when you raise the minimum supported harness versions (§11.3).
