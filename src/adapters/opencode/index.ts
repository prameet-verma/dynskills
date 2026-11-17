import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ActivationCapability, ActivationResult, GeneratedSkill, HostCapabilities, StorageScope } from "../../contracts/index.js";
import { errorMessage } from "../../core/index.js";
import { BaseHarnessAdapter, OPENCODE_PLUGIN_FILE, OPENCODE_PLUGIN_MARKER, opencodePluginsDir } from "../../adapter-sdk/index.js";
import { LiveSkillsFile, liveSkillEntryFrom, skillNameFromId } from "../../activation/index.js";

/**
 * OpenCode adapter (§9.3). Skills live in `.opencode/skills/` (project) and
 * `~/.config/opencode/skills/` (personal), loaded through OpenCode's native skill tool.
 *
 * Live registration: every session activation is also written to
 * `<project>/.dynamic-skills-runtime/live-skills/opencode.json`. The Dynamic Skills OpenCode plugin
 * (`plugins/opencode/dynamic-skills.js`, installed into `.opencode/plugins/` or
 * `~/.config/opencode/plugins/`) watches that file, adds the skills to OpenCode's registry with
 * `ctx.skill.transform` and calls `ctx.skill.reload()`. When the plugin file is installed, the
 * adapter advertises "live_skill_registration" first. It cannot observe whether the running
 * OpenCode process actually loaded the plugin, so activation still returns the full instructions
 * for current-turn injection and never claims more than that.
 */
export class OpenCodeAdapter extends BaseHarnessAdapter {
  readonly id = "opencode" as const;
  protected readonly binaryName = "opencode";
  protected readonly activationCapabilities: readonly ActivationCapability[] = ["watched_directory", "current_turn_instruction_injection"];

  protected projectSkillsRel(): string {
    return path.join(".opencode", "skills");
  }

  protected personalSkillsRel(): string {
    return path.join(".config", "opencode", "skills");
  }

  invocationHint(name: string): string {
    return `Load "${name}" with OpenCode's native skill tool once it is listed; its instructions are included in this result for the current turn.`;
  }

  reloadHint(name: string): string | undefined {
    return `The .opencode/skills directory was created during this session; if "${name}" is not listed by the skill tool, restart OpenCode. The injected instructions apply to the current turn either way.`;
  }

  /** Candidate locations of the Dynamic Skills OpenCode plugin (project first, then personal). */
  livePluginPaths(): string[] {
    const opts = { projectRoot: this.projectRoot, homeDir: this.homeDir };
    return [path.join(opencodePluginsDir("project", opts), OPENCODE_PLUGIN_FILE), path.join(opencodePluginsDir("personal", opts), OPENCODE_PLUGIN_FILE)];
  }

  /** Path of the installed Dynamic Skills OpenCode plugin (a file carrying its marker), if any. */
  async livePluginPath(): Promise<string | undefined> {
    for (const p of this.livePluginPaths()) {
      const content = await readFile(p, "utf8").catch(() => undefined);
      if (content?.includes(OPENCODE_PLUGIN_MARKER)) return p;
    }
    return undefined;
  }

  /** The live-skill file the plugin watches. */
  liveSkillsFile(): LiveSkillsFile {
    return LiveSkillsFile.for(this.projectRoot, this.id);
  }

  /** Adds "live_skill_registration" (strongest, §9.2) when the plugin file is installed. Checked on every call. */
  override async getCapabilities(): Promise<HostCapabilities> {
    const base = await super.getCapabilities();
    if (!(await this.livePluginPath())) return base;
    return {
      ...base,
      pluginIntegration: true,
      activation: ["live_skill_registration", ...base.activation.filter((c) => c !== "live_skill_registration")],
    };
  }

  override async loadSkillForSession(skill: GeneratedSkill): Promise<ActivationResult> {
    const result = await super.loadSkillForSession(skill);
    if (!result.success || !result.installedPath) return result;
    const skillMd = skill.files.find((f) => f.path === "SKILL.md");
    const entry = skillMd
      ? liveSkillEntryFrom({ name: skill.name, skillId: skill.skillId, artifactHash: skill.artifactHash, skillMd: skillMd.content, installedPath: result.installedPath })
      : undefined;
    if (!entry) return result;
    try {
      await this.liveSkillsFile().upsert(entry);
    } catch (err) {
      return { ...result, message: `${result.message ?? ""} Live registration was skipped: ${errorMessage(err)}`.trim() };
    }
    const plugin = await this.livePluginPath();
    if (!plugin) return result;
    return {
      ...result,
      capability: "live_skill_registration",
      // The plugin registers the skill by absolute path, so a skills directory created mid-session
      // does not need a restart when the plugin is loaded.
      requiresReload: false,
      message: [
        `Skill "${skill.name}" installed at ${result.installedPath} and verified (hash ${skill.artifactHash.slice(0, 12)}).`,
        `It was added to ${this.liveSkillsFile().file}; the Dynamic Skills OpenCode plugin (${plugin}) registers it with OpenCode's skill registry and reloads skills when that file changes, if the plugin is loaded in this session.`,
        "Its full instructions are included in this result; apply them for the current task.",
        "If the plugin was installed after this OpenCode session started, it is not loaded yet: restart OpenCode to use live registration.",
      ].join(" "),
    };
  }

  /** Also drops the live registration (for persistent scopes, only entries pointing into that scope's directory). */
  override async removeSkill(skillId: string, scope: StorageScope): Promise<void> {
    await super.removeSkill(skillId, scope);
    const name = skillNameFromId(skillId);
    if (scope === "ephemeral") {
      await this.liveSkillsFile().remove(name);
      return;
    }
    const dir = path.join(this.skillsDirFor(scope), name);
    await this.liveSkillsFile().remove(name, (e) => path.dirname(path.resolve(e.path)) === dir);
  }
}
