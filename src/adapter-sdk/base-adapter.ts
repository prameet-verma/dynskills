import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ActivationCapability,
  ActivationResult,
  ClarificationRequest,
  ClarificationResponse,
  GeneratedSkill,
  HarnessAdapter,
  HarnessId,
  HostCapabilities,
  SkillFile,
  SkillInventoryItem,
  StorageScope,
  WorkspaceContext,
} from "../contracts/index.js";
import { dsError, hashSkillFiles, isoNow, newId, writeDirAtomic } from "../core/index.js";
import { DirectorySkillActivator, InstallRegistry, inspectInstall, skillNameFromId } from "../activation/index.js";
import { assertSafeSkillName, installRegistryPath, parseSkillMd, readSkillDir } from "../storage/index.js";
import type { PersistentScope } from "../storage/index.js";
import { isOnPath } from "./detect.js";
import { readRepositoryIdentity } from "./workspace.js";

export interface AdapterOptions {
  projectRoot: string;
  homeDir?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  askUser?: (req: ClarificationRequest) => Promise<ClarificationResponse>;
  workspace?: Partial<WorkspaceContext>;
}

/**
 * §11 shared adapter behaviour. Subclasses provide the harness id, native skill directories,
 * activation capabilities and the hints given to the root agent. All file writes are atomic and
 * never replace a skill directory Dynamic Skills did not install (§16.3).
 */
export abstract class BaseHarnessAdapter implements HarnessAdapter {
  abstract readonly id: HarnessId;
  /** CLI binary used for best-effort install detection. */
  protected abstract readonly binaryName: string;
  /** Activation capabilities this adapter actually implements for the host (§9.2). */
  protected abstract readonly activationCapabilities: readonly ActivationCapability[];
  /** Whether this adapter integrates through a native host plugin (the CLI-bridged adapters do not). */
  protected readonly pluginIntegration: boolean = false;

