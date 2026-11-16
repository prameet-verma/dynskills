import type {
  ContextAnalysisResult,
  ContextGap,
  ContextPacket,
  ContextRequest,
  DiscoveryEvidence,
  GapAnalysis,
  SkillInventoryItem,
  TaskIntent,
} from "../contracts/index.js";
import { intersectionSize, normalizeQuestion, shortHash, tokenSet } from "./text.js";

// ---------------------------------------------------------------------------
// Skill sufficiency (§5.6 "reuse_existing", §4 PREFLIGHT → REUSE_EXISTING)
// ---------------------------------------------------------------------------

/**
 * Scoring (deterministic, lexical):
 *   task terms  T = tokens(task.description + task.expectedOutcome)
 *   skill terms S = tokens(skill.name + skill.description)
 *   score = |T ∩ S| / |T|  (+ NAME_BONUS when every token of the skill name occurs in T), capped at 1.
 * A skill is a strong match — and the task is `sufficient`ly covered — only when
 *   score ≥ SUFFICIENCY_THRESHOLD (0.6) AND it shares ≥ MIN_SHARED_TERMS (2) terms with the task
 * (1 when the task itself has a single term). Tokens drop stopwords and generic verbs
 * ("add", "implement", "code", …) so only domain terms count.
 */
export const SUFFICIENCY_THRESHOLD = 0.6;
export const MIN_SHARED_TERMS = 2;
export const NAME_BONUS = 0.15;

export interface SkillMatch {
  skill: SkillInventoryItem;
  score: number;
}

export function assessSkillSufficiency(
  task: TaskIntent,
  existingSkills: SkillInventoryItem[],
): { sufficient: boolean; matches: SkillMatch[] } {
  const taskTerms = tokenSet(task.description, task.expectedOutcome);
  if (taskTerms.size === 0) return { sufficient: false, matches: [] };
  const minShared = Math.min(MIN_SHARED_TERMS, taskTerms.size);

  const scored = existingSkills.map((skill, index) => {
    const skillTerms = tokenSet(skill.name, skill.description);
    const shared = intersectionSize(taskTerms, skillTerms);
    const nameTerms = tokenSet(skill.name);
    const nameMatch = nameTerms.size > 0 && [...nameTerms].every((t) => taskTerms.has(t));
    const raw = shared / taskTerms.size + (nameMatch && shared > 0 ? NAME_BONUS : 0);
    const score = Math.round(Math.min(1, raw) * 1000) / 1000;
    return { skill, score, strong: score >= SUFFICIENCY_THRESHOLD && shared >= minShared, index };
  });

  const ranked = scored
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return {
    sufficient: ranked.some((m) => m.strong),
    matches: ranked.map(({ skill, score }) => ({ skill, score })),
  };
}

// ---------------------------------------------------------------------------
// Gap analysis (§5.6)
// ---------------------------------------------------------------------------

export interface GapAnalysisInput {
  task: TaskIntent;
  analysis: ContextAnalysisResult;
  packet: ContextPacket;
  existingSkills: SkillInventoryItem[];
  /** Normalized texts of questions already asked in earlier rounds (see normalizeQuestion). */
  previouslyAsked?: string[];
  /** Normalized texts of questions the user declined. */
  declined?: string[];
}

/** Unknown-question classes. Only project facts, user intent and engineering decisions create work. */
export type QuestionClass = "user_intent" | "general_expertise" | "project_fact";

const INTENT_RE =
  /^(should|would|could|must)\b|\b(should (?:we|i|the|it|this|they|new)|do you|would you|you want|you prefer|prefer(?:red|ence)?|desired|intended|intent|expected behaviou?r|requirements?|acceptance criteria|business rules?|acceptable|out of scope|in scope|which (?:approach|option|strategy|behaviou?r|design)|what should|stakeholders?|product decision|trade-?off)\b/i;

const GENERAL_RE =
  /\b(best practices?|in general|generally|idiomatic|how (?:do|does|to|can|should) (?:i|you|one|we)\b|how to\b|how (?:does|do) (?:[\w.@/-]+ ){1,3}work|what is (?:a|an|the) (?:recommended|standard|best|typical|usual)|common patterns?|standard approach|general guidance)\b/i;

const PROJECT_SCOPE_RE = /\b(this|our|the|your) (?:repo|repository|project|codebase|service|app|application|monorepo|team|package|workspace)\b/i;

