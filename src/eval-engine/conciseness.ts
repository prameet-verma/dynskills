import type { EvalFinding, EvalResult, GeneratedSkill } from "../contracts/index.js";
import { estimateTokens } from "../core/index.js";
import type { EvalContext } from "./context.js";
import { SKILL_FILE, error, info, parsedSkill, runCheck, skillMd, warning } from "./context.js";

/** Generic advice that adds tokens without project value (§7.6). Matched case-insensitively. */
export const GENERIC_ADVICE_PHRASES: readonly string[] = [
  "write clean code",
  "follow best practices",
  "follow industry best practices",
  "ensure code quality",
  "use meaningful variable names",
  "write maintainable code",
  "keep code dry",
  "adhere to solid principles",
  "follow solid principles",
  "write readable code",
  "use descriptive names",
  "handle errors gracefully",
  "write good tests",
  "document your code",
];
export const DUPLICATE_LINE_MIN_LENGTH = 20;

function concisenessFindings(skill: GeneratedSkill, ctx: EvalContext): EvalFinding[] {
  const f: EvalFinding[] = [];
  const content = skillMd(skill) ?? "";
  const tokens = Math.max(estimateTokens(content), skill.tokenCount);
  const { maximumTokenCount: max, targetTokenCount: target } = ctx.policy;
  if (tokens > max) {
    f.push(error("skill_too_long", `SKILL.md is ~${tokens} tokens, above the maximum of ${max}; cut generic text or move detail into references/.`, SKILL_FILE));
  } else if (tokens > target) {
    f.push(warning("skill_over_target", `SKILL.md is ~${tokens} tokens, above the ${target}-token target; tighten it or use references/.`, SKILL_FILE));
  }

  const body = parsedSkill(skill)?.body ?? content;
  const counts = new Map<string, number>();
  for (const raw of body.split("\n")) {
    const line = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "").toLowerCase();
    if (line.length < DUPLICATE_LINE_MIN_LENGTH || line.startsWith("#")) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const dupes = [...counts].filter(([, n]) => n > 1).map(([l]) => l);
  if (dupes.length > 0) {
    f.push(warning("duplicate_lines", `${dupes.length} line(s) repeat within SKILL.md (e.g. "${dupes[0]?.slice(0, 60)}"); keep one copy.`, SKILL_FILE));
  }

  const lower = body.toLowerCase();
  const generic = GENERIC_ADVICE_PHRASES.filter((p) => lower.includes(p));
  if (generic.length > 0) {
    f.push(warning("generic_advice", `Remove generic advice that is not project-specific: ${generic.map((g) => `"${g}"`).join(", ")}.`, SKILL_FILE));
  }
  if (f.length === 0) f.push(info("tokens", `SKILL.md is ~${tokens} tokens (target ${target}, max ${max}).`));
  return f;
}

/** Mandatory: over the maximum token count fails; over target, repetition or generic advice warns. */
export function checkConciseness(skill: GeneratedSkill, ctx: EvalContext): EvalResult {
  return runCheck("conciseness", true, () => concisenessFindings(skill, ctx));
}
