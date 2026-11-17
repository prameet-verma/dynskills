import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ActivationCapability, SkillFile } from "../../contracts/index.js";
import { BaseHarnessAdapter, NATIVE_PLUGIN_NAME, pluginSourceDir } from "../../adapter-sdk/index.js";
import { isValidSkillDirName } from "../../storage/index.js";

/**
 * OpenAI Codex adapter (§9.3). Skills live in `.agents/skills/` (project) and `~/.agents/skills/`
 * (personal). Codex detects skill changes automatically; restarting is the fallback when discovery
 * does not refresh. Never claim activation unless the session has actually received the skill —
 * the activation result therefore always carries the full instructions for current-turn injection.
 */
export class CodexAdapter extends BaseHarnessAdapter {
  readonly id = "codex" as const;
  protected readonly binaryName = "codex";
  protected readonly activationCapabilities: readonly ActivationCapability[] = [
    "watched_directory",
    "current_turn_instruction_injection",
    "explicit_reload",
  ];

  protected projectSkillsRel(): string {
    return path.join(".agents", "skills");
  }

  protected personalSkillsRel(): string {
    return path.join(".agents", "skills");
  }

  /**
   * Codex UI metadata (`agents/openai.yaml`: interface + policy) for skills shipped in the packaged
   * Codex plugin, i.e. the bootstrap. Read from `plugins/codex` so the plugin and the plain-skill
   * install share one source. Generated skills get no extras (§10.5: identical across harnesses).
   */
  override async harnessExtraFiles(skillName: string): Promise<SkillFile[]> {
    if (!isValidSkillDirName(skillName)) return [];
    const file = path.join(pluginSourceDir("codex"), NATIVE_PLUGIN_NAME, "skills", skillName, "agents", "openai.yaml");
    const content = await readFile(file, "utf8").catch(() => undefined);
    return content === undefined ? [] : [{ path: "agents/openai.yaml", content }];
  }

  invocationHint(name: string): string {
    return `Apply the "${name}" instructions included in this result now (or invoke it through Codex's native skill mechanism once it is listed). Never claim activation if the session has not received the skill — rely on the injected instructions.`;
  }

  reloadHint(name: string): string {
    return `Codex normally detects new skills automatically; if "${name}" is not listed, restart Codex as a fallback. The injected instructions apply to the current turn either way.`;
  }
}