const PROJECT_FACT_RE =
  /\b(config(?:uration|ured|s)?|settings?|dependenc(?:y|ies)|packages?|versions?|installed|librar(?:y|ies)|director(?:y|ies)|folders?|modules?|schemas?|environment|env(?: vars?)?|scripts?|pipelines?|ci|workflows?|lint(?:er|ing)?|test (?:runner|framework|setup|command)s?|build (?:tool|command|system)s?|where (?:is|are|do|does)|which files?|defined|declared|located|imported|entry ?points?|migrations?|database|tables?|endpoints?|routes?)\b/i;

const PATH_RE =
  /(?:\.{0,2}\/)?(?:[\w@-][\w@.-]*\/)+[\w@.-]+|\b[\w.-]+\.(?:json|jsonc|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|md|lock|cfg|ini|xml|gradle|properties|sql|sh|env|nvmrc)\b/i;

const DEPENDENCY_RE = /\b(dependenc(?:y|ies)|packages?|versions?|installed|librar(?:y|ies)|sdk)\b/i;
const CONFIG_EXT_RE = /\.(json|jsonc|ya?ml|toml|ini|cfg|env|lock|properties|gradle|xml|nvmrc)$|(^|\/)\.?[\w-]*rc$|config/i;

export function classifyQuestion(question: string, matchedRequest: boolean): QuestionClass {
  if (INTENT_RE.test(question)) return "user_intent";
  const projectSignal = matchedRequest || PATH_RE.test(question) || PROJECT_SCOPE_RE.test(question);
  if (GENERAL_RE.test(question) && !projectSignal) return "general_expertise";
  if (projectSignal || PROJECT_FACT_RE.test(question)) return "project_fact";
  // Neither a repository fact nor general knowledge: an unresolved decision only the user can make.
  return "user_intent";
}

function requestKey(r: ContextRequest | undefined): string {
  return r ? `${r.type}|${r.path ?? ""}|${r.query ?? ""}` : "";
}

function gapId(category: ContextGap["category"], resolution: ContextGap["resolution"], description: string, request?: ContextRequest): string {
  return `gap_${shortHash(`${category}|${resolution}|${normalizeQuestion(description)}|${requestKey(request)}`)}`;
}

function makeGap(
  category: ContextGap["category"],
  resolution: ContextGap["resolution"],
  severity: ContextGap["severity"],
  description: string,
  contextRequest?: ContextRequest,
): ContextGap {
  return {
    id: gapId(category, resolution, description, contextRequest),
    category,
    description,
    severity,
    resolution,
    ...(contextRequest ? { contextRequest } : {}),
  };
}

function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s.replace(/\/+$/, "");
}

function isSafeRelative(p: string): boolean {
  return !p.startsWith("/") && !/^[a-zA-Z]:\//.test(p) && !p.split("/").includes("..") && p !== "";
}

/** Vocabulary implied by an evidence kind, so "Which version of X is installed?" matches "Depends on X 1.2". */
const KIND_TERMS: Partial<Record<DiscoveryEvidence["kind"], string>> = {
  language: "language",
  runtime: "runtime version",
  framework: "framework library version",
  package_manager: "package manager",
  tooling: "tool tooling",
  dependency: "dependency package library installed version",
  workspace: "workspace monorepo package",
  directory: "directory folder",
  entrypoint: "entrypoint entry point",
  test_configuration: "test testing framework runner configuration",
  build_configuration: "build configuration",
  ci_cd: "ci pipeline workflow",
};

/** Text of every known fact: packet evidence claims (+ values, kind vocabulary) and observed analysis claims. */
function knownFactTokens(packet: ContextPacket, analysis: ContextAnalysisResult): Array<Set<string>> {
  const facts: Array<Set<string>> = [];
  for (const e of packet.evidence ?? []) {
    const value =
      e.value === undefined ? undefined : typeof e.value === "object" ? Object.values(e.value).map(String).join(" ") : String(e.value);
    facts.push(tokenSet(e.claim, value, KIND_TERMS[e.kind]));
  }
  for (const e of analysis.evidence) if (e.type === "observed") facts.push(tokenSet(e.claim));
  return facts;
}

/**
 * A question is already answered by discovery when a single known fact covers ≥ 75 % of its
 * terms (and at least two of them, or its only term).
 */
function answeredByEvidence(question: string, facts: Array<Set<string>>): boolean {
  const q = tokenSet(question);
  if (q.size === 0) return false;
  const need = Math.min(2, q.size);
  return facts.some((f) => {
    const shared = intersectionSize(q, f);
    return shared >= need && shared / q.size >= 0.75;
  });
}

