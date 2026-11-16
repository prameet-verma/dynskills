import { parse as parseYaml } from "yaml";
import { METADATA_NAMESPACE } from "../core/index.js";
import { dsError } from "../core/index.js";

/** Agent Skills name rule: lowercase kebab-case, at most 64 characters (§7.5). */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillDirName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && SKILL_NAME_RE.test(name);
}

/**
 * Skill names become directory names; reject anything that is not a plain kebab-case segment
 * so a name can never traverse outside its parent directory (§16.1).
 */
export function assertSafeSkillName(name: string): void {
  if (!isValidSkillDirName(name)) {
    throw dsError("security", "storage", `Invalid skill name (expected lowercase kebab-case, ≤ 64 chars): ${JSON.stringify(name)}`, {
      recoverable: true,
      fallbackAction: "Rename the skill to a lowercase kebab-case identifier.",
    });
  }
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Split a SKILL.md into frontmatter (parsed YAML) and body. Returns undefined when malformed. */
export function parseSkillMd(content: string): { frontmatter: SkillFrontmatter; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(content.replace(/^\uFEFF/, ""));
  if (!m) return undefined;
  let data: unknown;
  try {
    data = parseYaml(m[1] ?? "");
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const fm = data as Record<string, unknown>;
  if (typeof fm.name !== "string" || fm.name.trim() === "") return undefined;
  if (typeof fm.description !== "string" || fm.description.trim() === "") return undefined;
  return { frontmatter: fm as SkillFrontmatter, body: m[2] ?? "" };
}

/**
 * True when SKILL.md frontmatter carries Dynamic Skills provenance metadata, i.e. a `metadata`
 * key that starts with the `dynamic-skills` namespace (e.g. `dynamic-skills.generator`), or a
 * nested `metadata.dynamic-skills` object.
 */
export function hasDynamicSkillsMarker(skillMdContent: string): boolean {
  const parsed = parseSkillMd(skillMdContent);
  const meta = parsed?.frontmatter.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  return Object.keys(meta).some((k) => k === METADATA_NAMESPACE || k.startsWith(`${METADATA_NAMESPACE}.`) || k.startsWith(`${METADATA_NAMESPACE}-`) || k.startsWith(`${METADATA_NAMESPACE}/`));
}
