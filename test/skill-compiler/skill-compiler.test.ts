import { describe, expect, it } from "vitest";
import type { SkillDraft } from "../../src/contracts/index.js";
import { DEFAULT_CONFIG, SCHEMA_VERSION } from "../../src/contracts/index.js";
import { METADATA_NAMESPACE, estimateTokens } from "../../src/core/index.js";
import {
  applyDeterministicFixes,
  buildCompilationPrompt,
  buildCompilationRequest,
  compileDeterministicDraft,
  isValidSkillName,
  parseEvidenceRefs,
  parseSkillMarkdown,
  renderSkill,
  toSkillName,
  uniqueSkillName,
} from "../../src/skill-compiler/index.js";
import { checkStructural } from "../../src/eval-engine/index.js";
import { ASSUMPTIONS, EVIDENCE, EXISTING_SKILLS, RUN_ID, TASK, makeAnalysis, makeEvalContext, makePacket } from "./fixtures.js";

function request() {
  return buildCompilationRequest({
    runId: RUN_ID,
    task: TASK,
    analysis: makeAnalysis(),
    gaps: [],
    assumptions: ASSUMPTIONS,
    existingSkills: EXISTING_SKILLS,
    config: DEFAULT_CONFIG,
  });
}

function baseDraft(overrides: Partial<SkillDraft> = {}): SkillDraft {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN_ID,
    name: "payments-refund-endpoint",
    description: "Implements refund endpoints in the payments API. Use when adding or changing refund routes.",
    specialist: { identity: "payments API engineer", responsibility: "Own the refund endpoint end to end." },
    authority: {
      ownership: ["Refund route and service code"],
      decisionRights: ["Request validation details"],
      boundaries: ["Do not change the charges flow"],
      accountability: ["Refund tests pass"],
    },
    workflow: ["Read the charges route", "Add the refund route", "Add tests"],
    projectConstraints: [{ statement: "Routes delegate to services", evidence: [EVIDENCE.routes.id, "src/services/payments.ts"] }],
    verification: ["pnpm test passes"],
    assumptions: ["asm_full_refund"],
    references: [{ fileName: "refund-flow.md", title: "Refund flow", content: "Details of the refund flow." }],
    ...overrides,
  };
}

const RENDER_CTX = { repositoryId: "repo_abc", contextFingerprint: "fp_1", now: new Date("2026-01-01T00:00:00Z"), assumptions: ASSUMPTIONS };

describe("toSkillName", () => {
  it.each([
    ["Add Payment Integration!", "add-payment-integration"],
    ["paymentService refactor", "payment-service-refactor"],
    ["Café  Ünïcode", "cafe-unicode"],
    ["--Leading and trailing--", "leading-and-trailing"],
    ["", "project-specialist"],
    ["!!!", "project-specialist"],
  ])("%s → %s", (input, expected) => {
    expect(toSkillName(input)).toBe(expected);
  });

  it("clamps to 64 characters and stays spec-valid", () => {
    const name = toSkillName("word ".repeat(40));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(isValidSkillName(name)).toBe(true);
    expect(isValidSkillName(toSkillName("x".repeat(100)))).toBe(true);
  });

  it("uniqueSkillName suffixes on case-insensitive collision", () => {
    expect(uniqueSkillName("code-review", ["Code-Review"])).toBe("code-review-2");
    expect(uniqueSkillName("code-review", ["code-review", "code-review-2"])).toBe("code-review-3");
    expect(uniqueSkillName("fresh", ["code-review"])).toBe("fresh");
    const long = uniqueSkillName("a".repeat(64), ["a".repeat(64)]);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("-2")).toBe(true);
  });
});