function matchRequest(question: string, requests: ContextRequest[]): ContextRequest | undefined {
  const q = tokenSet(question);
  const lower = question.toLowerCase();
  let best: { r: ContextRequest; score: number } | undefined;
  for (const r of requests) {
    let score = intersectionSize(q, tokenSet(r.path, r.query, r.reason));
    if (r.path && lower.includes(normalizePath(r.path).toLowerCase())) score += 10;
    if (score >= 2 && (!best || score > best.score)) best = { r, score };
  }
  return best?.r;
}

/** Synthesize a bounded request for a project-fact question that no analysis request covers. */
function synthesizeRequest(question: string): ContextRequest {
  const reason = `Resolve project fact needed for the task: ${question}`;
  const pathMatch = PATH_RE.exec(question)?.[0];
  const path = pathMatch ? normalizePath(pathMatch) : undefined;
  if (path && isSafeRelative(path)) {
    const base = path.split("/").pop() ?? path;
    const type: ContextRequest["type"] = CONFIG_EXT_RE.test(path)
      ? "configuration"
      : /\.md$/i.test(path)
        ? "documentation"
        : base.includes(".")
          ? "source_file"
          : "directory_summary";
    return { type, path, reason, priority: "required" };
  }
  if (DEPENDENCY_RE.test(question)) return { type: "dependency_details", query: question, reason, priority: "required" };
  return { type: "directory_summary", query: question, reason, priority: "required" };
}

/** Paths whose full content is already in the packet: requesting them again adds nothing. */
function pathsWithContent(packet: ContextPacket): Set<string> {
  const s = new Set<string>();
  for (const f of packet.sourceFiles ?? []) if (!f.truncated) s.add(normalizePath(f.path));
  for (const c of packet.configuration ?? []) if (c.content !== undefined) s.add(normalizePath(c.path));
  for (const i of packet.instructions ?? []) if (i.content !== undefined) s.add(normalizePath(i.path));
  return s;
}

function conflictQuestion(c: ContextAnalysisResult["conflicts"][number]): string {
  return `Repository sources disagree on ${c.subject}: ${c.observations.join(" vs ")}. Which one should the generated skill follow?`;
}

function conflictTouchesTask(
  c: ContextAnalysisResult["conflicts"][number],
  task: TaskIntent,
  analysis: ContextAnalysisResult,
): boolean {
  const components = [...analysis.taskContext.relevantComponents, ...(task.scope ?? [])].map(normalizePath).filter(Boolean);
  const sourceHit = c.sources.some((src) => {
    const s = normalizePath(src);
    return components.some((comp) => s === comp || s.startsWith(`${comp}/`) || comp.startsWith(`${s}/`));
  });
  if (sourceHit) return true;
  const conflictTerms = tokenSet(c.subject, ...c.observations);
  const focused = tokenSet(...analysis.taskContext.relevantComponents, ...analysis.taskContext.constraints, ...(task.scope ?? []), ...(task.constraints ?? []));
  if (intersectionSize(conflictTerms, focused) >= 1) return true;
  return intersectionSize(conflictTerms, tokenSet(task.description, task.expectedOutcome)) >= 2;
}

/**
 * §5.6 Context Gap Analyzer. Rules (in order, deterministic):
 * 1. Unknowns already answered by packet evidence / observed claims, previously asked, or declined → no gap.
 * 2. General-expertise unknowns ("best practices for X") → no work; folded into the single
 *    `missing_expertise` gap that describes the specialist expertise being compiled.
 * 3. Optional unknowns → `document_assumption` (severity optional).
 * 4. Critical project-fact unknowns (a matching additionalContextRequest, or the question references a
 *    file / configuration / dependency) → `missing_project_context` / `targeted_discovery` with a request.
 * 5. Other critical unknowns (user intent, requirements, unresolved engineering decisions) →
 *    `ambiguous_requirement` / `ask_user` (severity critical).
 * 6. Conflicts → `conflicting_evidence`: `ask_user` (important) when touching the task's relevant
 *    components/constraints, else `document_assumption` (optional).
 * 7. Remaining `required` additionalContextRequests → `targeted_discovery` (unless the packet already holds
 *    the full file). Optional requests not tied to a critical unknown are dropped (bounded discovery).
 * 8. Exactly one `missing_expertise` gap: `reuse_existing` when an existing skill is sufficient,
 *    otherwise `document_assumption` / optional.
 */
