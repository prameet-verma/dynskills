import type { EvalFinding, EvalResult, GeneratedSkill } from "../contracts/index.js";
import { jaccard, keywordSet } from "../skill-compiler/index.js";
import type { EvalContext } from "./context.js";
import { SKILL_FILE, error, parsedSkill, runCheck, skillMd, warning } from "./context.js";

export const DESCRIPTION_SIMILARITY_WARN = 0.8;
export const COPIED_LINE_MIN_LENGTH = 40;
export const COPIED_LINES_WARN = 3;

function normLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*+>]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function duplicationFindings(skill: GeneratedSkill, ctx: EvalContext): EvalFinding[] {
  const f: EvalFinding[] = [];
  const name = skill.name.toLowerCase();
  for (const s of ctx.existingSkills) {
    if (s.name.toLowerCase() === name) {
      f.push(error("name_collision", `Skill name "${skill.name}" collides with existing ${s.scope} skill at ${s.path}; choose a distinct name.`, SKILL_FILE));
    }
  }
  const desc = keywordSet(skill.description);
  for (const s of ctx.existingSkills) {
    const sim = jaccard(desc, keywordSet(s.description));
    if (sim >= DESCRIPTION_SIMILARITY_WARN) {
      f.push(
        warning(
          "duplicate_existing_skill",
          `Description is ${Math.round(sim * 100)}% similar to existing skill "${s.name}"; reuse it or narrow this skill to what it lacks.`,
          SKILL_FILE,
        ),
      );
    }
  }

  const instructionLines = new Set<string>();
  for (const doc of ctx.repositoryInstructions) {
    for (const line of doc.split(/\r?\n/)) {
      const n = normLine(line);
      if (n.length >= COPIED_LINE_MIN_LENGTH) instructionLines.add(n);
    }
  }
  if (instructionLines.size > 0) {
    const body = parsedSkill(skill)?.body ?? skillMd(skill) ?? "";
    const copied = [...new Set(body.split("\n").map(normLine))].filter((l) => l.length >= COPIED_LINE_MIN_LENGTH && instructionLines.has(l));
    if (copied.length >= COPIED_LINES_WARN) {
      f.push(
        warning(
          "repeats_repository_instructions",
          `${copied.length} lines are copied verbatim from repository instructions the agent already loads; remove them (e.g. "${copied[0]?.slice(0, 60)}").`,
          SKILL_FILE,
        ),
      );
    }
  }
  return f;
}

/** Mandatory: name collisions fail; near-duplicate descriptions and copied instructions warn. */
export function checkDuplication(skill: GeneratedSkill, ctx: EvalContext): EvalResult {
  return runCheck("duplication", true, () => duplicationFindings(skill, ctx));
}
