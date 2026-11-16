import path from "node:path";
import type { EvalFinding, EvalResult, GeneratedSkill } from "../contracts/index.js";
import { METADATA_NAMESPACE } from "../core/index.js";
import { METADATA_KEYS, SKILL_NAME_MAX_LENGTH, SKILL_NAME_PATTERN, relativeLinks } from "../skill-compiler/index.js";
import type { EvalContext } from "./context.js";
import { SKILL_FILE, error, parsedSkill, runCheck, warning } from "./context.js";

/** Standard Agent Skills frontmatter keys. Anything else fails the structural check. */
export const STANDARD_FRONTMATTER_KEYS: ReadonlySet<string> = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;

/** Finding codes a re-render / applyDeterministicFixes can resolve without an LLM. */
export const STRUCTURAL_FIXABLE_CODES: ReadonlySet<string> = new Set([
  "name_invalid",
  "name_too_long",
  "description_too_long",
  "frontmatter_unknown_key",
  "metadata_not_string",
  "metadata_invalid",
  "frontmatter_missing",
  "frontmatter_invalid",
  "skill_name_mismatch",
]);

function structuralFindings(skill: GeneratedSkill, ctx: EvalContext): EvalFinding[] {
  const f: EvalFinding[] = [];
  const parsed = parsedSkill(skill);
  if (parsed === undefined) return [error("skill_md_missing", "The skill has no SKILL.md file at its root; add one.", SKILL_FILE)];
  if (parsed.error !== undefined || parsed.frontmatter === undefined) {
    const code = parsed.errorKind === "invalid_yaml" || parsed.errorKind === "not_mapping" ? "frontmatter_invalid" : "frontmatter_missing";
    f.push(error(code, `${parsed.error ?? "Frontmatter is missing."} Start SKILL.md with '---', YAML name/description, then '---'.`, SKILL_FILE));
  } else {
    const fm = parsed.frontmatter;
    const name = fm.name;
    if (typeof name !== "string" || name.length === 0) {
      f.push(error("name_missing", "Frontmatter `name` is required and must be a non-empty string.", SKILL_FILE));
    } else {
      if (name.length > SKILL_NAME_MAX_LENGTH) f.push(error("name_too_long", `Skill name is ${name.length} characters; the maximum is ${SKILL_NAME_MAX_LENGTH}.`, SKILL_FILE));
      if (!SKILL_NAME_PATTERN.test(name)) {
        f.push(error("name_invalid", `Skill name "${name}" must be lowercase a-z, 0-9 and single hyphens, without leading or trailing hyphens.`, SKILL_FILE));
      }
      const dir = ctx.expectedDirName ?? skill.name;
      if (name !== dir) f.push(error("name_dir_mismatch", `Skill name "${name}" must equal its directory name "${dir}".`, SKILL_FILE));
      if (name !== skill.name) f.push(error("skill_name_mismatch", `Frontmatter name "${name}" differs from the artifact name "${skill.name}".`, SKILL_FILE));
    }
    const description = fm.description;
    if (typeof description !== "string" || description.trim().length === 0) {
      f.push(error("description_missing", "Frontmatter `description` is required: say what the skill does and when to use it.", SKILL_FILE));
    } else if (description.length > DESCRIPTION_MAX) {
      f.push(error("description_too_long", `Description is ${description.length} characters; the maximum is ${DESCRIPTION_MAX}.`, SKILL_FILE));
    }
    for (const key of Object.keys(fm)) {
      if (!STANDARD_FRONTMATTER_KEYS.has(key)) {
        f.push(error("frontmatter_unknown_key", `Frontmatter key "${key}" is not part of the Agent Skills specification; remove it or move it under metadata.`, SKILL_FILE));
      }
    }
    if (fm.compatibility !== undefined && (typeof fm.compatibility !== "string" || fm.compatibility.length > COMPATIBILITY_MAX)) {
      f.push(error("compatibility_invalid", `\`compatibility\` must be a string of at most ${COMPATIBILITY_MAX} characters.`, SKILL_FILE));
    }
    if (fm.license !== undefined && typeof fm.license !== "string") f.push(error("license_invalid", "`license` must be a string.", SKILL_FILE));
    const metadata = fm.metadata;
    if (metadata === undefined) {
      f.push(warning("metadata_missing", `Frontmatter has no metadata; provenance keys (${METADATA_NAMESPACE}.*) are missing.`, SKILL_FILE));
    } else if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      f.push(error("metadata_invalid", "`metadata` must be a mapping of string keys to string values.", SKILL_FILE));
    } else {
      const md = metadata as Record<string, unknown>;
      for (const [k, v] of Object.entries(md)) {
        if (typeof v !== "string") f.push(error("metadata_not_string", `metadata.${k} must be a string (got ${v === null ? "null" : typeof v}).`, SKILL_FILE));
      }
      const missing = Object.values(METADATA_KEYS).filter((k) => !(k in md));
      if (missing.length > 0) f.push(warning("metadata_missing", `Provenance metadata is missing: ${missing.join(", ")}.`, SKILL_FILE));
    }
    if (parsed.body.trim().length === 0) f.push(error("body_empty", "SKILL.md has no instructions after the frontmatter.", SKILL_FILE));
  }

  // File layout and links.
  const paths = new Set(skill.files.map((x) => x.path));
  for (const file of skill.files) {
    const p = file.path;
    if (p === SKILL_FILE || p.startsWith("scripts/")) continue; // scripts/ is the security check's concern
    if (!/^(references|assets)\/[^/]/.test(p)) {
      f.push(error("unexpected_file", `File "${p}" is outside the allowed layout (SKILL.md, references/, assets/).`, p));
    }
  }
  const linked = new Set<string>();
  for (const file of skill.files) {
    if (!file.path.endsWith(".md")) continue;
    const baseDir = path.posix.dirname(file.path);
    for (const target of relativeLinks(file.content)) {
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        // keep raw target
      }
      if (decoded.startsWith("/")) {
        f.push(error("link_absolute", `Link "${target}" in ${file.path} must be relative to the skill directory.`, file.path));
        continue;
      }
      const resolved = path.posix.normalize(path.posix.join(baseDir, decoded));
      if (resolved.startsWith("../") || resolved === "..") {
        f.push(error("link_outside_skill", `Link "${target}" in ${file.path} points outside the skill directory.`, file.path));
        continue;
      }
      linked.add(resolved);
      if (!paths.has(resolved)) f.push(error("broken_reference", `Link "${target}" in ${file.path} does not resolve to a file in the skill; add the file or remove the link.`, file.path));
    }
  }
  for (const p of paths) {
    if (p.startsWith("references/") && !linked.has(p)) {
      f.push(warning("unreferenced_file", `Reference file "${p}" is not linked from SKILL.md; link it or remove it.`, p));
    }
  }
  return f;
}

/** Mandatory: frontmatter, name/description rules, layout, and link resolution. */
export function checkStructural(skill: GeneratedSkill, ctx: EvalContext): EvalResult {
  return runCheck("structural", true, () => structuralFindings(skill, ctx));
}