describe("buildCompilationRequest / buildCompilationPrompt", () => {
  it("takes the policy from config.generation and requires evidence", () => {
    const req = request();
    expect(req.compilationPolicy).toEqual({ targetTokenCount: 2000, maximumTokenCount: 5000, requireEvidence: true, portability: "agent-skills" });
    expect(req.context.runId).toBe(RUN_ID);
  });

  it("conveys responsibilities, authority model, avoid-list, grounding and output contract compactly", () => {
    const ids = makePacket().evidence.map((e) => e.id);
    const prompt = buildCompilationPrompt(request(), { evidenceIds: ids, skillDraftSchemaPath: "schemas/skill-draft.schema.json" });
    for (const s of [
      "schemas/skill-draft.schema.json",
      "JSON",
      "ownership",
      "decisionRights",
      "boundaries",
      "accountability",
      "workflow",
      "verification",
      "code-review",
      "asm_full_refund",
      "2000",
      "inferred",
      "observed",
      "Generic software-engineering advice",
      "Unsupported assumptions",
      TASK.description,
    ]) {
      expect(prompt).toContain(s);
    }
    for (const id of ids) expect(prompt).toContain(id);
    expect(estimateTokens(prompt)).toBeLessThan(1500);
  });
});

describe("compileDeterministicDraft", () => {
  it("builds a valid, grounded draft and omits ungroundable constraints", () => {
    const draft = compileDeterministicDraft(request(), makePacket());
    expect(isValidSkillName(draft.name)).toBe(true);
    expect(draft.description.length).toBeLessThanOrEqual(1024);
    expect(draft.description).toMatch(/Use when/);
    expect(draft.projectConstraints.length).toBeGreaterThanOrEqual(2);
    for (const c of draft.projectConstraints) expect(c.evidence.length).toBeGreaterThan(0);
    expect(draft.projectConstraints.some((c) => /GraphQL/.test(c.statement))).toBe(false);
    expect(draft.verification.join(" ")).toMatch(/vitest/);
    expect(draft.authority.boundaries.join(" ")).toMatch(/partial refunds/);
    expect(draft.assumptions).toEqual(["asm_full_refund"]);
  });

  it("avoids colliding with existing skill names", () => {
    const req = { ...request(), task: { description: "Code review" } };
    const draft = compileDeterministicDraft(req, makePacket());
    expect(draft.name).toBe("code-review-2");
  });
});

describe("applyDeterministicFixes", () => {
  it("normalises names, renames collisions, truncates descriptions and cleans lists (pure)", () => {
    const original = baseDraft({
      name: "Code Review",
      description: `${"refund ".repeat(200)}tail`,
      workflow: ["1. Read code", "Read code", "  ", "- Write tests"],
      projectConstraints: [
        { statement: "Routes delegate", evidence: [EVIDENCE.routes.id] },
        { statement: " routes delegate ", evidence: [EVIDENCE.payments.id, ""] },
        { statement: "", evidence: ["x"] },
      ],
      references: [
        { fileName: "../evil/Notes.TXT", title: "Notes", content: "x" },
        { fileName: "empty.md", title: "Empty", content: "  " },
      ],
    });
    const snapshot = structuredClone(original);
    const { draft, fixes } = applyDeterministicFixes(original, { existingNames: ["code-review"] });
    expect(original).toEqual(snapshot);
    expect(draft.name).toBe("code-review-2");
    expect(draft.description.length).toBeLessThanOrEqual(1024);
    expect(draft.description.endsWith("refund")).toBe(true);
    expect(draft.workflow).toEqual(["Read code", "Write tests"]);
    expect(draft.projectConstraints).toEqual([{ statement: "Routes delegate", evidence: [EVIDENCE.routes.id, EVIDENCE.payments.id] }]);
    expect(draft.references).toEqual([{ fileName: "notes.md", title: "Notes", content: "x" }]);
    expect(fixes.length).toBeGreaterThanOrEqual(4);
  });

  it("reports no fixes for a clean draft", () => {
    expect(applyDeterministicFixes(baseDraft(), { existingNames: [] }).fixes).toEqual([]);
  });
});

