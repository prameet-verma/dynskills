import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessAdapter, SkillFile } from "../contracts/index.js";
import { dsError, hashSkillFiles, writeDirAtomic, writeFileAtomic } from "../core/index.js";
import { hasDynamicSkillsMarker, isValidSkillDirName, parseSkillMd, readSkillDir } from "../storage/index.js";

export type BootstrapInstallStatus = "created" | "updated" | "unchanged" | "conflict";

/**
 * Relative paths of harness-specific extra files (Codex `agents/openai.yaml`). They are never part
 * of the canonical bootstrap and are excluded from the canonical hash comparison, so the canonical
 * part of an installed bootstrap always hashes to the packaged source hash.
 */
export const HARNESS_EXTRA_FILE_PATHS: readonly string[] = ["agents/openai.yaml"];

/**
 * §13 install the bootstrap skill into a harness skills directory. An existing copy is replaced
 * only when it carries Dynamic Skills metadata (i.e. an earlier bootstrap) or `force` is set;
 * otherwise the result is "conflict" and nothing is written.
 *
 * `harnessExtras: true` also writes the adapter's harness-specific extra files (e.g. Codex
 * `agents/openai.yaml`) beside the canonical files. Extras are compared separately: an install whose
 * canonical files match the source but lacks requested extras is "updated" by writing only the extras.
 */
export async function installBootstrap(input: {
  adapter: HarnessAdapter & {
    skillsDirFor(scope: "project" | "personal"): string;
    harnessExtraFiles?(skillName: string): Promise<SkillFile[]>;
  };
  scope: "project" | "personal";
  sourceDir: string;
  force?: boolean;
  harnessExtras?: boolean;
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
  const sourcePaths = new Set(files.map((f) => f.path));
  const excluded = new Set(HARNESS_EXTRA_FILE_PATHS.filter((p) => !sourcePaths.has(p)));
  const extras =
    input.harnessExtras && input.adapter.harnessExtraFiles
      ? (await input.adapter.harnessExtraFiles(name)).filter((f) => !sourcePaths.has(f.path))
      : [];

  const target = path.join(input.adapter.skillsDirFor(input.scope), name);
  const sourceHash = hashSkillFiles(files);
  const current = await readSkillDir(target).catch(() => undefined);
  if (current === undefined) {
    await writeDirAtomic(target, [...files, ...extras]);
    return { path: target, status: "created" };
  }
  const canonicalHash = hashSkillFiles(current.filter((f) => !excluded.has(f.path)));
  if (canonicalHash === sourceHash) {
    const missing = extras.filter((e) => current.find((c) => c.path === e.path)?.content !== e.content);
    if (missing.length === 0) return { path: target, status: "unchanged" };
    for (const e of missing) await writeFileAtomic(path.join(target, ...e.path.split("/")), e.content);
    return { path: target, status: "updated" };
  }
  const existingMd = await readFile(path.join(target, "SKILL.md"), "utf8").catch(() => "");
  if (!input.force && !hasDynamicSkillsMarker(existingMd)) return { path: target, status: "conflict" };
  await writeDirAtomic(target, [...files, ...extras], { overwrite: true });
  return { path: target, status: "updated" };
}