export function analyzeContextGaps(input: GapAnalysisInput): GapAnalysis {
  const { task, analysis, packet, existingSkills } = input;
  const asked = new Set((input.previouslyAsked ?? []).map(normalizeQuestion));
  const declined = new Set((input.declined ?? []).map(normalizeQuestion));
  const facts = knownFactTokens(packet, analysis);
  const requests = analysis.additionalContextRequests ?? [];
  const alreadyInPacket = pathsWithContent(packet);

  const gaps: ContextGap[] = [];
  const ids = new Set<string>();
  const usedRequests = new Set<string>();
  const generalQuestions: string[] = [];
  const push = (g: ContextGap): void => {
    if (ids.has(g.id)) return;
    ids.add(g.id);
    gaps.push(g);
  };
  const resolvedElsewhere = (question: string): boolean => {
    const n = normalizeQuestion(question);
    return asked.has(n) || declined.has(n);
  };

  const seenQuestions = new Set<string>();
  for (const u of analysis.unknowns) {
    const n = normalizeQuestion(u.question);
    if (n === "" || seenQuestions.has(n)) continue;
    seenQuestions.add(n);
    if (resolvedElsewhere(u.question) || answeredByEvidence(u.question, facts)) continue;

    const matched = matchRequest(u.question, requests);
    const cls = classifyQuestion(u.question, matched !== undefined);
    if (cls === "general_expertise") {
      generalQuestions.push(u.question);
      continue;
    }
    const category = cls === "project_fact" ? "missing_project_context" : "ambiguous_requirement";
    if (u.importance === "optional") {
      push(makeGap(category, "document_assumption", "optional", u.question));
      continue;
    }
    if (cls === "project_fact") {
      const request = matched ?? synthesizeRequest(u.question);
      if (request.path && alreadyInPacket.has(normalizePath(request.path))) {
        // The file is already fully in the packet; re-requesting cannot add facts. Ask instead.
        push(makeGap("ambiguous_requirement", "ask_user", "critical", u.question));
        continue;
      }
      usedRequests.add(requestKey(request));
      push(makeGap(category, "targeted_discovery", "critical", u.question, request));
    } else {
      push(makeGap(category, "ask_user", "critical", u.question));
    }
  }

  for (const c of analysis.conflicts) {
    const question = conflictQuestion(c);
    if (resolvedElsewhere(question)) continue;
    if (conflictTouchesTask(c, task, analysis)) {
      push(makeGap("conflicting_evidence", "ask_user", "important", question));
    } else {
      push(
        makeGap(
          "conflicting_evidence",
          "document_assumption",
          "optional",
          `Sources disagree on ${c.subject} (${c.observations.join(" vs ")}); not material to the task — follow the source closest to the changed code and flag the discrepancy.`,
        ),
      );
    }
  }

  for (const r of requests) {
    if (r.priority !== "required" || usedRequests.has(requestKey(r))) continue;
    if (r.path && (!isSafeRelative(normalizePath(r.path)) || alreadyInPacket.has(normalizePath(r.path)))) continue;
    usedRequests.add(requestKey(r));
    const target = r.path ?? r.query ?? r.type;
    push(makeGap("missing_project_context", "targeted_discovery", "important", `Targeted discovery (${r.type}: ${target}): ${r.reason}`, r));
  }

  const sufficiency = assessSkillSufficiency(task, existingSkills);
  const top = sufficiency.matches[0];
  if (sufficiency.sufficient && top) {
    push(
      makeGap(
        "missing_expertise",
        "reuse_existing",
        "optional",
        `Existing skill "${top.skill.name}" (relevance ${top.score}) already covers this task; reuse it instead of compiling new expertise.`,
      ),
    );
  } else {
    const folded = generalQuestions.length > 0 ? ` Not asked (general expertise): ${generalQuestions.join(" | ")}` : "";
    push(
      makeGap(
        "missing_expertise",
        "document_assumption",
        "optional",
        `Compile task-specific specialist expertise for: ${task.description.trim()}. General engineering knowledge is supplied by the host model and needs no discovery or clarification.${folded}`,
      ),
    );
  }

  return {
    gaps,
    requiresClarification: gaps.some((g) => g.resolution === "ask_user"),
    requiresDiscovery: gaps.some((g) => g.resolution === "targeted_discovery"),
    reuseExisting: sufficiency.sufficient,
  };
}
