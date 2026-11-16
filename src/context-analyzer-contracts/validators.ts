import type {
  ClarificationRequest,
  ClarificationResponse,
  ContextAnalysisResult,
  ContextPacket,
  ContextRequest,
  SkillDraft,
  ValidationIssue,
  ValidationOutcome,
} from "../contracts/index.js";
import { pointer, schemaIssues, type SchemaName } from "./schemas.js";

function outcome<T>(value: T | undefined, issues: ValidationIssue[]): ValidationOutcome<T> {
  const valid = !issues.some((i) => i.severity === "error");
  return valid && value !== undefined ? { valid, value, issues } : { valid, issues };
}

function structural<T>(name: SchemaName, input: unknown): { value?: T; issues: ValidationIssue[] } {
  const issues = schemaIssues(name, input);
  return issues.length === 0 ? { value: input as T, issues } : { issues };
}

/**
 * Normalise a source reference for lookup: POSIX separators, no leading "./", no trailing "/",
 * and no line suffix (":12", ":12-20", "#L12", "#L12-L20").
 */
export function normalizeSourceRef(ref: string): string {
  let s = ref.trim().replace(/\\/g, "/");
  s = s.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/:\d+(?:-\d+)?$/, "");
  while (s.startsWith("./")) s = s.slice(2);
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s === "" ? "." : s;
}

/** Every reference a ContextAnalysisResult may cite: packet evidence ids and every path present in the packet. */
export function packetReferences(packet: ContextPacket): Set<string> {
  const refs = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p) refs.add(normalizeSourceRef(p));
  };
  for (const e of packet.evidence ?? []) {
    refs.add(e.id);
    add(e.source);
  }
  for (const i of packet.instructions ?? []) add(i.path);
  for (const c of packet.configuration ?? []) add(c.path);
  for (const f of packet.sourceFiles ?? []) add(f.path);
  for (const s of packet.existingSkills ?? []) add(s.path);
  for (const f of packet.technology?.frameworks ?? []) add(f.source);
  for (const p of packet.structure?.workspaces ?? []) add(p);
  for (const p of packet.structure?.relevantDirectories ?? []) add(p);
  for (const p of packet.structure?.entrypoints ?? []) add(p);
  return refs;
}

function resolves(ref: string, known: ReadonlySet<string>): boolean {
  return known.has(ref) || known.has(normalizeSourceRef(ref));
}

/** Issues for a repository-relative path that a ContextRequest may target (never outside the repository). */
function requestPathIssues(req: ContextRequest, base: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (req.path === undefined && req.query === undefined) {
    issues.push({ path: base || "/", message: "must provide `path` or `query` so the request stays targeted", severity: "error" });
  }
  if (req.path !== undefined) {
    const p = req.path.replace(/\\/g, "/");
    if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p) || p.split("/").includes("..")) {
      issues.push({
        path: `${base}/path`,
        message: "must be a repository-relative path without `..` segments",
        severity: "error",
      });
    }
  }
  return issues;
}

/**
 * §5.4 — validate a host-produced ContextAnalysisResult against the schema and the packet it analyses.
 * Unresolvable `observed` sources are errors (inferences must not be presented as observed facts);
 * unresolvable `inferred` and conflict sources are warnings.
 */
export function validateContextAnalysisResult(
  input: unknown,
  packet: ContextPacket,
): ValidationOutcome<ContextAnalysisResult> {
  const { value, issues } = structural<ContextAnalysisResult>("context-analysis-result", input);
  if (!value) return outcome<ContextAnalysisResult>(undefined, issues);

  if (value.runId !== packet.runId) {
    issues.push({
      path: "/runId",
      message: `must equal the Context Packet runId "${packet.runId}" (got "${value.runId}")`,
      severity: "error",
    });
  }

  const known = packetReferences(packet);
  value.evidence.forEach((ev, i) => {
    if (resolves(ev.source, known)) return;
    if (ev.type === "observed") {
      issues.push({
        path: pointer("evidence", i, "source"),
        message: `"${ev.source}" is not a packet evidence id or a path present in the Context Packet; an observed claim must cite packet evidence (cite a packet source, or mark the claim "inferred")`,
        severity: "error",
      });
    } else {
      issues.push({
        path: pointer("evidence", i, "source"),
        message: `"${ev.source}" is not present in the Context Packet; the inference cannot be traced to packet evidence`,
        severity: "warning",
      });
    }
  });

  value.conflicts.forEach((c, i) => {
    c.sources.forEach((src, j) => {
      if (!resolves(src, known)) {
        issues.push({
          path: pointer("conflicts", i, "sources", j),
          message: `"${src}" is not a packet evidence id or a path present in the Context Packet`,
          severity: "warning",
        });
      }
    });
  });

  value.additionalContextRequests?.forEach((req, i) => {
    issues.push(...requestPathIssues(req, pointer("additionalContextRequests", i)));
  });

  return outcome(value, issues);
}

