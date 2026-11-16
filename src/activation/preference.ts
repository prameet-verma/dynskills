import { stat } from "node:fs/promises";
import path from "node:path";
import type { ActivationCapability, SkillFile } from "../contracts/index.js";
import { dsError, hashSkillFiles } from "../core/index.js";

/** §9.2 strongest-first activation order. */
export const ACTIVATION_PREFERENCE: ActivationCapability[] = [
  "live_skill_registration",
  "watched_directory",
  "current_turn_instruction_injection",
  "explicit_reload",
];

/** Pick the strongest available capability (§9.2); throws when none is available. */
export function selectActivationCapability(available: ActivationCapability[]): ActivationCapability {
  const chosen = ACTIVATION_PREFERENCE.find((c) => available.includes(c));
  if (!chosen) {
    throw dsError("activation", "activation", "The host exposes no supported activation capability", {
      recoverable: true,
      fallbackAction: "Return the artifact path and evaluation result to the root agent so it can read the skill manually.",
    });
  }
  return chosen;
}

/**
 * §9.4 artifact-level verification: the installed skill exists, has a SKILL.md, and its hash
 * matches the evaluated version. Host visibility is established by the adapter (watched directory
 * plus current-turn instruction injection), not by this check.
 */
export async function verifyActivation(input: {
  installedPath: string;
  expectedHash: string;
  readFiles: (dir: string) => Promise<SkillFile[]>;
}): Promise<{ ok: boolean; reason?: string }> {
  const st = await stat(input.installedPath).catch(() => undefined);
  if (!st?.isDirectory()) return { ok: false, reason: `Installed skill directory does not exist: ${input.installedPath}` };
  const md = await stat(path.join(input.installedPath, "SKILL.md")).catch(() => undefined);
  if (!md?.isFile()) return { ok: false, reason: `Installed skill has no SKILL.md: ${input.installedPath}` };
  let files: SkillFile[];
  try {
    files = await input.readFiles(input.installedPath);
  } catch (err) {
    return { ok: false, reason: `Cannot read installed skill: ${err instanceof Error ? err.message : String(err)}` };
  }
  const actual = hashSkillFiles(files);
  if (actual !== input.expectedHash) {
    return { ok: false, reason: `Installed artifact hash ${actual.slice(0, 12)} does not match evaluated hash ${input.expectedHash.slice(0, 12)}` };
  }
  return { ok: true };
}
