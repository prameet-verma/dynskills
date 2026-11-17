import type { BaselineComparison, BehaviouralEvalCase, GeneratedSkill } from "../contracts/index.js";
import { isoNow } from "../core/index.js";
import { runBehaviouralSmokeEval } from "./behavioural.js";
import { SKILL_FILE } from "./context.js";

/** Lift (in coverage share) below which a skill is judged to add nothing over the baseline. */
export const BASELINE_MIN_LIFT = 0.05;

function asSkill(text: string, template: GeneratedSkill): GeneratedSkill {
  return { ...template, files: [{ path: SKILL_FILE, content: text }] };
}

function coverage(skill: GeneratedSkill, actions: string[], caseId: string): number {
  if (actions.length === 0) return 1;
  const res = runBehaviouralSmokeEval(skill, { id: caseId, task: "", expectedActions: actions, prohibitedActions: [], expectedOutcome: "" });
  return res.coveredExpected.length / actions.length;
}

/**
 * §8.3 skill-versus-no-skill comparison, statically: the same behavioural case is scored against the
 * skill and against the baseline (the repository instructions the host would have without the skill).
 * Deterministic, no LLM calls, so it fits inside the normal budget; a host simulation can replace it.
 */
export function compareWithBaseline(input: {
  skill: GeneratedSkill;
  evalCase: BehaviouralEvalCase;
  /** What the host has without the skill: repository instruction file contents. */
  baselineTexts: string[];
  trigger: BaselineComparison["trigger"];
}): BaselineComparison {
  const { skill, evalCase } = input;
  const baseline = asSkill(input.baselineTexts.join("\n\n"), skill);
  const skillCoverage = coverage(skill, evalCase.expectedActions, evalCase.id);
  const baselineCoverage = coverage(baseline, evalCase.expectedActions, evalCase.id);
  // A prohibition "counts" for a text when the text addresses it at all (Boundaries phrase it as "Do not …").
  const prohibitionsAdded = evalCase.prohibitedActions.filter(
    (p) => coverage(skill, [p], evalCase.id) === 1 && coverage(baseline, [p], evalCase.id) < 1,
  ).length;
  const lift = Math.round((skillCoverage - baselineCoverage) * 1000) / 1000;
  const verdict: BaselineComparison["verdict"] =
    lift < 0 ? "regresses" : lift >= BASELINE_MIN_LIFT || prohibitionsAdded > 0 ? "improves" : "no_improvement";
  return {
    caseId: evalCase.id,
    mode: "static",
    skillCoverage: Math.round(skillCoverage * 1000) / 1000,
    baselineCoverage: Math.round(baselineCoverage * 1000) / 1000,
    lift,
    prohibitionsAdded,
    verdict,
    trigger: input.trigger,
    at: isoNow(),
  };
}
