import { describe, it, expect } from "vitest";
import type { ClarificationRequest, ContextGap } from "../../src/contracts/index.js";
import { ClarificationManager, type ClarificationState } from "../../src/clarification-manager/index.js";
import { questionId } from "../../src/context-gap-analyzer/index.js";
import { DynamicSkillsError } from "../../src/core/index.js";

const RUN = "run_111111111111";
let n = 0;
const gap = (description: string, over: Partial<ContextGap> = {}): ContextGap => ({
  id: `gap_${(n++).toString(16).padStart(12, "0")}`,
  category: "ambiguous_requirement",
  description,
  severity: "critical",
  resolution: "ask_user",
  ...over,
});

function answerAll(req: ClarificationRequest, status: "answered" | "declined" | "skipped" = "answered") {
  return {
    runId: req.runId,
    round: req.round,
    answers: req.questions.map((q) => ({ questionId: q.id, status, ...(status === "answered" ? { answer: "yes" } : {}) })),
  };
}

function expectDsError(fn: () => unknown, category: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DynamicSkillsError);
    expect((err as DynamicSkillsError).info.category).toBe(category);
    return;
  }
  throw new Error("expected a DynamicSkillsError");
}

describe("ClarificationManager.buildRequest", () => {
  it("consolidates only ask_user gaps into one request with deterministic ids", () => {
    const m = new ClarificationManager();
    const req = m.buildRequest(
      RUN,
      [
        gap("Should logging be enabled?", { severity: "important" }),
        gap("Should invalid signatures return 400 or 401?"),
        gap("Read config/a.json", { category: "missing_project_context", resolution: "targeted_discovery" }),
        gap("Optional thing", { severity: "optional", resolution: "document_assumption" }),
        gap("should invalid signatures return 400 or 401"),
      ],
      "Task: verify webhooks",
    );
    expect(req).toBeDefined();
    expect(req).toMatchObject({ runId: RUN, round: 1, maximumRounds: 3, context: "Task: verify webhooks" });
    expect(req!.questions.map((q) => q.question)).toEqual(["Should invalid signatures return 400 or 401?", "Should logging be enabled?"]);
    expect(req!.questions[0]).toMatchObject({ id: questionId("Should invalid signatures return 400 or 401?"), required: true });
    expect(req!.questions[1]!.required).toBe(false);
    expect(req!.questions.every((q) => q.reason.length > 0)).toBe(true);
    expect(m.roundsUsed).toBe(1);
  });

  it("returns undefined when there is nothing to ask", () => {
    const m = new ClarificationManager();
    expect(m.buildRequest(RUN, [gap("x", { resolution: "document_assumption" })], "")).toBeUndefined();
    expect(m.roundsUsed).toBe(0);
  });

  it("returns the pending request again until it is answered (idempotent)", () => {
    const m = new ClarificationManager();
    const a = m.buildRequest(RUN, [gap("Q1?")], "c");
    const b = m.buildRequest(RUN, [gap("Q2?")], "c");
    expect(b).toEqual(a);
    expect(m.roundsUsed).toBe(1);
    expectDsError(() => m.buildRequest("run_other", [gap("Q2?")], "c"), "clarification");
  });

  it("allows three rounds and rejects a fourth", () => {
    const m = new ClarificationManager();
    for (let round = 1; round <= 3; round++) {
      expect(m.canAskMore()).toBe(true);
      const req = m.buildRequest(RUN, [gap(`Question for round ${round}?`)], "c");
      expect(req?.round).toBe(round);
      m.recordResponse(answerAll(req!));
    }
    expect(m.canAskMore()).toBe(false);
    expect(m.buildRequest(RUN, [gap("Question for round 4?")], "c")).toBeUndefined();
    expect(m.roundsUsed).toBe(3);
  });

  it("clamps maximumRounds to the contract limit", () => {
    expect(new ClarificationManager({ maximumRounds: 10 }).maximumRounds).toBe(3);
    const none = new ClarificationManager({ maximumRounds: 0 });
    expect(none.canAskMore()).toBe(false);
    expect(none.buildRequest(RUN, [gap("Q?")], "c")).toBeUndefined();
  });
});

