import path from "node:path";
import type { ActivationCapability } from "../../contracts/index.js";
import { BaseHarnessAdapter } from "../../adapter-sdk/index.js";

/**
 * Claude Code adapter (§9.3). Skills live in `.claude/skills/` (project) and `~/.claude/skills/`
 * (personal). Claude Code picks up skills added, edited or removed in watched skill directories
 * during a session; a top-level skills directory created mid-session may need `/reload-skills`.
 */
export class ClaudeCodeAdapter extends BaseHarnessAdapter {
  readonly id = "claude" as const;
  protected readonly binaryName = "claude";
  protected readonly activationCapabilities: readonly ActivationCapability[] = [
    "watched_directory",
    "current_turn_instruction_injection",
    "explicit_reload",
  ];

  protected projectSkillsRel(): string {
    return path.join(".claude", "skills");
  }

  protected personalSkillsRel(): string {
    return path.join(".claude", "skills");
  }

  invocationHint(name: string): string {
    return `The skill is invocable as /${name} or via the Skill tool (skill: "${name}"). Its instructions are also included in this result for the current turn.`;
  }

  reloadHint(name: string): string {
    return `The .claude/skills directory was created during this session; run /reload-skills so Claude Code lists "${name}". Do not restart the session.`;
  }
}
