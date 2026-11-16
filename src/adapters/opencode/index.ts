import path from "node:path";
import type { ActivationCapability } from "../../contracts/index.js";
import { BaseHarnessAdapter } from "../../adapter-sdk/index.js";

/**
 * OpenCode adapter (§9.3). Skills live in `.opencode/skills/` (project) and
 * `~/.config/opencode/skills/` (personal), loaded through OpenCode's native skill tool.
 *
 * TODO(opencode-live-registry): §9.3 describes an OpenCode plugin API for listing/transforming the
 * skill registry (add/remove definitions, reload). Live registry registration must be implemented
 * against a pinned, verified OpenCode version before advertising "live_skill_registration". Until
 * then this adapter relies on directory discovery plus current-turn instruction injection.
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
}
