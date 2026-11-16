import {
  MAXIMUM_CLARIFICATION_ROUNDS,
  type Assumption,
  type ClarificationAnswer,
  type ClarificationQuestion,
  type ClarificationRequest,
  type ClarificationResponse,
  type ContextGap,
} from "../contracts/index.js";
import { dsError, sha256, stableStringify } from "../core/index.js";
import { normalizeQuestion, questionId } from "../context-gap-analyzer/index.js";

/** Per-question metadata kept so declined/skipped answers become correctly weighted assumptions. */
export interface QuestionRecord {
  question: string;
  gapId: string;
  category: ContextGap["category"];
  severity: ContextGap["severity"];
  round: number;
}

/** §6.5 Serializable clarification state; persisted with the run so pauses survive process boundaries. */
export interface ClarificationState {
  /** Number of consolidated rounds asked so far (0 before the first request). */
  round: number;
  maximumRounds: number;
  requests: ClarificationRequest[];
  responses: ClarificationResponse[];
  assumptions: Assumption[];
  /** Normalized texts of every question asked (see normalizeQuestion). */
  askedQuestions: string[];
  /** Normalized texts of questions the user declined; never asked again. */
  declinedQuestions: string[];
  /** questionId → metadata. */
  questions: Record<string, QuestionRecord>;
}

const IMPACT: Record<ContextGap["severity"], Assumption["impact"]> = {
  critical: "high",
  important: "medium",
  optional: "low",
};

function assumptionId(qid: string, status: Assumption["status"]): string {
  return `asm_${sha256(`${qid}|${status}`).slice(0, 12)}`;
}

function questionReason(gap: ContextGap): string {
  switch (gap.category) {
    case "conflicting_evidence":
      return "Repository sources disagree on this point and the generated skill must follow exactly one of them.";
    case "missing_project_context":
      return "Discovery could not establish this project fact and the skill would otherwise rely on a guess.";
    case "missing_expertise":
      return "Needed to decide which specialist expertise to compile.";
    case "ambiguous_requirement":
    default:
      return gap.severity === "critical"
        ? "The task leaves this decision open and no repository evidence settles it; a wrong guess would make the skill incorrect."
        : "The task leaves this decision open; an answer makes the skill more precise.";
  }
}

/** The conservative default applied when a question is not answered. */
function conservativeDefault(category: ContextGap["category"]): string {
  switch (category) {
    case "conflicting_evidence":
      return "follow the source closest to the code being changed, do not reconcile the other source, and flag the discrepancy to the root agent";
    case "missing_project_context":
      return "follow the conventions visible in the nearest existing code and avoid relying on the unverified fact";
    default:
      return "take the narrowest interpretation that satisfies the task, follow existing repository conventions, avoid introducing new behaviour or dependencies, and surface the open decision to the root agent";
  }
}

function clampRounds(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return MAXIMUM_CLARIFICATION_ROUNDS;
  return Math.max(0, Math.min(MAXIMUM_CLARIFICATION_ROUNDS, Math.floor(n)));
}

function emptyState(maximumRounds: number): ClarificationState {
  return {
    round: 0,
    maximumRounds,
    requests: [],
    responses: [],
    assumptions: [],
    askedQuestions: [],
    declinedQuestions: [],
    questions: {},
  };
}

/**
 * §6.1–6.3 Clarification Manager: consolidated rounds (max 3), de-duplication against asked and
 * declined questions, and the assumption registry. It does not touch the SLA clock — the caller
 * pauses the ExecutionBudget when a request is issued and resumes it when the response arrives.
 */
export class ClarificationManager {
  private readonly state: ClarificationState;

  constructor(opts: { maximumRounds?: number; state?: ClarificationState } = {}) {
    const maximumRounds = clampRounds(opts.maximumRounds ?? opts.state?.maximumRounds);
    if (opts.state) {
      const s = structuredClone(opts.state);
      this.state = { ...emptyState(maximumRounds), ...s, maximumRounds, questions: s.questions ?? {} };
    } else {
      this.state = emptyState(maximumRounds);
    }
  }

  get roundsUsed(): number {
    return this.state.round;
  }

  get maximumRounds(): number {
    return this.state.maximumRounds;
  }

  canAskMore(): boolean {
    return this.state.round < this.state.maximumRounds;
  }

  /** The issued request still awaiting a response, if any. */
  pendingRequest(): ClarificationRequest | undefined {
    const last = this.state.requests.at(-1);
    if (!last) return undefined;
    return this.state.responses.some((r) => r.round === last.round) ? undefined : structuredClone(last);
  }