describe("renderSkill", () => {
  it("is deterministic: same input → same bytes and hash, independent of `now`", () => {
    const a = renderSkill(baseDraft(), RENDER_CTX);
    const b = renderSkill(baseDraft(), { ...RENDER_CTX, now: new Date("2030-05-05T00:00:00Z") });
    expect(a.artifactHash).toBe(b.artifactHash);
    expect(a.files).toEqual(b.files);
    expect(a.skillId).toBe(`payments-refund-endpoint@${a.artifactHash.slice(0, 12)}`);
    expect(renderSkill(baseDraft({ workflow: ["Other"] }), RENDER_CTX).artifactHash).not.toBe(a.artifactHash);
  });

  it("writes spec frontmatter with namespaced string metadata", () => {
    const skill = renderSkill(baseDraft(), { ...RENDER_CTX, contextFingerprint: "123456" });
    const parsed = parseSkillMarkdown(skill.files[0]?.content ?? "");
    expect(parsed.error).toBeUndefined();
    expect(Object.keys(parsed.frontmatter ?? {})).toEqual(["name", "description", "metadata"]);
    expect(parsed.frontmatter?.metadata).toEqual({
      [`${METADATA_NAMESPACE}.run-id`]: RUN_ID,
      [`${METADATA_NAMESPACE}.generator-version`]: "0.1.0",
      [`${METADATA_NAMESPACE}.skill-version`]: "1.0.0",
      [`${METADATA_NAMESPACE}.context-fingerprint`]: "123456",
    });
  });

  it("renders sections in order with parseable evidence refs and references", () => {
    const skill = renderSkill(baseDraft(), RENDER_CTX);
    const md = skill.files.find((f) => f.path === "SKILL.md")?.content ?? "";
    const headings = md.split("\n").filter((l) => l.startsWith("#"));
    expect(headings).toEqual([
      "# Payments Refund Endpoint",
      "## Role",
      "## Authority",
      "### Ownership",
      "### Decision rights",
      "### Boundaries",
      "### Accountability",
      "## Workflow",
      "## Project constraints",
      "## Verification",
      "## Assumptions",
      "## References",
    ]);
    const constraintLine = md.split("\n").find((l) => l.startsWith("- Routes delegate")) ?? "";
    expect(constraintLine).toBe(`- Routes delegate to services <sub>evidence: ${EVIDENCE.routes.id}, src/services/payments.ts</sub>`);
    expect(parseEvidenceRefs(constraintLine)).toEqual([EVIDENCE.routes.id, "src/services/payments.ts"]);
    expect(md).toContain("1. Read the charges route");
    expect(md).toContain("- `asm_full_refund`: Only full refunds are required");
    expect(md).toContain("- [Refund flow](references/refund-flow.md)");
    expect(skill.files.map((f) => f.path)).toEqual(["SKILL.md", "references/refund-flow.md"]);
    expect(skill.tokenCount).toBe(estimateTokens(md));
    expect(skill.provenance).toMatchObject({
      evidenceIds: [EVIDENCE.routes.id],
      assumptionIds: ["asm_full_refund"],
      createdAt: "2026-01-01T00:00:00.000Z",
      repositoryId: "repo_abc",
      skillVersion: "1.0.0",
    });
  });

  it("omits Assumptions and References sections when empty", () => {
    const draft = baseDraft();
    delete draft.assumptions;
    delete draft.references;
    const md = renderSkill(draft, RENDER_CTX).files[0]?.content ?? "";
    expect(md).not.toContain("## Assumptions");
    expect(md).not.toContain("## References");
  });

  it("round-trips through the structural check", () => {
    const skill = renderSkill(baseDraft(), RENDER_CTX);
    const result = checkStructural(skill, makeEvalContext());
    expect(result.status).toBe("pass");
  });
});

describe("parseSkillMarkdown", () => {
  it("reports missing frontmatter", () => {
    expect(parseSkillMarkdown("# Title\n").error).toMatch(/frontmatter/);
    expect(parseSkillMarkdown("---\nname: x\n").error).toMatch(/not closed/);
  });

  it("reports invalid YAML and non-mapping frontmatter", () => {
    expect(parseSkillMarkdown("---\nname: [unclosed\n---\nbody").error).toMatch(/YAML/);
    expect(parseSkillMarkdown("---\n- a\n- b\n---\nbody").error).toMatch(/mapping/);
  });

  it("handles CRLF and returns the body", () => {
    const parsed = parseSkillMarkdown("---\r\nname: x\r\ndescription: y\r\n---\r\n# Body\r\n");
    expect(parsed.frontmatter).toEqual({ name: "x", description: "y" });
    expect(parsed.body).toBe("# Body\n");
  });
});
