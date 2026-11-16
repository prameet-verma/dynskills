import type {
  Assumption,
  BehaviouralEvalCase,
  BehaviouralEvalResult,
  EvalFinding,
  EvalResult,
  EvalStatus,
  GeneratedSkill,
  SkillEvaluationReport,
} from "../contracts/index.js";
import { isoNow, stopwatch } from "../core/index.js";
import { runBehaviouralSmokeEval } from "./behavioural.js";
import { checkConciseness } from "./conciseness.js";
import type { EvalContext, GenerationCheck } from "./context.js";
import { buildResult } from "./context.js";
import { checkDuplication } from "./duplication.js";
import { checkGrounding } from "./grounding.js";
import { checkPortability } from "./portability.js";
import { checkScope } from "./scope.js";
import { checkSecurity } from "./security.js";
import { checkStructural } from "./structural.js";

export const GENERATION_CHECKS = {
  structural: checkStructural,
  grounding: checkGrounding,
  scope: checkScope,
  duplication: checkDuplication,
  conciseness: checkConciseness,
  portability: checkPortability,
  security: checkSecurity,
} as const satisfies Record<keyof SkillEvaluationReport["generation"], GenerationCheck>;

type CheckKey = keyof typeof GENERATION_CHECKS;

/** Run a synchronous check on the microtask queue so all checks start together (§15.3). */
async function runAsync(checkId: string, mandatory: boolean, fn: () => EvalResult): Promise<EvalResult> {
  await Promise.resolve();
  const elapsed = stopwatch();
  try {
    return fn();
  } catch (err) {
    const finding: EvalFinding = { code: "check_error", severity: "error", message: `Check ${checkId} crashed: ${err instanceof Error ? err.message : String(err)}` };
    return buildResult(checkId, mandatory, [finding], elapsed());
  }
}

function hint(source: string, f: EvalFinding): string {
  const msg = f.message.trim();
  return `[${source}${f.path ? ` ${f.path}` : ""}] ${/[.!?]$/.test(msg) ? msg : `${msg}.`}`;
}

/**
 * Run all generation checks and the behavioural smoke eval concurrently and aggregate them.
 * A failed mandatory check (or a failed required behavioural eval) makes the report "fail";
 * it is never downgraded to a warning (§8.1).
 */
export async function evaluateSkill(input: {
  runId: string;
  skill: GeneratedSkill;
  context: EvalContext;
  evalCase: BehaviouralEvalCase;
  assumptions: Assumption[];
  /** Result of a host-run simulation (mode "host_simulation"); replaces the static smoke eval when given. */
  hostBehaviouralResult?: BehaviouralEvalResult;
  /** config.evaluation.behaviouralSmokeEval === "required" (default true). */
  behaviouralRequired?: boolean;
}): Promise<SkillEvaluationReport> {
  const elapsed = stopwatch();
  const { skill, context } = input;
  const behaviouralRequired = input.behaviouralRequired ?? true;

  const keys = Object.keys(GENERATION_CHECKS) as CheckKey[];
  const [behaviouralResult, ...results] = await Promise.all([
    input.hostBehaviouralResult !== undefined
      ? Promise.resolve(input.hostBehaviouralResult)
      : (async (): Promise<BehaviouralEvalResult> => {
          await Promise.resolve();
          return runBehaviouralSmokeEval(skill, input.evalCase);
        })(),
    ...keys.map((k) => runAsync(k, k === "scope" ? false : k === "grounding" ? context.policy.requireEvidence : true, () => GENERATION_CHECKS[k](skill, context))),
  ]);

  const generation = Object.fromEntries(keys.map((k, i) => [k, results[i]])) as SkillEvaluationReport["generation"];
  const all = Object.values(generation);

  let status: EvalStatus = "pass";
  if (all.some((r) => r.status === "fail" && r.mandatory)) status = "fail";
  else if (behaviouralRequired && behaviouralResult.status === "fail") status = "fail";
  else if (all.some((r) => r.status !== "pass") || behaviouralResult.status !== "pass") status = "warning";

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const r of all) {
    for (const f of r.findings) {
      if (f.severity === "error") (r.mandatory ? errors : warnings).push(hint(r.checkId, f));
      else if (f.severity === "warning") warnings.push(hint(r.checkId, f));
    }
  }
  for (const f of behaviouralResult.findings) {
    if (f.severity === "error") (behaviouralRequired ? errors : warnings).push(hint("behavioural", f));
    else if (f.severity === "warning") warnings.push(hint("behavioural", f));
  }

  return {
    runId: input.runId,
    skillId: skill.skillId,
    artifactHash: skill.artifactHash,
    status,
    generation,
    behavioural: {
      executed: behaviouralResult.executed,
      status: behaviouralResult.status,
      caseId: behaviouralResult.caseId,
      result: behaviouralResult,
    },
    assumptions: input.assumptions,
    tokenCount: skill.tokenCount,
    durationMs: elapsed(),
    generatedAt: isoNow(),
    revisionHints: [...new Set([...errors, ...warnings])],
  };
}
