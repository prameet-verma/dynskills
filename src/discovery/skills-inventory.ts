import { readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessId, SkillInventoryItem } from "../contracts/index.js";
import { readTextFileBounded } from "../core/index.js";
import { parseFrontmatter } from "./parsers.js";

const SKILL_MD_MAX_BYTES = 64 * 1024;

export const PROJECT_SKILL_DIRS: ReadonlyArray<{ dir: string; harness: HarnessId }> = [
  { dir: ".claude/skills", harness: "claude" },
  { dir: ".agents/skills", harness: "codex" },
  { dir: ".opencode/skills", harness: "opencode" },
];

export const PERSONAL_SKILL_DIRS: ReadonlyArray<{ dir: string; harness: HarnessId }> = [
  { dir: ".claude/skills", harness: "claude" },
  { dir: ".agents/skills", harness: "codex" },
  { dir: ".config/opencode/skills", harness: "opencode" },
];

/** Extract name/description from SKILL.md text. undefined when frontmatter is missing or malformed. */
export function readSkillMetadata(text: string, dirName: string): { name: string; description: string } | undefined {
  const fm = parseFrontmatter(text);
  if (!fm) return undefined;
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : dirName;
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  return { name, description };
}

async function scanSkillsDir(base: string, scope: SkillInventoryItem["scope"], harness: HarnessId): Promise<SkillInventoryItem[]> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  let realBase: string;
  try {
    realBase = await realpath(base);
  } catch {
    return [];
  }
  const out: SkillInventoryItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = path.join(base, entry.name);
    if (entry.isSymbolicLink()) {
      // Symlinked skill directories must stay inside the skills directory.
      const real = await realpath(dir).catch(() => undefined);
      const rel = real ? path.relative(realBase, real) : "..";
      if (!real || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    }
    // readTextFileBounded rejects traversal, symlink escapes and binaries relative to `base`.
    const r = await readTextFileBounded(base, `${entry.name}/SKILL.md`, SKILL_MD_MAX_BYTES).catch(() => undefined);
    if (!r || "skipped" in r) continue;
    const meta = readSkillMetadata(r.content, entry.name);
    if (!meta) continue;
    out.push({ name: meta.name, description: meta.description, path: dir, scope, harness });
  }
  return out;
}

/**
 * Inventory existing skills: project skills under `root` and personal skills under `homeDir`.
 * Malformed SKILL.md files are skipped; never throws for missing directories.
 */
export async function discoverExistingSkills(root: string, opts: { homeDir?: string } = {}): Promise<SkillInventoryItem[]> {
  const home = opts.homeDir ?? os.homedir();
  const absRoot = path.resolve(root);
  const jobs = [
    ...PROJECT_SKILL_DIRS.map(({ dir, harness }) => scanSkillsDir(path.join(absRoot, dir), "project", harness)),
    ...PERSONAL_SKILL_DIRS.map(({ dir, harness }) => scanSkillsDir(path.join(home, dir), "personal", harness)),
  ];
  const results = (await Promise.all(jobs)).flat();
  const scopeRank = { project: 0, personal: 1, plugin: 2, ephemeral: 3, unknown: 4 } as const;
  return results.sort(
    (a, b) =>
      scopeRank[a.scope] - scopeRank[b.scope] ||
      (a.harness ?? "").localeCompare(b.harness ?? "") ||
      a.name.localeCompare(b.name) ||
      a.path.localeCompare(b.path),
  );
}
