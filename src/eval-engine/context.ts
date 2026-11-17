import type {
  CompilationPolicy,
  ContextAnalysisResult,
  EvalFinding,
  EvalResult,
  GeneratedSkill,
  SkillInventoryItem,
  TaskIntent,
} from "../contracts/index.js";
import { stopwatch } from "../core/index.js";
import { parseSkillMarkdown } from "../skill-compiler/index.js";
import type { ParsedSkillMarkdown } from "../skill-compiler/index.js";

export interface EvalContext {
  task: TaskIntent;
  analysis: ContextAnalysisResult;
  knownEvidenceIds: ReadonlySet<string>;
  knownPaths: ReadonlySet<string>;
  assumptionIds: ReadonlySet<string>;
  existingSkills: SkillInventoryItem[];
  /** Instruction file contents (AGENTS.md, CLAUDE.md, …). */
  repositoryInstructions: string[];
  policy: CompilationPolicy;
  /** Directory the skill will be installed under; defaults to the skill's own name. */
  expectedDirName?: string;
  /** Discovery evidence claims (e.g. "Uses vitest 2.0.5"), so the scope check recognises discovered dependencies. */
  evidenceClaims?: string[];
  /** Scripts in the root package.json; undefined when there is none. Commands that run a missing script fail grounding. */
  packageScripts?: Readonly<Record<string, string>>;
}

export type GenerationCheck = (skill: GeneratedSkill, ctx: EvalContext) => EvalResult;

export const SKILL_FILE = "SKILL.md";

export function skillMd(skill: GeneratedSkill): string | undefined {
  return skill.files.find((f) => f.path === SKILL_FILE)?.content;
}

export function parsedSkill(skill: GeneratedSkill): ParsedSkillMarkdown | undefined {
  const content = skillMd(skill);
  return content === undefined ? undefined : parseSkillMarkdown(content);
}

/** Status from findings: any error → fail, any warning → warning, else pass. */
export function buildResult(checkId: string, mandatory: boolean, findings: EvalFinding[], durationMs: number): EvalResult {
  const status = findings.some((f) => f.severity === "error") ? "fail" : findings.some((f) => f.severity === "warning") ? "warning" : "pass";
  return { checkId, status, mandatory, findings, durationMs };
}

/** Run a finding producer with timing and wrap it as an EvalResult. Exceptions become a failing finding. */
export function runCheck(checkId: string, mandatory: boolean, fn: () => EvalFinding[]): EvalResult {
  const elapsed = stopwatch();
  let findings: EvalFinding[];
  try {
    findings = fn();
  } catch (err) {
    findings = [{ code: "check_error", severity: "error", message: `Check ${checkId} crashed: ${err instanceof Error ? err.message : String(err)}` }];
  }
  return buildResult(checkId, mandatory, findings, elapsed());
}

export function error(code: string, message: string, path?: string): EvalFinding {
  return path !== undefined ? { code, message, severity: "error", path } : { code, message, severity: "error" };
}

export function warning(code: string, message: string, path?: string): EvalFinding {
  return path !== undefined ? { code, message, severity: "warning", path } : { code, message, severity: "warning" };
}

export function info(code: string, message: string, path?: string): EvalFinding {
  return path !== undefined ? { code, message, severity: "info", path } : { code, message, severity: "info" };
}
