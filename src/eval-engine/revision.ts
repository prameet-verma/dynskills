import type { SkillEvaluationReport } from "../contracts/index.js";
import { STRUCTURAL_FIXABLE_CODES } from "./structural.js";

export const DEFAULT_MINIMUM_LLM_REVISION_MS = 8_000;

/** Error codes (from any check) that applyDeterministicFixes + re-render can resolve without an LLM. */
export const DETERMINISTIC_FIXABLE_CODES: ReadonlySet<string> = new Set([...STRUCTURAL_FIXABLE_CODES, "name_collision"]);

export type RevisionAction = "activate" | "deterministic_fix" | "llm_revision" | "abort";

/**
 * §8.6 revision policy. pass/warning → activate. Failures that are all deterministically fixable →
 * deterministic_fix (once; pass deterministicFixApplied after trying). Otherwise one consolidated
 * LLM revision if attempts and budget remain, else abort. A failed mandatory eval is never bypassed.
 */
export function planRevision(input: {
  report: SkillEvaluationReport;
  attemptsUsed: number;
  maximumAttempts: number;
  remainingMs: number;
  minimumLlmRevisionMs?: number;
  /** True when deterministic fixes were already applied to this draft (prevents a fix loop). */
  deterministicFixApplied?: boolean;
}): { action: RevisionAction; reasons: string[] } {
  const { report } = input;
  if (report.status === "pass" || report.status === "warning") {
    return { action: "activate", reasons: [`Evaluation ${report.status === "pass" ? "passed" : "passed with warnings"}.`] };
  }

  const failing = Object.values(report.generation).filter((r) => r.status === "fail" && r.mandatory);
  const errorCodes = failing.flatMap((r) => r.findings.filter((f) => f.severity === "error").map((f) => f.code));
  const behaviouralFailed = report.behavioural.status === "fail";
  const reasons = failing.map((r) => `Mandatory check "${r.checkId}" failed (${[...new Set(r.findings.filter((f) => f.severity === "error").map((f) => f.code))].join(", ")}).`);
  if (behaviouralFailed) reasons.push("Behavioural smoke evaluation failed.");

  if (input.remainingMs <= 0) return { action: "abort", reasons: [...reasons, "No active budget remains."] };

  const allFixable = !behaviouralFailed && errorCodes.length > 0 && errorCodes.every((c) => DETERMINISTIC_FIXABLE_CODES.has(c));
  if (allFixable && !input.deterministicFixApplied) {
    return { action: "deterministic_fix", reasons: [...reasons, "All failures are structural and deterministically fixable."] };
  }

  const minimum = input.minimumLlmRevisionMs ?? DEFAULT_MINIMUM_LLM_REVISION_MS;
  if (input.attemptsUsed >= input.maximumAttempts) {
    return { action: "abort", reasons: [...reasons, `Revision attempts exhausted (${input.attemptsUsed}/${input.maximumAttempts}).`] };
  }
  if (input.remainingMs < minimum) {
    return { action: "abort", reasons: [...reasons, `Remaining budget ${input.remainingMs} ms is below the ${minimum} ms needed for an LLM revision.`] };
  }
  return { action: "llm_revision", reasons: [...reasons, "One consolidated LLM revision using the report's revision hints."] };
}
