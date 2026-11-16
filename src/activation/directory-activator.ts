import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ActivationAdapter, ActivationCapability, ActivationResult, GeneratedSkill, HarnessId } from "../contracts/index.js";
import { errorMessage, hashSkillFiles, isoNow, writeDirAtomic } from "../core/index.js";
import { isValidSkillDirName, readSkillDir } from "../storage/index.js";
import { verifyActivation } from "./preference.js";
import { InstallRegistry, inspectInstall, skillNameFromId } from "./registry.js";

export interface DirectorySkillActivatorOptions {
  harness: HarnessId;
  /** Native, watched skills directory (e.g. `<project>/.claude/skills`). */
  skillsDir: string;
  capabilities: ActivationCapability[];
  /** Instruction for the root agent when the host must reload skills (e.g. "/reload-skills"). */
  reloadHint?: (name: string) => string;
  invocationHint: (name: string) => string;
  /** JSON file recording installs so deactivate/clean only remove what Dynamic Skills installed. */
  registryPath: string;
}

/**
 * §9 activation through a watched native skills directory, combined with current-turn
 * instruction injection: the full SKILL.md is returned so the running session provably
 * receives the skill even before (or without) the host's directory watcher picking it up.
 */
export class DirectorySkillActivator implements ActivationAdapter {
  readonly registry: InstallRegistry;

  constructor(private readonly opts: DirectorySkillActivatorOptions) {
    this.registry = new InstallRegistry(opts.registryPath);
  }

  async getCapabilities(): Promise<ActivationCapability[]> {
    return [...this.opts.capabilities];
  }

  private failure(skill: GeneratedSkill, message: string, installedPath?: string): ActivationResult {
    return {
      success: false,
      capability: "watched_directory",
      skillId: skill.skillId,
      artifactHash: skill.artifactHash,
      ...(installedPath ? { installedPath } : {}),
      message,
    };
  }

  async activate(skill: GeneratedSkill): Promise<ActivationResult> {
    if (!isValidSkillDirName(skill.name)) return this.failure(skill, `Invalid skill name: ${JSON.stringify(skill.name)}`);
    if (hashSkillFiles(skill.files) !== skill.artifactHash) {
      return this.failure(skill, "Skill files do not match the evaluated artifactHash; refusing to activate an unevaluated artifact.");
    }
    const skillMd = skill.files.find((f) => f.path === "SKILL.md");
    if (!skillMd) return this.failure(skill, "Skill has no SKILL.md.");

    const skillsDir = path.resolve(this.opts.skillsDir);
    const target = path.join(skillsDir, skill.name);
    const skillsDirExisted = (await stat(skillsDir).catch(() => undefined))?.isDirectory() ?? false;

    const own = await inspectInstall(target, this.registry);
    let wrote = false;
    if (own.exists && own.currentHash === skill.artifactHash) {
      // Identical artifact already installed (e.g. persisted earlier): nothing to write.
    } else if (own.exists) {
      if (!own.owned) {
        return this.failure(
          skill,
          `A skill named "${skill.name}" already exists at ${target} and was not installed by Dynamic Skills (or was modified since); refusing to overwrite it. Use a different skill name or ask the user.`,
          target,
        );
      }
      if (!own.registeredUnmodified || own.entry?.scope !== "ephemeral") {
        return this.failure(
          skill,
          `A persisted Dynamic Skills skill "${skill.name}" already exists at ${target}; replacing it requires explicit user approval (save the new version with the persistence flow).`,
          target,
        );
      }
    }
    if (!own.exists || own.currentHash !== skill.artifactHash) {
      try {
        await writeDirAtomic(target, skill.files, { overwrite: own.exists });
        wrote = true;
      } catch (err) {
        return this.failure(skill, `Failed to install skill: ${errorMessage(err)}`, target);
      }
    }

    const verified = await verifyActivation({ installedPath: target, expectedHash: skill.artifactHash, readFiles: readSkillDir });
    if (!verified.ok) {
      if (wrote && !own.exists) await rm(target, { recursive: true, force: true });
      return this.failure(skill, `Activation verification failed: ${verified.reason ?? "unknown reason"}`, target);
    }
    if (wrote) {
      await this.registry.upsert({
        name: skill.name,
        skillId: skill.skillId,
        artifactHash: skill.artifactHash,
        path: target,
        harness: this.opts.harness,
        scope: "ephemeral",
        installedAt: isoNow(),
      });
    }

    const requiresReload = !skillsDirExisted;
    const notes = [`Skill "${skill.name}" installed at ${target} and verified (hash ${skill.artifactHash.slice(0, 12)}).`];
    notes.push("Its full instructions are included in this result; apply them for the current task.");
    if (requiresReload) {
      notes.push(
        this.opts.reloadHint?.(skill.name) ??
          `The skills directory ${skillsDir} was created by this activation; the host may need a reload before it lists the skill.`,
      );
    }
    return {
      success: true,
      capability: "watched_directory",
      skillId: skill.skillId,
      artifactHash: skill.artifactHash,
      installedPath: target,
      instructions: skillMd.content,
      requiresReload,
      invocationHint: this.opts.invocationHint(skill.name),
      message: notes.join(" "),
    };
  }

  /** Remove ephemeral installs recorded for this skill id (or bare name). Never touches other directories. */
  async deactivate(skillId: string): Promise<void> {
    const name = skillNameFromId(skillId);
    const skillsDir = path.resolve(this.opts.skillsDir);
    const entries = (await this.registry.list()).filter(
      (e) => e.scope === "ephemeral" && e.harness === this.opts.harness && (e.skillId === skillId || e.name === name),
    );
    for (const entry of entries) {
      const dir = path.resolve(entry.path);
      if (path.dirname(dir) !== skillsDir) continue;
      const own = await inspectInstall(dir, this.registry);
      // Remove only if unmodified since we installed it; a user-edited copy is left in place.
      if (own.exists && own.registeredUnmodified) await rm(dir, { recursive: true, force: true });
      await this.registry.remove(dir);
    }
  }
}
