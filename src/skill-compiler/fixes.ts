import type { SkillDraft } from "../contracts/index.js";
import { isValidSkillName, safeReferenceFileName, toSkillName, uniqueSkillName } from "./name.js";
import { collapseWhitespace, truncateAtWord } from "./text.js";

export const DESCRIPTION_MAX_LENGTH = 1024;

function cleanItem(item: string): string {
  return collapseWhitespace(item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
}

function cleanList(items: readonly string[] | undefined, label: string, fixes: string[]): string[] {
  const src = items ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of src) {
    const item = cleanItem(raw);
    const key = item.toLowerCase();
    if (item.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  if (out.length !== src.length) fixes.push(`Removed ${src.length - out.length} empty or duplicate item(s) from ${label}.`);
  return out;
}

/**
 * §8.6 deterministic fixes for structural issues. Pure: returns a new draft and a list of
 * human-readable descriptions of what was changed.
 */
export function applyDeterministicFixes(draft: SkillDraft, opts: { existingNames: string[] }): { draft: SkillDraft; fixes: string[] } {
  const fixes: string[] = [];
  const d: SkillDraft = structuredClone(draft);

  // Name: normalise, then avoid collisions with existing skills.
  let name = d.name.trim();
  if (!isValidSkillName(name)) {
    const normalized = toSkillName(name);
    fixes.push(`Normalised skill name "${d.name}" to "${normalized}".`);
    name = normalized;
  }
  const unique = uniqueSkillName(name, opts.existingNames);
  if (unique !== name) {
    fixes.push(`Renamed skill "${name}" to "${unique}" to avoid colliding with an existing skill.`);
    name = unique;
  }
  d.name = name;

  // Description: single line, ≤ 1024 chars at a word boundary.
  const description = collapseWhitespace(d.description);
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    d.description = truncateAtWord(description, DESCRIPTION_MAX_LENGTH);
    fixes.push(`Truncated description from ${description.length} to ${d.description.length} characters.`);
  } else {
    d.description = description;
  }

  d.specialist = {
    identity: collapseWhitespace(d.specialist.identity),
    responsibility: collapseWhitespace(d.specialist.responsibility),
  };
  d.authority = {
    ownership: cleanList(d.authority.ownership, "authority.ownership", fixes),
    decisionRights: cleanList(d.authority.decisionRights, "authority.decisionRights", fixes),
    boundaries: cleanList(d.authority.boundaries, "authority.boundaries", fixes),
    accountability: cleanList(d.authority.accountability, "authority.accountability", fixes),
  };
  d.workflow = cleanList(d.workflow, "workflow", fixes);
  d.verification = cleanList(d.verification, "verification", fixes);

  // Constraints: trim, drop empty statements, merge duplicates (union of evidence).
  const byKey = new Map<string, { statement: string; evidence: string[] }>();
  for (const c of d.projectConstraints) {
    const statement = cleanItem(c.statement);
    if (statement.length === 0) continue;
    const evidence = c.evidence.map((e) => e.trim()).filter((e) => e.length > 0);
    const key = statement.toLowerCase();
    const prev = byKey.get(key);
    if (prev) prev.evidence.push(...evidence);
    else byKey.set(key, { statement, evidence });
  }
  const constraints = [...byKey.values()].map((c) => ({ statement: c.statement, evidence: [...new Set(c.evidence)] }));
  if (constraints.length !== d.projectConstraints.length) {
    fixes.push(`Removed ${d.projectConstraints.length - constraints.length} empty or duplicate project constraint(s).`);
  }
  d.projectConstraints = constraints;

  if (d.assumptions !== undefined) {
    const assumptions = cleanList(d.assumptions, "assumptions", fixes);
    if (assumptions.length > 0) d.assumptions = assumptions;
    else delete d.assumptions;
  }

  if (d.references !== undefined) {
    const seen = new Set<string>();
    const refs: NonNullable<SkillDraft["references"]> = [];
    for (const r of d.references) {
      const fileName = safeReferenceFileName(r.fileName);
      if (r.content.trim().length === 0 || seen.has(fileName)) {
        fixes.push(`Dropped empty or duplicate reference "${r.fileName}".`);
        continue;
      }
      if (fileName !== r.fileName) fixes.push(`Renamed reference "${r.fileName}" to "${fileName}".`);
      seen.add(fileName);
      refs.push({ fileName, title: collapseWhitespace(r.title) || fileName, content: r.content });
    }
    if (refs.length > 0) d.references = refs;
    else delete d.references;
  }

  return { draft: d, fixes };
}