  readonly projectRoot: string;
  readonly homeDir: string;
  protected readonly opts: AdapterOptions;
  private generatedSessionId: string | undefined;
  private cachedCapabilities: HostCapabilities | undefined;
  private activator: DirectorySkillActivator | undefined;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
    this.projectRoot = path.resolve(opts.projectRoot);
    this.homeDir = path.resolve(opts.homeDir ?? homedir());
  }

  /** Relative project skill dir (e.g. ".claude/skills"). */
  protected abstract projectSkillsRel(): string;
  /** Relative-to-home personal skill dir (e.g. ".claude/skills"). */
  protected abstract personalSkillsRel(): string;
  /** How the root agent should invoke/apply an activated skill. */
  abstract invocationHint(name: string): string;
  /** Instruction for when the host must reload skills; undefined if the host has no explicit reload. */
  abstract reloadHint(name: string): string | undefined;

  /**
   * Harness-specific files installed beside a skill's canonical files (e.g. Codex
   * `agents/openai.yaml`). Only used for the bootstrap skill and only when requested: §10.5 requires
   * generated skills to stay identical across harness installs, so saveSkill/activation never add
   * extras. Extras are excluded from the canonical hash comparison (see installBootstrap).
   */
  async harnessExtraFiles(_skillName: string): Promise<SkillFile[]> {
    return [];
  }

  /** Absolute native skills directory for a persistent scope. */
  skillsDirFor(scope: PersistentScope): string {
    return scope === "project" ? path.join(this.projectRoot, this.projectSkillsRel()) : path.join(this.homeDir, this.personalSkillsRel());
  }

  protected registryFor(scope: PersistentScope): InstallRegistry {
    const rootOpts = { projectRoot: this.projectRoot, homeDir: this.homeDir };
    return new InstallRegistry(installRegistryPath(scope, this.id, rootOpts));
  }

  protected sessionActivator(): DirectorySkillActivator {
    this.activator ??= new DirectorySkillActivator({
      harness: this.id,
      skillsDir: this.skillsDirFor("project"),
      capabilities: [...this.activationCapabilities],
      sessionId: this.sessionId(),
      reloadHint: (name) => this.reloadHint(name) ?? `Restart or refresh the session if "${name}" is not listed; its instructions are included in this result.`,
      invocationHint: (name) => this.invocationHint(name),
      registryPath: installRegistryPath("project", this.id, { projectRoot: this.projectRoot, homeDir: this.homeDir }),
    });
    return this.activator;
  }

  async initialize(): Promise<void> {
    this.cachedCapabilities = undefined;
    await this.getCapabilities();
  }

  /** Runtime capability detection; `installed` is resolved by scanning PATH. */
  async getCapabilities(): Promise<HostCapabilities> {
    if (this.cachedCapabilities) return this.cachedCapabilities;
    const installed = await isOnPath(this.binaryName, this.opts.env ?? process.env);
    this.cachedCapabilities = {
      harness: this.id,
      activation: [...this.activationCapabilities],
      nativeExplicitInvocation: true,
      nativeAutomaticSkillSelection: true,
      nativeUserInteraction: true,
      pluginIntegration: this.pluginIntegration,
      projectSkillsDir: this.skillsDirFor("project"),
      personalSkillsDir: this.skillsDirFor("personal"),
      installed,
    };
    return this.cachedCapabilities;
  }

  async getWorkspaceContext(): Promise<WorkspaceContext> {
    const ws = this.opts.workspace ?? {};
    const root = path.resolve(ws.root ?? this.projectRoot);
    const identity = ws.repositoryId !== undefined ? { repositoryId: ws.repositoryId } : await readRepositoryIdentity(root);
    const revision = ws.revision ?? ("revision" in identity ? identity.revision : undefined);
    return {
      root,
      workingDirectory: path.resolve(ws.workingDirectory ?? root),
      repositoryId: identity.repositoryId,
      ...(revision !== undefined ? { revision } : {}),
      sessionId: this.sessionId(),
    };
  }

  protected sessionId(): string {
    const fromOpts = this.opts.sessionId ?? this.opts.workspace?.sessionId ?? (this.opts.env ?? process.env).DYNAMIC_SKILLS_SESSION_ID;
    if (fromOpts) return fromOpts;
    this.generatedSessionId ??= newId("ses");
    return this.generatedSessionId;
  }

  /** Skills already discoverable by this harness (project + personal dirs). Malformed skills are skipped. */
  async getExistingSkills(): Promise<SkillInventoryItem[]> {
    const items: SkillInventoryItem[] = [];
    for (const scope of ["project", "personal"] as const) {
      const dir = this.skillsDirFor(scope);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const skillDir = path.join(dir, e.name);
        const st = await stat(skillDir).catch(() => undefined); // follows symlinked skill dirs
        if (!st?.isDirectory()) continue;
        const content = await readFile(path.join(skillDir, "SKILL.md"), "utf8").catch(() => undefined);
        if (content === undefined) continue;
        const parsed = parseSkillMd(content);
        if (!parsed) continue;
        items.push({ name: parsed.frontmatter.name, description: parsed.frontmatter.description, path: skillDir, scope, harness: this.id });
      }
    }
    return items.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  }

  /**
   * In the CLI-bridged design the root agent asks through its native question tool and submits the
   * answers; adapters only delegate when a host callback is injected.
   */
  async askUser(request: ClarificationRequest): Promise<ClarificationResponse> {
    if (this.opts.askUser) return this.opts.askUser(request);
    throw dsError("clarification", "adapter", "Clarification must be asked by the root agent through the harness's native question tool", {
      recoverable: true,
      runId: request.runId,
      fallbackAction: "Return the clarification request to the root agent, ask natively, then submit the answers.",
    });
  }

  async loadSkillForSession(skill: GeneratedSkill): Promise<ActivationResult> {
    return this.sessionActivator().activate(skill);
  }

  /** Persist into the native project/personal skills dir. Requires prior user approval (enforced by the caller, §10.4). */
  async saveSkill(skill: GeneratedSkill, scope: PersistentScope): Promise<void> {
    assertSafeSkillName(skill.name);
    if (hashSkillFiles(skill.files) !== skill.artifactHash) {
      throw dsError("persistence", "adapter", `Skill ${skill.name} files do not match its artifactHash`, { recoverable: false });
    }
    const target = path.join(this.skillsDirFor(scope), skill.name);
    const registry = this.registryFor(scope);
    const own = await inspectInstall(target, registry);
    if (own.exists && own.currentHash !== skill.artifactHash && !own.owned) {
      throw dsError("persistence", "adapter", `A skill named "${skill.name}" already exists at ${target} and was not installed by Dynamic Skills; refusing to overwrite it`, {
        recoverable: true,
        fallbackAction: "Ask the user for a different name or explicit approval to replace their skill.",
      });
    }
    if (!own.exists || own.currentHash !== skill.artifactHash) {
      await writeDirAtomic(target, skill.files, { overwrite: own.exists });
      if (hashSkillFiles(await readSkillDir(target)) !== skill.artifactHash) {
        throw dsError("persistence", "adapter", `Installed skill hash mismatch at ${target}`, { recoverable: true });
      }
    }
    await registry.upsert({
      name: skill.name,
      skillId: skill.skillId,
      artifactHash: skill.artifactHash,
      path: target,
      harness: this.id,
      scope,
      installedAt: own.entry?.artifactHash === skill.artifactHash ? own.entry.installedAt : isoNow(),
    });
  }

  /** Remove an installed skill. Ephemeral → session deactivation; persistent → only Dynamic Skills installs. */
  async removeSkill(skillId: string, scope: StorageScope): Promise<void> {
    if (scope === "ephemeral") {
      await this.sessionActivator().deactivate(skillId);
      return;
    }
    const name = skillNameFromId(skillId);
    assertSafeSkillName(name);
    const target = path.join(this.skillsDirFor(scope), name);
    const registry = this.registryFor(scope);
    const own = await inspectInstall(target, registry);
    if (!own.exists) {
      await registry.remove(target);
      return;
    }
    if (!own.owned) {
      throw dsError("persistence", "adapter", `Refusing to remove "${name}" at ${target}: it was not installed by Dynamic Skills (or was modified since)`, {
        recoverable: true,
        fallbackAction: "Leave the user's skill in place.",
      });
    }
    await rm(target, { recursive: true, force: true });
    await registry.remove(target);
  }
}
