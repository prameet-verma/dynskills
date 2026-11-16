import type {
  ClarificationRequest,
  ClarificationResponse,
  ContextAnalysisResult,
  ContextPacket,
  ContextRequest,
  SkillDraft,
} from "../../src/contracts/index.js";

export const RUN_ID = "run_abc123def456";

/** Hand-written, fully populated examples of each TS contract (typed, so they track the contracts). */
export function packet(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return {
    schemaVersion: "1.0",
    runId: RUN_ID,
    task: {
      description: "Add Stripe webhook signature verification to the payments API",
      scope: ["src/payments"],
      expectedOutcome: "Webhook requests with invalid signatures are rejected",
      constraints: ["Keep the public API unchanged"],
    },
    repository: { root: "/repo", repositoryId: "repo_1", revision: "abc123", workingDirectory: "/repo" },
    technology: {
      languages: ["TypeScript"],
      runtimes: { node: ">=20" },
      frameworks: [{ name: "express", version: "4.19.2", source: "package.json" }],
      packageManagers: ["pnpm"],
      tooling: ["vitest", "eslint"],
    },
    structure: {
      workspaces: ["."],
      relevantDirectories: ["src/payments"],
      entrypoints: ["src/server.ts"],
    },
    instructions: [{ path: "AGENTS.md", content: "Run pnpm test before committing." }],
    configuration: [{ path: "tsconfig.json", summary: "strict mode", content: "{\"strict\":true}" }],
    existingSkills: [{ name: "react-styling", description: "Style React components", path: ".claude/skills/react-styling" }],
    sourceFiles: [
      { path: "src/payments/webhooks.ts", content: "export function handle() {}", truncated: false, reason: "task-relevant: matched 'webhook'" },
    ],
    evidence: [
      {
        id: "ev_0123456789ab",
        providerId: "node",
        kind: "framework",
        priority: "P0",
        claim: "Uses Express 4.19.2 as the HTTP framework",
        source: "package.json",
        value: { name: "express", version: "4.19.2" },
        excerpt: "\"express\": \"4.19.2\"",
        line: 12,
        confidence: 1,
      },
      {
        id: "ev_aaaaaaaaaaaa",
        providerId: "node",
        kind: "test_configuration",
        priority: "P0",
        claim: "Uses Vitest as the test framework",
        source: "vitest.config.ts",
        confidence: 1,
      },
      {
        id: "ev_bbbbbbbbbbbb",
        providerId: "node",
        kind: "dependency",
        priority: "P1",
        claim: "Depends on stripe 14.0.0",
        source: "package.json",
        value: "14.0.0",
        confidence: 1,
      },
    ],
    discoveryLimits: { filesRead: 5, filesSkipped: 1, truncated: false, reasons: ["sensitive file skipped"] },
    estimatedTokens: 1234,
    ...overrides,
  };
}

export function contextRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    type: "configuration",
    path: "config/payments.json",
    query: "webhook secret name",
    reason: "Need the configured webhook secret key name",
    priority: "required",
    ...overrides,
  };
}

export function analysis(overrides: Partial<ContextAnalysisResult> = {}): ContextAnalysisResult {
  return {
    schemaVersion: "1.0",
    runId: RUN_ID,
    technology: { languages: ["TypeScript"], frameworks: ["Express 4.19"], runtimes: ["Node.js 20"], packageManagers: ["pnpm"] },
    architecture: {
      patterns: ["Route handlers in src/payments"],
      moduleStructure: ["src/payments: payment endpoints"],
      conventions: ["Errors are thrown as AppError"],
      dependencies: ["stripe"],
    },
    taskContext: {
      relevantComponents: ["src/payments"],
      existingImplementations: ["src/payments/webhooks.ts"],
      constraints: ["Keep the public API unchanged"],
      expectedOutcome: "Invalid signatures rejected with 400",
    },
    evidence: [
      { claim: "Express is the HTTP framework", source: "ev_0123456789ab", type: "observed", confidence: 1 },
      { claim: "Webhook handler exists", source: "src/payments/webhooks.ts", type: "observed" },
      { claim: "Handlers likely share middleware", source: "src/payments", type: "inferred", confidence: 0.6 },
    ],
    unknowns: [],
    conflicts: [],
    additionalContextRequests: [contextRequest({ priority: "optional" })],
    ...overrides,
  };
}

export function skillDraft(overrides: Partial<SkillDraft> = {}): SkillDraft {
  return {
    schemaVersion: "1.0",
    runId: RUN_ID,
    name: "stripe-webhook-verification",
    description: "Verify Stripe webhook signatures in this Express payments API. Use when adding or changing payment webhooks.",
    specialist: { identity: "Payment webhook engineer", responsibility: "Reject forged webhook requests" },
    authority: {
      ownership: ["src/payments/webhooks.ts"],
      decisionRights: ["Choose the verification middleware placement"],
      boundaries: ["Do not change the public API"],
      accountability: ["Tests cover valid and invalid signatures"],
    },
    workflow: ["Read the existing handler", "Add signature verification", "Add tests"],
    projectConstraints: [{ statement: "Use Express middleware", evidence: ["ev_0123456789ab", "src/payments/webhooks.ts"] }],
    verification: ["pnpm test"],
    assumptions: ["asm_111111111111"],
    references: [{ fileName: "project-conventions.md", title: "Conventions", content: "# Conventions\n" }],
    ...overrides,
  };
}

export function clarificationRequest(overrides: Partial<ClarificationRequest> = {}): ClarificationRequest {
  return {
    runId: RUN_ID,
    round: 1,
    maximumRounds: 3,
    questions: [
      { id: "q_aaaaaaaaaaaa", question: "Should invalid signatures return 400 or 401?", reason: "Open decision", required: true, options: ["400", "401"] },
      { id: "q_bbbbbbbbbbbb", question: "Should events be logged?", reason: "Optional", required: false },
    ],
    context: "Task: add webhook verification",
    ...overrides,
  };
}

export function clarificationResponse(overrides: Partial<ClarificationResponse> = {}): ClarificationResponse {
  return {
    runId: RUN_ID,
    round: 1,
    answers: [
      { questionId: "q_aaaaaaaaaaaa", answer: "400", status: "answered" },
      { questionId: "q_bbbbbbbbbbbb", status: "declined" },
    ],
    ...overrides,
  };
}
