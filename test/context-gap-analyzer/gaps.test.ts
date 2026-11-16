import { describe, it, expect } from "vitest";
import type { ContextAnalysisResult, SkillInventoryItem, TaskIntent } from "../../src/contracts/index.js";
import {
  analyzeContextGaps,
  assessSkillSufficiency,
  classifyQuestion,
  normalizeQuestion,
  questionId,
  SUFFICIENCY_THRESHOLD,
} from "../../src/context-gap-analyzer/index.js";
import { analysis, packet } from "../context-analyzer-contracts/fixtures.js";

const task: TaskIntent = {
  description: "Add Stripe webhook signature verification to the payments API",
  scope: ["src/payments"],
};

const skill = (name: string, description: string): SkillInventoryItem => ({ name, description, path: `.claude/skills/${name}`, scope: "project" });

function run(overrides: Partial<ContextAnalysisResult>, extra: { previouslyAsked?: string[]; declined?: string[]; skills?: SkillInventoryItem[] } = {}) {
  return analyzeContextGaps({
    task,
    analysis: analysis({ additionalContextRequests: [], ...overrides }),
    packet: packet(),
    existingSkills: extra.skills ?? [],
    ...(extra.previouslyAsked ? { previouslyAsked: extra.previouslyAsked } : {}),
    ...(extra.declined ? { declined: extra.declined } : {}),
  });
}

const work = (gaps: ReturnType<typeof run>["gaps"]) => gaps.filter((g) => g.resolution === "ask_user" || g.resolution === "targeted_discovery");

describe("assessSkillSufficiency", () => {
  it("does not count an unrelated skill", () => {
    const r = assessSkillSufficiency(task, [skill("react-component-styling", "Style React components with Tailwind and CSS modules.")]);
    expect(r.sufficient).toBe(false);
    expect(r.matches.every((m) => m.score < SUFFICIENCY_THRESHOLD)).toBe(true);
  });

  it("counts a closely matching skill and ranks it first", () => {
    const close = skill("stripe-webhooks", "Verify Stripe webhook signatures and handle payment events in the payments API.");
    const r = assessSkillSufficiency(task, [skill("react-component-styling", "Style React components."), close]);
    expect(r.sufficient).toBe(true);
    expect(r.matches[0]?.skill).toBe(close);
    expect(r.matches[0]!.score).toBeGreaterThanOrEqual(SUFFICIENCY_THRESHOLD);
  });

  it("a single shared generic term is not enough", () => {
    const r = assessSkillSufficiency(task, [skill("api-docs", "Write OpenAPI documentation for an API.")]);
    expect(r.sufficient).toBe(false);
  });

  it("is deterministic and handles empty inputs", () => {
    const skills = [skill("stripe-webhooks", "Stripe webhook signature verification for payments")];
    expect(assessSkillSufficiency(task, skills)).toEqual(assessSkillSufficiency(task, skills));
    expect(assessSkillSufficiency(task, [])).toEqual({ sufficient: false, matches: [] });
    expect(assessSkillSufficiency({ description: "the and of" }, skills).sufficient).toBe(false);
  });
});

describe("classifyQuestion", () => {
  it("separates intent, general expertise and project facts", () => {
    expect(classifyQuestion("Should invalid signatures return 400 or 401?", false)).toBe("user_intent");
    expect(classifyQuestion("What are the best practices for webhook signature verification?", false)).toBe("general_expertise");
    expect(classifyQuestion("How does HMAC verification work?", false)).toBe("general_expertise");
    expect(classifyQuestion("Where is the webhook secret configured?", false)).toBe("project_fact");
    expect(classifyQuestion("What does config/payments.json define for retries?", false)).toBe("project_fact");
    expect(classifyQuestion("What are the best practices in this repo for webhooks?", false)).toBe("project_fact");
    expect(classifyQuestion("Refund partially or fully on dispute?", false)).toBe("user_intent");
  });
});

