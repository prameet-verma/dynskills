/** §8 Evaluation Engine. */
export type { EvalContext, GenerationCheck } from "./context.js";
export { buildResult, SKILL_FILE } from "./context.js";
export { checkStructural, STANDARD_FRONTMATTER_KEYS, STRUCTURAL_FIXABLE_CODES } from "./structural.js";
export { checkGrounding } from "./grounding.js";
export { checkScope, KNOWN_DEPENDENCIES, SCOPE_BODY_COVERAGE_MIN } from "./scope.js";
export { checkDuplication, DESCRIPTION_SIMILARITY_WARN } from "./duplication.js";
export { checkConciseness, GENERIC_ADVICE_PHRASES } from "./conciseness.js";
export { checkPortability, HARNESS_SPECIFIC_FRONTMATTER } from "./portability.js";
export { checkSecurity, DANGEROUS_INSTRUCTIONS } from "./security.js";
export { createBehaviouralEvalCase, runBehaviouralSmokeEval, BEHAVIOURAL_THRESHOLDS } from "./behavioural.js";
export { evaluateSkill, GENERATION_CHECKS } from "./evaluate.js";
export { compareWithBaseline, BASELINE_MIN_LIFT } from "./baseline.js";
export { planRevision, DEFAULT_MINIMUM_LLM_REVISION_MS, DETERMINISTIC_FIXABLE_CODES } from "./revision.js";
export type { RevisionAction } from "./revision.js";
/** Re-exported so callers can build EvalContext.knownEvidenceIds / knownPaths from a packet. */
export { collectKnownReferences, parseSkillMarkdown } from "../skill-compiler/index.js";
export type { KnownReferences } from "../skill-compiler/index.js";