export interface SkillDraftValidationOptions {
  runId: string;
  /** Evidence ids, repository-relative paths and assumption ids that a draft may cite. */
  knownReferences: ReadonlySet<string>;
  /** When true, ungrounded constraints and unknown references are errors; otherwise warnings. */
  requireEvidence: boolean;
}

/** §7 — validate a host-produced SkillDraft: schema, runId, and grounding of every project constraint. */
export function validateSkillDraft(input: unknown, opts: SkillDraftValidationOptions): ValidationOutcome<SkillDraft> {
  const { value, issues } = structural<SkillDraft>("skill-draft", input);
  if (!value) return outcome<SkillDraft>(undefined, issues);
  const severity = opts.requireEvidence ? "error" : "warning";

  if (value.runId !== opts.runId) {
    issues.push({ path: "/runId", message: `must equal the run's runId "${opts.runId}" (got "${value.runId}")`, severity: "error" });
  }

  value.projectConstraints.forEach((c, i) => {
    if (c.evidence.length === 0) {
      issues.push({
        path: pointer("projectConstraints", i, "evidence"),
        message: "a project constraint must cite at least one evidence id, packet path or assumption id",
        severity,
      });
    }
    c.evidence.forEach((ref, j) => {
      if (!resolves(ref, opts.knownReferences)) {
        issues.push({
          path: pointer("projectConstraints", i, "evidence", j),
          message: `"${ref}" does not resolve to known evidence, a packet path or a documented assumption`,
          severity,
        });
      }
    });
  });

  value.assumptions?.forEach((id, i) => {
    if (!resolves(id, opts.knownReferences)) {
      issues.push({ path: pointer("assumptions", i), message: `"${id}" is not a documented assumption`, severity });
    }
  });

  const seen = new Set<string>();
  value.references?.forEach((r, i) => {
    if (seen.has(r.fileName)) {
      issues.push({ path: pointer("references", i, "fileName"), message: `duplicate reference file "${r.fileName}"`, severity: "error" });
    }
    seen.add(r.fileName);
  });

  return outcome(value, issues);
}

/** §6.1 — validate a ClarificationResponse against the request it answers. */
export function validateClarificationResponse(
  input: unknown,
  request: ClarificationRequest,
): ValidationOutcome<ClarificationResponse> {
  const { value, issues } = structural<ClarificationResponse>("clarification-response", input);
  if (!value) return outcome<ClarificationResponse>(undefined, issues);

  if (value.runId !== request.runId) {
    issues.push({ path: "/runId", message: `must equal the request runId "${request.runId}" (got "${value.runId}")`, severity: "error" });
  }
  if (value.round !== request.round) {
    issues.push({ path: "/round", message: `must equal the request round ${request.round} (got ${value.round})`, severity: "error" });
  }

  const questions = new Map(request.questions.map((q) => [q.id, q]));
  const answeredIds = new Set<string>();
  value.answers.forEach((a, i) => {
    if (!questions.has(a.questionId)) {
      issues.push({
        path: pointer("answers", i, "questionId"),
        message: `"${a.questionId}" is not a question of round ${request.round} (expected one of: ${[...questions.keys()].join(", ")})`,
        severity: "error",
      });
    }
    if (answeredIds.has(a.questionId)) {
      issues.push({ path: pointer("answers", i, "questionId"), message: `duplicate answer for "${a.questionId}"`, severity: "error" });
    }
    answeredIds.add(a.questionId);
    if (a.status === "answered" && (a.answer === undefined || a.answer.trim() === "")) {
      issues.push({
        path: pointer("answers", i, "answer"),
        message: 'must be a non-empty string when status is "answered" (use "skipped" or "declined" otherwise)',
        severity: "error",
      });
    }
    if (a.status !== "answered" && a.answer !== undefined && a.answer.trim() !== "") {
      issues.push({
        path: pointer("answers", i, "answer"),
        message: `is ignored because status is "${a.status}"`,
        severity: "warning",
      });
    }
  });

  for (const q of request.questions) {
    if (!answeredIds.has(q.id)) {
      issues.push({
        path: "/answers",
        message: `missing an entry for ${q.required ? "required " : ""}question "${q.id}" (${q.question}); use status "skipped" or "declined" if the user did not answer`,
        severity: q.required ? "error" : "warning",
      });
    }
  }

  return outcome(value, issues);
}

/** §5.5 — validate a standalone ContextRequest (schema + targeted, repository-relative path). */
export function validateContextRequest(input: unknown): ValidationOutcome<ContextRequest> {
  const { value, issues } = structural<ContextRequest>("context-request", input);
  if (!value) return outcome<ContextRequest>(undefined, issues);
  issues.push(...requestPathIssues(value, ""));
  return outcome(value, issues);
}