describe("analyzeContextGaps", () => {
  it("asks the user about critical intent unknowns", () => {
    const r = run({ unknowns: [{ question: "Should invalid signatures return 400 or 401?", importance: "critical" }] });
    const ask = r.gaps.filter((g) => g.resolution === "ask_user");
    expect(ask).toEqual([
      expect.objectContaining({ category: "ambiguous_requirement", severity: "critical", description: "Should invalid signatures return 400 or 401?" }),
    ]);
    expect(r.requiresClarification).toBe(true);
    expect(r.requiresDiscovery).toBe(false);
  });

  it("does not ask for facts already present in packet evidence", () => {
    const r = run({
      unknowns: [
        { question: "Which test framework does the project use?", importance: "critical" },
        { question: "Which version of stripe is installed?", importance: "critical" },
      ],
    });
    expect(work(r.gaps)).toEqual([]);
    expect(r.requiresClarification).toBe(false);
    expect(r.requiresDiscovery).toBe(false);
  });

  it("does not create discovery or clarification work for general engineering expertise", () => {
    const r = run({
      unknowns: [
        { question: "What are the best practices for webhook signature verification?", importance: "critical" },
        { question: "How does HMAC-SHA256 work?", importance: "critical" },
      ],
    });
    expect(work(r.gaps)).toEqual([]);
    const expertise = r.gaps.filter((g) => g.category === "missing_expertise");
    expect(expertise).toHaveLength(1);
    expect(expertise[0]).toMatchObject({ resolution: "document_assumption", severity: "optional" });
    expect(expertise[0]!.description).toContain("best practices for webhook signature verification");
  });

  it("routes critical project-fact unknowns to targeted discovery with a request", () => {
    const r = run({ unknowns: [{ question: "What retry settings does config/payments.json define?", importance: "critical" }] });
    const d = r.gaps.find((g) => g.resolution === "targeted_discovery");
    expect(d).toMatchObject({ category: "missing_project_context", severity: "critical" });
    expect(d?.contextRequest).toMatchObject({ type: "configuration", path: "config/payments.json", priority: "required" });
    expect(r.requiresDiscovery).toBe(true);
    expect(r.requiresClarification).toBe(false);
  });

  it("attaches the analysis's own matching context request", () => {
    const req = { type: "dependency_details" as const, query: "stripe webhook secret", reason: "Find the webhook secret environment variable", priority: "optional" as const };
    const r = run({
      unknowns: [{ question: "Which environment variable holds the Stripe webhook secret?", importance: "critical" }],
      additionalContextRequests: [req],
    });
    const d = r.gaps.filter((g) => g.resolution === "targeted_discovery");
    expect(d).toHaveLength(1);
    expect(d[0]?.contextRequest).toEqual(req);
  });

  it("documents optional unknowns as assumptions", () => {
    const r = run({ unknowns: [{ question: "Should webhook events be logged at info level?", importance: "optional" }] });
    expect(work(r.gaps)).toEqual([]);
    expect(r.gaps.filter((g) => g.category !== "missing_expertise")).toEqual([
      expect.objectContaining({ category: "ambiguous_requirement", resolution: "document_assumption", severity: "optional" }),
    ]);
  });

  it("asks about conflicts touching the task and documents unrelated ones", () => {
    const r = run({
      conflicts: [
        { subject: "payments error format", observations: ["src/payments returns JSON errors", "AGENTS.md says plain text"], sources: ["src/payments/webhooks.ts", "AGENTS.md"] },
        { subject: "docs site theme", observations: ["dark", "light"], sources: ["docs/theme.json", "docs/site.json"] },
      ],
    });
    const conflicts = r.gaps.filter((g) => g.category === "conflicting_evidence");
    expect(conflicts.map((g) => g.resolution)).toEqual(["ask_user", "document_assumption"]);
    expect(conflicts[0]?.severity).toBe("important");
    expect(r.requiresClarification).toBe(true);
  });

  it("turns required context requests into targeted discovery and drops optional or redundant ones", () => {
    const r = run({
      additionalContextRequests: [
        { type: "source_file", path: "src/payments/stripe-client.ts", reason: "Need client construction", priority: "required" },
        { type: "directory_summary", path: "src/billing", reason: "Nice to have", priority: "optional" },
        { type: "source_file", path: "src/payments/webhooks.ts", reason: "Already in packet", priority: "required" },
      ],
    });
    const d = r.gaps.filter((g) => g.resolution === "targeted_discovery");
    expect(d).toHaveLength(1);
    expect(d[0]?.contextRequest?.path).toBe("src/payments/stripe-client.ts");
    expect(r.requiresDiscovery).toBe(true);
  });

  it("never re-asks previously asked or declined questions", () => {
    const q1 = "Should invalid signatures return 400 or 401?";
    const q2 = "Should failed verifications be alerted?";
    const r = run(
      { unknowns: [{ question: q1, importance: "critical" }, { question: q2, importance: "critical" }] },
      { previouslyAsked: [normalizeQuestion(q1)], declined: [normalizeQuestion(q2)] },
    );
    expect(work(r.gaps)).toEqual([]);
    expect(r.requiresClarification).toBe(false);
  });

  it("produces deterministic gap ids and de-duplicates repeated unknowns", () => {
    const overrides = {
      unknowns: [
        { question: "Should invalid signatures return 400 or 401?", importance: "critical" as const },
        { question: "should invalid signatures return 400 or 401", importance: "critical" as const },
      ],
    };
    const a = run(overrides);
    const b = run(overrides);
    expect(a).toEqual(b);
    expect(a.gaps.every((g) => /^gap_[0-9a-f]{12}$/.test(g.id))).toBe(true);
    expect(a.gaps.filter((g) => g.resolution === "ask_user")).toHaveLength(1);
    expect(new Set(a.gaps.map((g) => g.id)).size).toBe(a.gaps.length);
  });

  it("reports reuseExisting with a reuse_existing gap when an existing skill suffices", () => {
    const r = run({}, { skills: [skill("stripe-webhooks", "Verify Stripe webhook signatures for the payments API.")] });
    expect(r.reuseExisting).toBe(true);
    expect(r.gaps.filter((g) => g.category === "missing_expertise")).toEqual([
      expect.objectContaining({ resolution: "reuse_existing" }),
    ]);
  });

  it("question ids are stable across formatting differences", () => {
    expect(questionId("Should X happen?")).toBe(questionId("  should x   happen "));
    expect(questionId("Should X happen?")).toMatch(/^q_[0-9a-f]{12}$/);
  });
});
