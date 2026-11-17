# Security

Generated skills are instructions that change how a coding agent behaves, so they are treated as security-relevant artifacts (design §16). This guide lists the controls the code implements, where they live, and what they do not cover.

## Summary

| §16.1 threat | Control in the code |
| --- | --- |
| Prompt injection in repository files | Repository content is data in the packet; analysis claims must trace to packet evidence; the security check rejects injected instructions in the output skill. See [Untrusted repository content](#untrusted-repository-content). |
| Secret exposure | Sensitive files are never read; secrets are redacted from everything that enters the packet; skills containing secrets fail evaluation. |
| Path traversal | Every read and write is resolved inside its root, with symlink checks on reads. |
| Malicious generated scripts | Skills are instruction-only; scripts and executables fail evaluation. Nothing generated is executed. |
| Unsafe instructions | Dangerous-instruction patterns fail evaluation unless phrased as boundaries. |
| Persistent skill poisoning | Saving requires an explicit `run persist` choice; `requireApprovalForPersistence` cannot be disabled. |
| Skill overwrites | Atomic writes; existing directories are replaced only when Dynamic Skills can prove it owns them. |
| Stale instructions | Context fingerprints and freshness checks; changed cited files block activation. |
| Cross-project leakage | Project bundles are reused only in the repository they were created for. |
| Adapter permission mismatch | No code control: Dynamic Skills runs as a CLI under the host's own permission system and never changes host permissions. |

## Excluded and sensitive paths

Defined in `src/core/fs-safety.ts`.

| List | Entries | Effect |
| --- | --- | --- |
| `DEFAULT_EXCLUDED_DIRS` | `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.cache`, `vendor`, `.dynamic-skills-runtime` | Directory names matched at any depth. Not indexed, not read. |
| `SENSITIVE_FILE_PATTERNS` | `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `credentials.*`, `secrets.*` | Basename globs, case-insensitive. Never read. |

These apply in three places:

1. `buildFileIndex` (the list of file names providers see) ignores them, and does not follow symlinks.
2. `readTextFileBounded`, the read path used by discovery and the packet builder, returns `skipped: "sensitive" | "excluded"` for them.
3. Targeted context requests (`checkRequestPath`) reject them with a reason that is returned to the host.

`readTextFileBounded` also skips binaries (a NUL byte in the first 8 KB), non-files, and reads at most `discovery.maximumFileBytes`.

## Redaction

`redactSecrets` (`src/core/redact.ts`) replaces likely secrets:

| Pattern | Replacement |
| --- | --- |
| PEM private key blocks | `[REDACTED:private_key]` |
| AWS access keys (`AKIA…`, `ASIA…`) | `[REDACTED:aws_key]` |
| GitHub tokens (`ghp_…`, `gho_…`, `github_pat_…`) | `[REDACTED:github_token]` |
| Slack tokens (`xoxb-…` …) | `[REDACTED:slack_token]` |
| Prefixed API keys (`sk_…`, `pk_…`, `rk_…`, incl. `sk_live_`, `sk-proj-`, `sk-ant-`) | `[REDACTED:api_key]` |
| JWTs (`eyJ….….…`) | `[REDACTED:jwt]` |
| Assignments to keys containing `password`, `passwd`, `secret`, `token`, `api_key`, `access_key`, `client_secret` with a value of ≥ 8 characters | value → `[REDACTED]` |
| Credentials in URLs (`scheme://user:pass@`) | `scheme://[REDACTED]@` |

It is applied to file contents read into the packet (initial and targeted), to evidence claims, excerpts and values, and to the `reason` of context requests. The security check runs the same patterns over every file of a generated skill and fails with `secret_detected` on any match.

## Path traversal and symlinks

| Where | Check |
| --- | --- |
| `resolveInsideRoot` | Lexical: the resolved path must stay under the root. |
| `resolveRealInsideRoot` | Also resolves symlinks with `realpath` and rejects targets outside the real root. Used by `readTextFileBounded` and by context fingerprinting. |
| `checkRequestPath` (targeted discovery) | Rejects empty paths, NUL, absolute paths, drive letters, `~`, and any `..` segment. |
| `storage/paths.ts` | Session, run and harness ids must be single safe segments (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`, no `..`); run ids loaded from the CLI must match `^run_[a-z0-9]+$`. |
| `assertSafeSkillName` | Skill names become directory names, so they must be lowercase kebab-case, ≤ 64 characters. Checked before staging, bundling, installing and removing. |
| `writeDirAtomic` | Every file path of an artifact is resolved inside the staging directory. |
| Security eval | `path_traversal` for any skill file path that is absolute, has `..`, `.`, empty segments, backslashes or NUL. |
| `readSkillDir` | Reading a skill directory (persist, validate, hash checks) ignores symlinks and special files. |

## Instruction-only artifacts

Generated skills contain only `SKILL.md`, `references/*.md` and (structurally allowed) `assets/`. The renderer only emits `SKILL.md` and `references/<kebab-name>.md`. The evaluation enforces it independently ([evaluation.md](evaluation.md#security-securityts)):

- any `scripts/` file → `scripts_not_allowed`;
- any file with one of 27 executable or script extensions, or starting with `#!` → `executable_artifact`;
- any other file outside `SKILL.md`, `references/`, `assets/` → `unexpected_file`.

Dynamic Skills never executes anything from a generated skill.

## Dangerous-instruction detection

The security check scans every line of every skill file for nine patterns: piping downloads into a shell, recursive deletion of `/` or home, disabling permissions or sandboxes, reading or printing secrets, overriding previous or system instructions, sending data to external URLs, modifying global agent instructions or settings, installing MCP servers, and world-writable `chmod`. The full table is in [evaluation.md](evaluation.md#security-securityts).

- An affirmative instruction fails (`dangerous_instruction`, mandatory).
- The same text phrased as a prohibition ("Do not …", "Never …") is allowed under `### Boundaries` in `SKILL.md`, and a warning elsewhere.

A mandatory failure is never bypassed, including when the budget is short: the run fails instead of activating.

## Integrity from evaluation to install

- The rendered artifact has an `artifactHash`: SHA-256 over its sorted (path, content) pairs.
- The evaluated artifact is staged in the run directory; activation proceeds only if the staged files hash to the evaluated hash.
- Before activation, packet files are re-hashed against their discovery-time hashes. If a file the skill cites changed, the run fails with `repository_changed`; other changed files are only reported (`repositoryChanges.uncited`).
- The activator refuses a skill whose files do not match its hash, and verifies the installed copy's hash after writing.
- `persist` refuses (category `security`) if the staged files no longer match the evaluated hash, and checks every installed copy is byte-identical to the canonical artifact.

## Atomic writes and overwrite refusal

`src/core/atomic.ts`:

- `writeFileAtomic` writes a temp file in the same directory and renames it into place. All JSON state (`run.json`, packet, registry files, bundle records) goes through it.
- `writeDirAtomic` stages a whole directory as a sibling, then renames it into place. If the target exists it refuses with a `persistence` error unless `overwrite` is set; with `overwrite`, the old directory is moved aside and removed only after the swap succeeds (and restored if the swap fails).
- `ArtifactStore.saveCanonical` refuses to replace a bundle with different content unless the caller passes `overwrite`. The orchestrator passes it only when persisting a skill whose bundle already exists, after the user chose to save.

## Ownership registry for installs

Dynamic Skills only overwrites or removes skill directories it can prove it installed.

- Each install is recorded in a JSON registry: `.dynamic-skills-runtime/installs/<harness>.json` for session and project installs, `~/.dynamic-skills/installs/<harness>.json` for personal ones. Entries hold name, skill id, artifact hash, absolute path, harness, scope and time.
- `inspectInstall` treats a directory as owned when its current hash matches a registry entry (**registered and unmodified**), or when its `SKILL.md` carries `dynamic-skills.*` metadata (**marker**).
- **Session activation** writes only to a missing directory, a directory that already holds the identical artifact, or one that is registered, unmodified and ephemeral. It refuses a user's skill, a modified one, and a persisted one (a revision is delivered by instruction injection instead, [ADR-014](adr/014-activation-and-revisions.md)).
- **Persistence** (`saveSkill`) refuses to replace a directory with different content that is not owned.
- **Removal** of ephemeral installs (discard, cancel, `clean`) deletes only registered, unmodified directories directly inside the harness skills directory; a user-edited copy is left in place. Persistent removal refuses directories that are not owned.

The harness adapters guide (docs/adapters.md, in progress) covers the adapter side in more detail.

## Untrusted repository content

Repository files, including agent instruction files such as `CLAUDE.md` and `AGENTS.md`, are treated as evidence, not as instructions to Dynamic Skills:

- Instruction files are recorded as evidence with `trusted: false`. They influence the skill only through the host's analysis and draft.
- Every observed claim in a Context Analysis Result must cite a packet evidence id or a packet path; every project constraint in a draft must cite known evidence, a packet path or a recorded assumption. Unknown references are rejected.
- When a stale skill is regenerated, the compile prompt tells the host to treat the previous version as untrusted history and rebuild every constraint from current evidence; with `augment` the previous `SKILL.md` is included "for reference, not as evidence".
- The rendered skill goes through the security check, so injected text that survives into the skill ("ignore previous instructions", exfiltration, global-config edits …) fails evaluation.
- Generated skills are never persisted without an explicit `persist` call.

## What is not protected against

- **Injection reaching the host LLM.** The packet carries (redacted) repository text to the root agent. The core cannot stop the host model from following instructions embedded in it while it analyses or drafts; it only checks what comes back.
- **Pattern gaps.** Redaction and dangerous-instruction detection are regular expressions. Secrets in other formats, obfuscated commands, or harmful instructions in natural language that match no pattern pass. Conversely, harmless text can be flagged.
- **Behaviour of an activated skill.** Evaluation is static. A skill that passes can still lead an agent to make bad but non-matching changes.
- **Files outside the exclusion lists.** A secret in a file whose name is not on the sensitive list is read (then redacted only if it matches a pattern).
- **Content-based ownership spoofing.** A user skill that happens to carry `dynamic-skills.*` metadata counts as owned for persistent install and removal.
- **Local tampering.** Run state, registries and bundles are plain files in the repository and home directory. Anyone with write access can edit them; hash checks catch a modified staged artifact, but not an edited `run.json` or registry.
- **Concurrent writers outside Dynamic Skills.** Atomic renames protect against partial writes, not against another process changing a skills directory between the ownership check and the write.
- **Personal bundles across repositories.** Personal bundles have `repositoryId: "*"` and can be reused in any repository whose task matches; freshness is checked against the current repository's files.