  /**
   * Build ONE consolidated request for the next round from the `ask_user` gaps.
   * Returns undefined when nothing new needs asking or the round limit is reached.
   * If the previous round is still unanswered, that pending request is returned again (idempotent).
   */
  buildRequest(runId: string, gaps: ContextGap[], context: string): ClarificationRequest | undefined {
    const pending = this.pendingRequest();
    if (pending) {
      if (pending.runId !== runId) {
        throw dsError("clarification", "clarification-manager", `Round ${pending.round} is pending for run ${pending.runId}, not ${runId}`, { runId });
      }
      return pending;
    }
    if (!this.canAskMore()) return undefined;

    const asked = new Set(this.state.askedQuestions);
    const declined = new Set(this.state.declinedQuestions);
    const questions: ClarificationQuestion[] = [];
    const records: Array<[string, Omit<QuestionRecord, "round">]> = [];
    const inRound = new Set<string>();
    for (const gap of gaps) {
      if (gap.resolution !== "ask_user") continue;
      const n = normalizeQuestion(gap.description);
      if (n === "" || asked.has(n) || declined.has(n) || inRound.has(n)) continue;
      inRound.add(n);
      const id = questionId(gap.description);
      questions.push({ id, question: gap.description.trim(), reason: questionReason(gap), required: gap.severity === "critical" });
      records.push([id, { question: gap.description.trim(), gapId: gap.id, category: gap.category, severity: gap.severity }]);
    }
    if (questions.length === 0) return undefined;

    const round = this.state.round + 1;
    const request: ClarificationRequest = {
      runId,
      round,
      maximumRounds: MAXIMUM_CLARIFICATION_ROUNDS,
      // Required questions first so the user sees blocking decisions before optional ones.
      questions: [...questions.filter((q) => q.required), ...questions.filter((q) => !q.required)],
      context,
    };
    this.state.round = round;
    this.state.requests.push(request);
    for (const [id, rec] of records) {
      this.state.questions[id] = { ...rec, round };
      this.state.askedQuestions.push(normalizeQuestion(rec.question));
    }
    return structuredClone(request);
  }

  /**
   * Record the user's response. Declined/skipped questions (and questions missing from the response,
   * or "answered" with an empty answer) become assumptions. Throws on runId/round mismatch, a response
   * to a round never asked, or question ids that do not belong to the round. Re-submitting an identical
   * response is idempotent.
   */
  recordResponse(response: ClarificationResponse): { answered: ClarificationAnswer[]; assumptions: Assumption[] } {
    const request = this.state.requests.find((r) => r.round === response.round);
    if (!request) {
      throw dsError("clarification", "clarification-manager", `Clarification round ${response.round} was never asked`, {
        runId: response.runId,
        recoverable: true,
        fallbackAction: "Resubmit the response for the pending round.",
      });
    }
    if (request.runId !== response.runId) {
      throw dsError("clarification", "clarification-manager", `Response runId ${response.runId} does not match round ${request.round} runId ${request.runId}`, {
        runId: request.runId,
        recoverable: true,
        fallbackAction: "Resubmit the response with the runId of the clarification request.",
      });
    }
    const previous = this.state.responses.find((r) => r.round === response.round);
    if (previous) {
      if (stableStringify(previous) !== stableStringify(response)) {
        throw dsError("clarification", "clarification-manager", `Clarification round ${response.round} already has a different response`, {
          runId: request.runId,
          recoverable: false,
        });
      }
      return this.outcomeFor(request, previous);
    }

    const ids = new Set(request.questions.map((q) => q.id));
    const foreign = response.answers.filter((a) => !ids.has(a.questionId)).map((a) => a.questionId);
    if (foreign.length > 0) {
      throw dsError("clarification", "clarification-manager", `Unknown question ids for round ${request.round}: ${foreign.join(", ")}`, {
        runId: request.runId,
        recoverable: true,
        fallbackAction: "Resubmit answers using the question ids from the clarification request.",
      });
    }

    this.state.responses.push(structuredClone(response));
    const result = this.outcomeFor(request, response);
    for (const a of response.answers) {
      if (a.status === "declined") {
        const n = normalizeQuestion(this.state.questions[a.questionId]?.question ?? "");
        if (n && !this.state.declinedQuestions.includes(n)) this.state.declinedQuestions.push(n);
      }
    }
    this.addAssumptions(result.assumptions);
    return result;
  }

