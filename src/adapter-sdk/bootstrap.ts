import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessAdapter } from "../contracts/index.js";
import { dsError, hashSkillFiles, writeDirAtomic } from "../core/index.js";
import { hashSkillDir, hasDynamicSkillsMarker, isValidSkillDirName, parseSkillMd, readSkillDir } from "../storage/index.js";

export type BootstrapInstallStatus = "created" | "updated" | "unchanged" | "conflict";

/**
 * §13 install the bootstrap skill into a harness skills directory. An existing copy is replaced
 * only when it carries Dynamic Skills metadata (i.e. an earlier bootstrap) or `force` is set;
 * otherwise the result is "conflict" and nothing is written.
 */
export async function installBootstrap(input: {
  adapter: HarnessAdapter & { skillsDirFor(scope: "project" | "personal"): string };
  scope: "project" | "personal";
  sourceDir: string;
  force?: boolean;
}): Promise<{ path: string; status: BootstrapInstallStatus }> {
  const files = await readSkillDir(input.sourceDir).catch(() => []);
  const skillMd = files.find((f) => f.path === "SKILL.md");
  const parsed = skillMd ? parseSkillMd(skillMd.content) : undefined;
  if (!skillMd || !parsed) {
    throw dsError("configuration", "adapter", `Bootstrap source has no valid SKILL.md: ${input.sourceDir}`, {
      recoverable: false,
      fallbackAction: "Reinstall Dynamic Skills; the packaged bootstrap skill is missing or malformed.",
    });
  }
  const name = parsed.frontmatter.name;
  if (!isValidSkillDirName(name)) {
    throw dsError("configuration", "adapter", `Bootstrap skill name is not a valid skill directory name: ${name}`, { recoverable: false });
  }
  const target = path.join(input.adapter.skillsDirFor(input.scope), name);
  const sourceHash = hashSkillFiles(files);
  const currentHash = await hashSkillDir(target).catch(() => undefined);
  if (currentHash === undefined) {
    await writeDirAtomic(target, files);
    return { path: target, status: "created" };
  }
  if (currentHash === sourceHash) return { path: target, status: "unchanged" };
  const existingMd = await readFile(path.join(target, "SKILL.md"), "utf8").catch(() => "");
  if (!input.force && !hasDynamicSkillsMarker(existingMd)) return { path: target, status: "conflict" };
  await writeDirAtomic(target, files, { overwrite: true });
  return { path: target, status: "updated" };
}
