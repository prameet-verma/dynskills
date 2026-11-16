import type { EvalFinding, EvalResult, GeneratedSkill } from "../contracts/index.js";
import { SECTION, bulletItems, hasSection, normalizeRefPath, parseEvidenceRefs, sectionLines } from "../skill-compiler/index.js";
import type { EvalContext } from "./context.js";
import { SKILL_FILE, error, parsedSkill, runCheck, warning } from "./context.js";

function classifyRef(ref: string, ctx: EvalContext): EvalFinding | undefined {
  if (ctx.knownEvidenceIds.has(ref) || ctx.assumptionIds.has(ref) || ctx.knownPaths.has(normalizeRefPath(ref))) return undefined;
  if (ref.startsWith("ev_")) {
    return error("unknown_evidence_id", `Evidence id "${ref}" is not in the context packet; cite an existing evidence id or remove the constraint.`, SKILL_FILE);
  }
  if (ref.startsWith("asm_")) {
    return error("unsupported_assumption", `Assumption "${ref}" is not a registered assumption; cite a recorded assumption or remove the constraint.`, SKILL_FILE);
  }
  return error("unknown_evidence_path", `Evidence path "${ref}" was not part of the discovered context; cite a known path or evidence id.`, SKILL_FILE);
}

function groundingFindings(skill: GeneratedSkill, ctx: EvalContext): EvalFinding[] {
  const f: EvalFinding[] = [];
  const parsed = parsedSkill(skill);
  if (parsed === undefined) return [error("skill_md_missing", "SKILL.md is missing; grounding cannot be verified.", SKILL_FILE)];
  const body = parsed.body;

  if (!hasSection(body, SECTION.projectConstraints)) {
    f.push(warning("no_project_constraints", "The skill has no grounded project constraints; it may be generic rather than project-specific.", SKILL_FILE));
  }
  for (const item of bulletItems(sectionLines(body, SECTION.projectConstraints))) {
    const refs = parseEvidenceRefs(item);
    if (refs === undefined || refs.length === 0) {
      f.push(error("constraint_ungrounded", `Project constraint "${item.slice(0, 80)}" cites no evidence; add evidence ids/paths/assumption ids or remove it.`, SKILL_FILE));
      continue;
    }
    for (const ref of refs) {
      const finding = classifyRef(ref, ctx);
      if (finding) f.push(finding);
    }
  }

  for (const item of bulletItems(sectionLines(body, SECTION.assumptions))) {
    const id = /^`([^`]+)`/.exec(item)?.[1] ?? item.split(/[:\s]/)[0] ?? "";
    if (!ctx.assumptionIds.has(id)) {
      f.push(error("unsupported_assumption", `Assumption "${id}" listed in SKILL.md is not a registered assumption; remove it or record it first.`, SKILL_FILE));
    }
  }

  for (const id of skill.provenance.evidenceIds) {
    if (!ctx.knownEvidenceIds.has(id)) f.push(error("unknown_evidence_id", `Provenance evidence id "${id}" is not in the context packet.`));
  }
  for (const id of skill.provenance.assumptionIds) {
    if (!ctx.assumptionIds.has(id)) f.push(error("unsupported_assumption", `Provenance assumption id "${id}" is not a registered assumption.`));
  }
  return dedupe(f);
}

function dedupe(findings: EvalFinding[]): EvalFinding[] {
  const seen = new Set<string>();
  return findings.filter((x) => {
    const k = `${x.code}|${x.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Mandatory when policy.requireEvidence: every project constraint cites known evidence ids,
 * paths or assumption ids. When evidence is not required, errors are downgraded to warnings.
 */
export function checkGrounding(skill: GeneratedSkill, ctx: EvalContext): EvalResult {
  const required = ctx.policy.requireEvidence;
  return runCheck("grounding", required, () => {
    const findings = groundingFindings(skill, ctx);
    return required ? findings : findings.map((x) => (x.severity === "error" ? { ...x, severity: "warning" as const } : x));
  });
}
