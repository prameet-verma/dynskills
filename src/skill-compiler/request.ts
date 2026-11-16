import type {
  Assumption,
  ContextAnalysisResult,
  ContextGap,
  DynamicSkillsConfig,
  SkillCompilationRequest,
  SkillInventoryItem,
  TaskIntent,
} from "../contracts/index.js";
import { SCHEMA_VERSION } from "../contracts/index.js";
import { formatEvidenceRefs } from "./markdown.js";

export function buildCompilationRequest(input: {
  runId: string;
  task: TaskIntent;
  analysis: ContextAnalysisResult;
  gaps: ContextGap[];
  assumptions: Assumption[];
  existingSkills: SkillInventoryItem[];
  config: DynamicSkillsConfig;
}): SkillCompilationRequest {
  return {
    runId: input.runId,
    task: input.task,
    context: input.analysis,
    gaps: input.gaps,
    assumptions: input.assumptions,
    existingSkills: input.existingSkills,
    compilationPolicy: {
      targetTokenCount: input.config.generation.targetSkillTokens,
      maximumTokenCount: input.config.generation.maximumSkillTokens,
      requireEvidence: true,
      portability: input.config.generation.format,
    },
  };
}

const MAX_PROMPT_EVIDENCE = 40;

function list(items: readonly string[], empty = "none"): string {
  return items.length > 0 ? items.join("; ") : empty;
}

/**
 * Instruction text handed to the host agent's LLM to produce a SkillDraft JSON document.
 * Kept compact: it summarises the analysis rather than embedding the context packet.
 */
export function buildCompilationPrompt(
  request: SkillCompilationRequest,
  opts: { evidenceIds: string[]; skillDraftSchemaPath: string },
): string {
  const { task, context: a, compilationPolicy: policy } = request;
  const evidencePaths = [
    ...new Set(a.evidence.map((e) => e.source).filter((s) => !s.startsWith("ev_") && s !== "." && s !== "")),
  ];
  const observed = a.evidence.filter((e) => e.type === "observed").slice(0, MAX_PROMPT_EVIDENCE);
  const inferred = a.evidence.filter((e) => e.type === "inferred").slice(0, MAX_PROMPT_EVIDENCE);
  const existing = request.existingSkills.map((s) => s.name);

  const out: string[] = [
    `Compile a task-specific Agent Skill (Dynamic Skills run ${request.runId}).`,
    `Output ONLY one JSON object (no prose, no code fences) conforming to the SkillDraft JSON Schema at ${opts.skillDraftSchemaPath}, with schemaVersion "${SCHEMA_VERSION}" and runId "${request.runId}".`,
    "",
    "## Task",
    task.description,
  ];
  if (task.expectedOutcome) out.push(`Expected outcome: ${task.expectedOutcome}`);
  if (task.scope?.length) out.push(`Scope: ${list(task.scope)}`);
  if (task.constraints?.length) out.push(`User constraints: ${list(task.constraints)}`);

  out.push(
    "",
    "## Produce",
    "1. specialist: a task-specific identity and responsibility (a seniority persona alone is insufficient).",
    `2. name: lowercase kebab-case, <= 64 chars, not one of the existing skills; description: <= 1024 chars stating what the skill does AND when to use it.`,
    "3. authority (one short bullet list each): ownership = what the specialist owns; decisionRights = what it may decide independently; boundaries = prohibited assumptions or modifications, phrased \"Do not ...\"; accountability = how correctness is established.",
    "4. workflow: ordered methodology steps. Keep reusable methodology here and project-specific facts in projectConstraints.",
    "5. projectConstraints: project-specific facts only. Every entry's `evidence` must cite >= 1 item from the allowed lists below; omit any constraint you cannot ground.",
    "6. verification: concrete checks/commands observed in this project.",
    "7. references: only when they add material value (progressive disclosure); otherwise omit. assumptions: ids of assumptions the skill relies on.",
    "",
    "## Grounding",
    `Allowed evidence ids: ${list(opts.evidenceIds)}`,
    `Allowed paths: ${list(evidencePaths)}`,
    `Allowed assumption ids: ${list(request.assumptions.map((x) => `${x.id} (${x.statement})`))}`,
    "State observed facts plainly; mark inferred ones as inferred (\"appears to\", \"likely\"); never present an assumption or inference as observed. Do not invent facts, paths, commands or ids.",
    `The renderer appends citations to each constraint as ${formatEvidenceRefs(["<ids>"])}; do not write them yourself.`,
    "",
    "## Avoid",
    "- Generic software-engineering advice (e.g. \"write clean code\", \"follow best practices\").",
    `- Repeating repository instructions the agent already loads${a.evidence.some((e) => /agents\.md|claude\.md/i.test(e.source)) ? " (AGENTS.md/CLAUDE.md)" : ""}.`,
    `- Duplicating existing skills: ${list(existing)}.`,
    "- Dependencies or technologies not relevant to this task.",
    "- Dumping the context packet or long architecture explanations unrelated to the task.",
    "- Unsupported assumptions.",
    "",
    `## Budget`,
    `Rendered SKILL.md should stay under ${policy.targetTokenCount} tokens (hard maximum ${policy.maximumTokenCount}). Prefer short, specific bullets.`,
    "",
    "## Context analysis (summary)",
    `Technology: languages ${list(a.technology.languages)}; frameworks ${list(a.technology.frameworks)}; runtimes ${list(a.technology.runtimes)}; package managers ${list(a.technology.packageManagers)}.`,
    `Patterns: ${list(a.architecture.patterns)}.`,
    `Conventions: ${list(a.architecture.conventions)}.`,
    `Relevant components: ${list(a.taskContext.relevantComponents)}. Existing implementations: ${list(a.taskContext.existingImplementations)}.`,
    `Task constraints: ${list(a.taskContext.constraints)}.`,
  );
  if (request.gaps.length > 0) out.push(`Gaps: ${list(request.gaps.map((g) => `[${g.severity}] ${g.description}`))}.`);
  const critical = a.unknowns.filter((u) => u.importance === "critical").map((u) => u.question);
  if (critical.length > 0) out.push(`Open questions (do not assume answers): ${list(critical)}.`);
  if (a.conflicts.length > 0) out.push(`Conflicts (surface, do not resolve silently): ${list(a.conflicts.map((c) => c.subject))}.`);
  if (observed.length > 0) out.push("Observed evidence:", ...observed.map((e) => `- ${e.claim} (${e.source})`));
  if (inferred.length > 0) out.push("Inferred evidence:", ...inferred.map((e) => `- ${e.claim} (${e.source})`));
  return out.join("\n");
}