  private outcomeFor(request: ClarificationRequest, response: ClarificationResponse): { answered: ClarificationAnswer[]; assumptions: Assumption[] } {
    const byQuestion = new Map(response.answers.map((a) => [a.questionId, a]));
    const answered: ClarificationAnswer[] = [];
    const assumptions: Assumption[] = [];
    for (const q of request.questions) {
      const a = byQuestion.get(q.id);
      if (a && a.status === "answered" && a.answer !== undefined && a.answer.trim() !== "") {
        answered.push({ questionId: q.id, answer: a.answer, status: "answered" });
        continue;
      }
      const status: "declined" | "skipped" = a?.status === "declined" ? "declined" : "skipped";
      const rec = this.state.questions[q.id];
      const category = rec?.category ?? "ambiguous_requirement";
      const severity = rec?.severity ?? (q.required ? "critical" : "optional");
      const how = status === "declined" ? "declined by the user" : a ? "skipped by the user" : "not answered";
      assumptions.push({
        id: assumptionId(q.id, status),
        questionId: q.id,
        statement: `Unconfirmed: "${q.question}" — ${conservativeDefault(category)}.`,
        basis: `Clarification question ${q.id} (round ${request.round}) was ${how}: "${q.question}"`,
        impact: IMPACT[severity],
        status,
      });
    }
    return { answered, assumptions };
  }

  /** Remaining `ask_user` gaps (unanswered, not already assumed) become `round_limit_reached` assumptions. */
  finalizeAtRoundLimit(gaps: ContextGap[]): Assumption[] {
    const answeredIds = new Set(this.answers().map((a) => a.questionId));
    const out: Assumption[] = [];
    for (const gap of gaps) {
      if (gap.resolution !== "ask_user") continue;
      const qid = questionId(gap.description);
      if (answeredIds.has(qid) || this.hasAssumptionFor(qid)) continue;
      out.push({
        id: assumptionId(qid, "round_limit_reached"),
        questionId: qid,
        statement: `Unconfirmed: "${gap.description.trim()}" — ${conservativeDefault(gap.category)}.`,
        basis: `The clarification round limit (${this.state.maximumRounds}) was reached before this question could be answered (gap ${gap.id}).`,
        impact: IMPACT[gap.severity],
        status: "round_limit_reached",
      });
    }
    return this.addAssumptions(out);
  }

  /**
   * Record `document_assumption` gaps as assumptions. These questions were deliberately not asked
   * (optional, or not material to the task), so they use status "skipped" — the closest fit in the
   * contract: the question was skipped rather than declined by the user or cut off by the round limit.
   * The single `missing_expertise` gap is not an assumption about the project and is excluded.
   */
  documentAssumptions(gaps: ContextGap[]): Assumption[] {
    const out: Assumption[] = [];
    for (const gap of gaps) {
      if (gap.resolution !== "document_assumption" || gap.category === "missing_expertise") continue;
      const qid = questionId(gap.description);
      if (this.hasAssumptionFor(qid)) continue;
      out.push({
        id: assumptionId(qid, "skipped"),
        questionId: qid,
        statement: `Unconfirmed: "${gap.description.trim()}" — ${conservativeDefault(gap.category)}.`,
        basis: `Not asked: ${gap.severity} ${gap.category.replace(/_/g, " ")} (gap ${gap.id}); documented as an assumption instead of a clarification question.`,
        impact: IMPACT[gap.severity],
        status: "skipped",
      });
    }
    return this.addAssumptions(out);
  }

  private hasAssumptionFor(qid: string): boolean {
    return this.state.assumptions.some((a) => a.questionId === qid);
  }

  private addAssumptions(list: Assumption[]): Assumption[] {
    for (const a of list) if (!this.state.assumptions.some((x) => x.id === a.id)) this.state.assumptions.push(a);
    return structuredClone(list);
  }

  /** Every assumption in the registry (declined, skipped, documented, round-limit). */
  assumptions(): Assumption[] {
    return structuredClone(this.state.assumptions);
  }

  /** Answers with status "answered" and a non-empty answer, across all rounds. */
  answers(): ClarificationAnswer[] {
    const out: ClarificationAnswer[] = [];
    for (const r of this.state.responses) {
      for (const a of r.answers) {
        if (a.status === "answered" && a.answer !== undefined && a.answer.trim() !== "") out.push({ ...a });
      }
    }
    return out;
  }

  /** Answered questions with their text, for feeding back into context analysis. */
  answeredQuestions(): Array<{ questionId: string; question: string; answer: string }> {
    return this.answers().map((a) => ({
      questionId: a.questionId,
      question: this.state.questions[a.questionId]?.question ?? a.questionId,
      answer: a.answer ?? "",
    }));
  }

  toJSON(): ClarificationState {
    return structuredClone(this.state);
  }
}