describe("ClarificationManager.recordResponse", () => {
  it("records answers and turns declined/skipped/missing questions into assumptions", () => {
    const m = new ClarificationManager();
    const req = m.buildRequest(
      RUN,
      [gap("Critical Q?"), gap("Important Q?", { severity: "important" }), gap("Missing Q?", { severity: "important" }), gap("Answered Q?")],
      "c",
    )!;
    const id = (q: string) => req.questions.find((x) => x.question === q)!.id;
    const out = m.recordResponse({
      runId: RUN,
      round: 1,
      answers: [
        { questionId: id("Critical Q?"), status: "declined" },
        { questionId: id("Important Q?"), status: "skipped" },
        { questionId: id("Answered Q?"), status: "answered", answer: "Yes" },
      ],
    });
    expect(out.answered).toEqual([{ questionId: id("Answered Q?"), answer: "Yes", status: "answered" }]);
    expect(out.assumptions).toEqual([
      expect.objectContaining({ questionId: id("Critical Q?"), status: "declined", impact: "high" }),
      expect.objectContaining({ questionId: id("Important Q?"), status: "skipped", impact: "medium" }),
      expect.objectContaining({ questionId: id("Missing Q?"), status: "skipped", impact: "medium" }),
    ]);
    for (const a of out.assumptions) {
      expect(a.id).toMatch(/^asm_[0-9a-f]{12}$/);
      expect(a.statement.length).toBeGreaterThan(0);
      expect(a.basis).toContain(a.questionId);
    }
    expect(m.assumptions()).toHaveLength(3);
    expect(m.answers()).toEqual(out.answered);
    expect(m.answeredQuestions()).toEqual([{ questionId: id("Answered Q?"), question: "Answered Q?", answer: "Yes" }]);
  });

  it("never asks a declined or previously asked question again", () => {
    const m = new ClarificationManager();
    const req = m.buildRequest(RUN, [gap("Declined Q?"), gap("Asked Q?")], "c")!;
    m.recordResponse({
      runId: RUN,
      round: 1,
      answers: [
        { questionId: req.questions[0]!.id, status: "declined" },
        { questionId: req.questions[1]!.id, status: "answered", answer: "ok" },
      ],
    });
    expect(m.toJSON().declinedQuestions).toEqual(["declined q"]);
    expect(m.buildRequest(RUN, [gap("Declined Q?"), gap("asked q")], "c")).toBeUndefined();
    expect(m.roundsUsed).toBe(1);
  });

  it("throws on runId mismatch, unknown rounds and foreign question ids", () => {
    const m = new ClarificationManager();
    const req = m.buildRequest(RUN, [gap("Q?")], "c")!;
    expectDsError(() => m.recordResponse({ ...answerAll(req), runId: "run_other" }), "clarification");
    expectDsError(() => m.recordResponse({ ...answerAll(req), round: 2 }), "clarification");
    expectDsError(() => m.recordResponse({ runId: RUN, round: 1, answers: [{ questionId: "q_000000000000", status: "skipped" }] }), "clarification");
    expect(new ClarificationManager().roundsUsed).toBe(0);
    expectDsError(() => new ClarificationManager().recordResponse(answerAll(req)), "clarification");
  });

  it("is idempotent for an identical resubmission and rejects a conflicting one", () => {
    const m = new ClarificationManager();
    const req = m.buildRequest(RUN, [gap("Q?")], "c")!;
    const first = m.recordResponse(answerAll(req, "declined"));
    expect(m.recordResponse(answerAll(req, "declined"))).toEqual(first);
    expect(m.assumptions()).toHaveLength(1);
    expectDsError(() => m.recordResponse(answerAll(req, "answered")), "clarification");
  });
});

describe("ClarificationManager assumptions", () => {
  it("finalizeAtRoundLimit turns unanswered ask_user gaps into round_limit_reached assumptions", () => {
    const m = new ClarificationManager({ maximumRounds: 1 });
    const answered = gap("Answered Q?");
    const declined = gap("Declined Q?", { severity: "important" });
    const req = m.buildRequest(RUN, [answered, declined], "c")!;
    m.recordResponse({
      runId: RUN,
      round: 1,
      answers: [
        { questionId: req.questions.find((q) => q.question === "Answered Q?")!.id, status: "answered", answer: "a" },
        { questionId: req.questions.find((q) => q.question === "Declined Q?")!.id, status: "declined" },
      ],
    });
    expect(m.canAskMore()).toBe(false);
    const late = gap("Late Q?", { severity: "important" });
    const out = m.finalizeAtRoundLimit([answered, declined, late, gap("Not asked", { resolution: "document_assumption" })]);
    expect(out).toEqual([expect.objectContaining({ questionId: questionId("Late Q?"), status: "round_limit_reached", impact: "medium" })]);
    expect(m.finalizeAtRoundLimit([late])).toEqual([]);
    expect(m.assumptions().map((a) => a.status).sort()).toEqual(["declined", "round_limit_reached"]);
  });

  it("documentAssumptions records document_assumption gaps as skipped, excluding missing_expertise", () => {
    const m = new ClarificationManager();
    const out = m.documentAssumptions([
      gap("Log at info level?", { severity: "optional", resolution: "document_assumption" }),
      gap("Compile expertise", { category: "missing_expertise", severity: "optional", resolution: "document_assumption" }),
      gap("Ask me", { resolution: "ask_user" }),
    ]);
    expect(out).toEqual([expect.objectContaining({ status: "skipped", impact: "low", questionId: questionId("Log at info level?") })]);
    expect(m.documentAssumptions([gap("Log at info level?", { severity: "optional", resolution: "document_assumption" })])).toEqual([]);
  });
});

describe("ClarificationManager state", () => {
  it("round-trips through JSON across process boundaries", () => {
    const a = new ClarificationManager();
    const req1 = a.buildRequest(RUN, [gap("First?")], "c")!;
    const state = JSON.parse(JSON.stringify(a.toJSON())) as ClarificationState;
    expect(state).toMatchObject({ round: 1, maximumRounds: 3, askedQuestions: ["first"] });

    const b = new ClarificationManager({ state });
    expect(b.roundsUsed).toBe(1);
    b.recordResponse(answerAll(req1, "skipped"));
    const req2 = b.buildRequest(RUN, [gap("First?"), gap("Second?")], "c")!;
    expect(req2.round).toBe(2);
    expect(req2.questions.map((q) => q.question)).toEqual(["Second?"]);

    const c = new ClarificationManager({ state: JSON.parse(JSON.stringify(b.toJSON())) as ClarificationState });
    expect(c.assumptions()).toEqual(b.assumptions());
    expect(c.toJSON()).toEqual(b.toJSON());
    // Mutating returned state does not affect the manager.
    const snap = c.toJSON();
    snap.round = 99;
    expect(c.roundsUsed).toBe(2);
  });
});
