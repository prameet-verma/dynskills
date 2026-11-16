import { describe, it, expect } from "vitest";
import type { ValidationIssue } from "../../src/contracts/index.js";
import {
  normalizeSourceRef,
  validateClarificationResponse,
  validateContextAnalysisResult,
  validateContextRequest,
  validateSkillDraft,
} from "../../src/context-analyzer-contracts/index.js";
import { analysis, clarificationRequest, clarificationResponse, packet, RUN_ID, skillDraft } from "./fixtures.js";

type Issues = { issues: ValidationIssue[] };
const errors = (o: Issues) => o.issues.filter((i) => i.severity === "error");
const warnings = (o: Issues) => o.issues.filter((i) => i.severity === "warning");

describe("validateContextAnalysisResult", () => {
  it("accepts a valid result grounded in the packet", () => {
    const out = validateContextAnalysisResult(analysis(), packet());
    expect(out.issues).toEqual([]);
    expect(out.valid).toBe(true);
    expect(out.value?.runId).toBe(RUN_ID);
  });

  it("rejects an observed claim whose source is not in the packet", () => {
    const a = analysis();
    a.evidence.push({ claim: "Uses Redis for idempotency", source: "src/cache/redis.ts", type: "observed" });
    const out = validateContextAnalysisResult(a, packet());
    expect(out.valid).toBe(false);
    expect(out.value).toBeUndefined();
    expect(errors(out)).toEqual([expect.objectContaining({ path: "/evidence/3/source" })]);
  });

  it("only warns for an inferred claim with an unknown source", () => {
    const a = analysis();
    a.evidence.push({ claim: "Probably uses Redis", source: "src/cache/redis.ts", type: "inferred" });
    const out = validateContextAnalysisResult(a, packet());
    expect(out.valid).toBe(true);
    expect(warnings(out)).toEqual([expect.objectContaining({ path: "/evidence/3/source" })]);
  });

  it("resolves evidence ids, every packet path kind, and line suffixes", () => {
    const a = analysis({
      evidence: [
        { claim: "a", source: "ev_bbbbbbbbbbbb", type: "observed" },
        { claim: "b", source: "AGENTS.md", type: "observed" },
        { claim: "c", source: "./tsconfig.json", type: "observed" },
        { claim: "d", source: "src/payments/webhooks.ts:3", type: "observed" },
        { claim: "e", source: "src/payments/webhooks.ts#L1-L4", type: "observed" },
        { claim: "f", source: "vitest.config.ts", type: "observed" },
        { claim: "g", source: ".claude/skills/react-styling", type: "observed" },
        { claim: "h", source: "src/server.ts", type: "observed" },
      ],
    });
    expect(validateContextAnalysisResult(a, packet()).issues).toEqual([]);
    expect(normalizeSourceRef("./src\\a.ts:12-20")).toBe("src/a.ts");
  });

  it("rejects a runId mismatch", () => {
    const out = validateContextAnalysisResult(analysis({ runId: "run_other" }), packet());
    expect(out.valid).toBe(false);
    expect(errors(out)[0]?.path).toBe("/runId");
  });

  it("reports structural errors with JSON-pointer paths", () => {
    const a = analysis() as unknown as Record<string, unknown>;
    delete a.technology;
    a.extra = 1;
    (a.evidence as Array<Record<string, unknown>>)[0]!.confidence = 1.5;
    (a.evidence as Array<Record<string, unknown>>)[1]!.type = "assumed";
    a.schemaVersion = "2.0";
    const out = validateContextAnalysisResult(a, packet());
    expect(out.valid).toBe(false);
    const paths = errors(out).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["/technology", "/extra", "/evidence/0/confidence", "/evidence/1/type", "/schemaVersion"]));
  });

  it("rejects non-object input", () => {
    expect(validateContextAnalysisResult("nope", packet()).valid).toBe(false);
    expect(validateContextAnalysisResult(null, packet()).issues[0]?.path).toBe("/");
  });

  it("warns on unresolvable conflict sources", () => {
    const a = analysis({ conflicts: [{ subject: "Node version", observations: ["18", "20"], sources: ["package.json", ".nvmrc"] }] });
    const out = validateContextAnalysisResult(a, packet());
    expect(out.valid).toBe(true);
    expect(warnings(out)).toEqual([expect.objectContaining({ path: "/conflicts/0/sources/1" })]);
  });

  it("rejects context requests escaping the repository", () => {
    const a = analysis({ additionalContextRequests: [{ type: "source_file", path: "../secrets.txt", reason: "x", priority: "required" }] });
    const out = validateContextAnalysisResult(a, packet());
    expect(out.valid).toBe(false);
    expect(errors(out)[0]?.path).toBe("/additionalContextRequests/0/path");
  });
});

