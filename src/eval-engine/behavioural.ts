import type {
  BehaviouralEvalCase,
  BehaviouralEvalResult,
  ContextAnalysisResult,
  EvalFinding,
  EvalStatus,
  GeneratedSkill,
  SkillDraft,
  TaskIntent,
} from "../contracts/index.js";
import { sha256, stopwatch } from "../core/index.js";
import { annotateLines, collapseWhitespace, isBoundaryLine, isProhibition, keywords, parseSkillMarkdown } from "../skill-compiler/index.js";
import { SKILL_FILE } from "./context.js";

/**
 * Static behavioural smoke eval thresholds:
 * - an expected action is "covered" when ≥ TERM_COVERAGE_THRESHOLD of its salient (stemmed,
 *   non-stopword) terms appear anywhere in SKILL.md;
 * - a prohibited action is "violated" when a single non-heading SKILL.md line that is NOT phrased as a
 *   prohibition/condition (and is not under "### Boundaries") contains ≥ PROHIBITED_MATCH_THRESHOLD
 *   of the action's salient terms (and at least 2 of them);
 * - status: any violation or coverage < FAIL_BELOW → fail; coverage < PASS_AT → warning; else pass.
 */
export const BEHAVIOURAL_THRESHOLDS = {
  TERM_COVERAGE_THRESHOLD: 0.5,
  PROHIBITED_MATCH_THRESHOLD: 0.8,
  FAIL_BELOW: 0.6,
  PASS_AT: 0.8,
} as const;

const MAX_EXPECTED = 5;
const GENERIC_PROHIBITED = [
  "Modify unrelated modules outside the task scope",
  "Add new dependencies that the project does not already use",
];

function clean(s: string): string {
  return collapseWhitespace(s).replace(/[.;]+$/, "");
}

/** "Do not modify X" → "Modify X" so the prohibited action reads as the action itself. */
function toAction(boundary: string): string {
  const s = clean(boundary).replace(/^(?:do not|don't|never|must not|avoid)\s+/i, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function createBehaviouralEvalCase(input: { task: TaskIntent; analysis: ContextAnalysisResult; draft?: SkillDraft }): BehaviouralEvalCase {
  const { task, analysis, draft } = input;
  const component = analysis.taskContext.relevantComponents[0] ?? task.scope?.[0];
  const scenario = `${clean(task.description)}${component ? ` (touching ${component})` : ""}.`;

  const expected: string[] = [];
  const push = (s: string): void => {
    const c = clean(s);
    if (c.length > 0 && !expected.some((e) => e.toLowerCase() === c.toLowerCase())) expected.push(c);
  };
  if (draft) {
    draft.projectConstraints.slice(0, 3).forEach((c) => push(c.statement));
    draft.verification.slice(0, 2).forEach(push);
  } else {
    [...analysis.taskContext.constraints, ...analysis.architecture.conventions].slice(0, 3).forEach(push);
  }
  if (expected.length === 0) push(`Complete: ${task.description}`);

  const prohibited = [...(draft?.authority.boundaries ?? []).slice(0, 3).map(toAction), ...GENERIC_PROHIBITED].filter(
    (p, i, all) => all.findIndex((o) => o.toLowerCase() === p.toLowerCase()) === i,
  );

  const expectedOutcome =
    task.expectedOutcome ?? analysis.taskContext.expectedOutcome ?? `"${clean(task.description)}" is done following the project constraints, with verification passing.`;
  const id = `beh_${sha256(JSON.stringify([scenario, expected, prohibited, expectedOutcome])).slice(0, 12)}`;
  return {
    id,
    task: scenario,
    expectedActions: expected.slice(0, MAX_EXPECTED),
    prohibitedActions: prohibited,
    expectedOutcome,
    deterministicAssertions: ["SKILL.md has Authority, Workflow and Verification sections"],
  };
}

function lineAllowsProhibited(text: string): boolean {
  return isProhibition(text) || /\b(do not|don't|never|must not|avoid|unless|without asking|only if|only when)\b/i.test(text);
}

/** Static (no LLM) behavioural smoke eval against SKILL.md content. */
export function runBehaviouralSmokeEval(skill: GeneratedSkill, evalCase: BehaviouralEvalCase): BehaviouralEvalResult {
  const elapsed = stopwatch();
  const T = BEHAVIOURAL_THRESHOLDS;
  const content = skill.files.find((f) => f.path === SKILL_FILE)?.content ?? "";
  const body = parseSkillMarkdown(content).body;
  const skillTerms = new Set(keywords(content));
  const findings: EvalFinding[] = [];

  const covered: string[] = [];
  const missing: string[] = [];
  for (const action of evalCase.expectedActions) {
    const terms = keywords(action);
    const hit = terms.filter((t) => skillTerms.has(t)).length;
    if (terms.length === 0 || hit / terms.length >= T.TERM_COVERAGE_THRESHOLD) covered.push(action);
    else missing.push(action);
  }

  const violations: string[] = [];
  const lines = annotateLines(body).filter((l) => !l.isHeading && l.text.trim().length > 0);
  for (const action of evalCase.prohibitedActions) {
    const terms = keywords(action);
    if (terms.length < 2) continue;
    const offending = lines.find((l) => {
      if (isBoundaryLine(l) || lineAllowsProhibited(l.text)) return false;
      const lineTerms = new Set(keywords(l.text));
      const hit = terms.filter((t) => lineTerms.has(t)).length;
      return hit >= 2 && hit / terms.length >= T.PROHIBITED_MATCH_THRESHOLD;
    });
    if (offending) {
      violations.push(action);
      findings.push({
        code: "prohibited_action_instructed",
        severity: "error",
        message: `SKILL.md appears to instruct a prohibited action ("${action}"): "${offending.text.trim().slice(0, 100)}".`,
        path: SKILL_FILE,
      });
    }
  }

  const ratio = evalCase.expectedActions.length === 0 ? 1 : covered.length / evalCase.expectedActions.length;
  for (const m of missing) {
    findings.push({ code: "expected_action_missing", severity: ratio < T.FAIL_BELOW ? "error" : "warning", message: `SKILL.md gives no guidance for expected action: "${m}".`, path: SKILL_FILE });
  }
  let status: EvalStatus = "pass";
  if (violations.length > 0 || ratio < T.FAIL_BELOW) status = "fail";
  else if (ratio < T.PASS_AT) status = "warning";
  findings.push({ code: "coverage", severity: "info", message: `Covered ${covered.length}/${evalCase.expectedActions.length} expected actions (${Math.round(ratio * 100)}%).` });

  return {
    caseId: evalCase.id,
    status,
    executed: true,
    mode: "static",
    coveredExpected: covered,
    missingExpected: missing,
    prohibitedViolations: violations,
    findings,
    durationMs: elapsed(),
  };
}