describe("validateSkillDraft", () => {
  const known = new Set(["ev_0123456789ab", "src/payments/webhooks.ts", "asm_111111111111"]);
  const opts = { runId: RUN_ID, knownReferences: known, requireEvidence: true };

  it("accepts a valid, grounded draft", () => {
    const out = validateSkillDraft(skillDraft(), opts);
    expect(out.issues).toEqual([]);
    expect(out.valid).toBe(true);
  });

  it("enforces name, description and reference file-name limits", () => {
    const out = validateSkillDraft(
      skillDraft({
        name: "Bad_Name",
        description: "x".repeat(1025),
        references: [{ fileName: "../escape.md", title: "t", content: "c" }],
      }),
      opts,
    );
    expect(errors(out).map((i) => i.path)).toEqual(expect.arrayContaining(["/name", "/description", "/references/0/fileName"]));
    expect(validateSkillDraft(skillDraft({ name: "a".repeat(65) }), opts).valid).toBe(false);
    expect(validateSkillDraft(skillDraft({ name: "-leading" }), opts).valid).toBe(false);
    expect(validateSkillDraft(skillDraft({ description: "" }), opts).valid).toBe(false);
  });

  it("requires grounded constraints when requireEvidence is true", () => {
    const draft = skillDraft({
      projectConstraints: [
        { statement: "Unsupported", evidence: ["ev_ffffffffffff"] },
        { statement: "No evidence", evidence: [] },
      ],
    });
    const strict = validateSkillDraft(draft, opts);
    expect(strict.valid).toBe(false);
    expect(errors(strict).map((i) => i.path)).toEqual(["/projectConstraints/0/evidence/0", "/projectConstraints/1/evidence"]);
    const lenient = validateSkillDraft(draft, { ...opts, requireEvidence: false });
    expect(lenient.valid).toBe(true);
    expect(warnings(lenient)).toHaveLength(2);
  });

  it("flags unknown assumption ids, duplicate references and runId mismatch", () => {
    const out = validateSkillDraft(
      skillDraft({
        runId: "run_x",
        assumptions: ["asm_999999999999"],
        references: [
          { fileName: "a.md", title: "A", content: "a" },
          { fileName: "a.md", title: "A", content: "a" },
        ],
      }),
      opts,
    );
    expect(errors(out).map((i) => i.path)).toEqual(expect.arrayContaining(["/runId", "/assumptions/0", "/references/1/fileName"]));
  });
});

describe("validateClarificationResponse", () => {
  it("accepts a response matching its request", () => {
    const out = validateClarificationResponse(clarificationResponse(), clarificationRequest());
    expect(out.issues).toEqual([]);
    expect(out.valid).toBe(true);
  });

  it("rejects runId/round mismatches, foreign question ids and empty answers", () => {
    const out = validateClarificationResponse(
      clarificationResponse({
        runId: "run_other",
        round: 2,
        answers: [
          { questionId: "q_aaaaaaaaaaaa", answer: "  ", status: "answered" },
          { questionId: "q_bbbbbbbbbbbb", status: "skipped" },
          { questionId: "q_zzzzzzzzzzzz", status: "skipped" },
        ],
      }),
      clarificationRequest(),
    );
    expect(out.valid).toBe(false);
    expect(errors(out).map((i) => i.path)).toEqual(["/runId", "/round", "/answers/0/answer", "/answers/2/questionId"]);
  });

  it("treats a missing required answer as an error and a missing optional one as a warning", () => {
    const missingRequired = validateClarificationResponse(
      clarificationResponse({ answers: [{ questionId: "q_bbbbbbbbbbbb", status: "declined" }] }),
      clarificationRequest(),
    );
    expect(missingRequired.valid).toBe(false);
    expect(errors(missingRequired)[0]?.message).toContain("q_aaaaaaaaaaaa");

    const missingOptional = validateClarificationResponse(
      clarificationResponse({ answers: [{ questionId: "q_aaaaaaaaaaaa", status: "declined" }] }),
      clarificationRequest(),
    );
    expect(missingOptional.valid).toBe(true);
    expect(warnings(missingOptional)).toHaveLength(1);
  });

  it("rejects an invalid status and unknown fields", () => {
    const out = validateClarificationResponse(
      { runId: RUN_ID, round: 1, answers: [{ questionId: "q_aaaaaaaaaaaa", status: "maybe", extra: true }] },
      clarificationRequest(),
    );
    expect(errors(out).map((i) => i.path)).toEqual(expect.arrayContaining(["/answers/0/status", "/answers/0/extra"]));
  });
});

describe("validateContextRequest", () => {
  it("accepts a targeted request", () => {
    expect(validateContextRequest({ type: "source_file", path: "src/a.ts", reason: "r", priority: "required" }).valid).toBe(true);
  });
  it("requires a path or query and a repository-relative path", () => {
    expect(validateContextRequest({ type: "source_file", reason: "r", priority: "required" }).issues[0]?.path).toBe("/");
    expect(validateContextRequest({ type: "source_file", path: "/etc/passwd", reason: "r", priority: "required" }).issues[0]?.path).toBe("/path");
    expect(validateContextRequest({ type: "everything", path: "a", reason: "r", priority: "required" }).valid).toBe(false);
  });
});
