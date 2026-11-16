import type {
  Assumption,
  ContextAnalysisResult,
  ContextPacket,
  DiscoveryEvidence,
  GeneratedSkill,
  SkillInventoryItem,
  TaskIntent,
} from "../../src/contracts/index.js";
import { DEFAULT_CONFIG, SCHEMA_VERSION } from "../../src/contracts/index.js";
import { estimateTokens, evidenceId, hashSkillFiles } from "../../src/core/index.js";
import type { EvalContext } from "../../src/eval-engine/index.js";
import { collectKnownReferences } from "../../src/skill-compiler/index.js";

export const RUN_ID = "run_test000001";

function ev(providerId: string, kind: DiscoveryEvidence["kind"], source: string, claim: string): DiscoveryEvidence {
  return { id: evidenceId(providerId, kind, source, claim), providerId, kind, priority: "P0", claim, source, confidence: 1 };
}

export const EVIDENCE = {
  language: ev("manifest", "language", "tsconfig.json", "Uses TypeScript 5.6"),
  framework: ev("manifest", "framework", "package.json", "Uses express 4.19.2"),
  tests: ev("tooling", "test_configuration", "vitest.config.ts", "Tests run with vitest"),
  lint: ev("tooling", "tooling", "eslint.config.js", "Lints with eslint"),
  routes: ev(
    "instructions",
    "instructions",
    "AGENTS.md",
    "Route handlers live in src/routes and delegate to services in src/services",
  ),
  payments: ev("source", "source_file", "src/services/payments.ts", "Payments service wraps the Stripe client"),
};

export const AGENTS_MD = [
  "# Agent instructions",
  "",
  "- Route handlers live in src/routes and delegate to services in src/services",
  "- Always run pnpm test before committing any change to this repository",
  "- Never commit generated files from the dist directory into version control",
  "- Keep pull requests small and focused on a single change at a time please",
].join("\n");

export const TASK: TaskIntent = {
  description: "Add a refund endpoint to the payments API",
  expectedOutcome: "POST /payments/:id/refund issues a Stripe refund and returns 201",
};

export function makePacket(): ContextPacket {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN_ID,
    task: TASK,
    repository: { root: "/repo", repositoryId: "repo_abc" },
    technology: {
      languages: ["TypeScript"],
      runtimes: { node: "22" },
      frameworks: [{ name: "Express", version: "4.19.2", source: "package.json" }],
      packageManagers: ["pnpm"],
      tooling: ["vitest", "eslint"],
    },
    structure: { workspaces: [], relevantDirectories: ["src/routes", "src/services"], entrypoints: ["src/index.ts"] },
    instructions: [{ path: "AGENTS.md", content: AGENTS_MD }],
    configuration: [{ path: "package.json" }, { path: "tsconfig.json" }],
    existingSkills: [{ name: "code-review", description: "Review code changes for style issues", path: ".agents/skills/code-review" }],
    sourceFiles: [
      { path: "src/services/payments.ts", content: "export class Payments {}", truncated: false, reason: "task-relevant" },
      { path: "src/middleware/errors.ts", content: "export function problem() {}", truncated: false, reason: "task-relevant" },
    ],
    evidence: Object.values(EVIDENCE),
    discoveryLimits: { filesRead: 6, filesSkipped: 0, truncated: false, reasons: [] },
    estimatedTokens: 900,
  };
}

export function makeAnalysis(): ContextAnalysisResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN_ID,
    technology: { languages: ["TypeScript"], frameworks: ["Express"], runtimes: ["Node.js 22"], packageManagers: ["pnpm"] },
    architecture: {
      patterns: ["routes delegate to services"],
      moduleStructure: ["src/routes", "src/services"],
      conventions: [
        "Route handlers live in src/routes and delegate to services in src/services",
        "Errors are returned as RFC 7807 problem+json responses",
        "Use GraphQL federation for every new API", // no evidence: must be omitted by the fallback
      ],
      dependencies: ["express", "stripe", "zod"],
    },
    taskContext: {
      relevantComponents: ["src/routes/payments.ts", "src/services/payments.ts"],
      existingImplementations: ["src/routes/charges.ts"],
      constraints: ["Payments service wraps the Stripe client"],
      expectedOutcome: TASK.expectedOutcome,
    },
    evidence: [
      { claim: "Route handlers live in src/routes and delegate to services in src/services", source: EVIDENCE.routes.id, type: "observed" },
      { claim: "Errors are returned as RFC 7807 problem+json responses", source: "src/middleware/errors.ts", type: "observed" },
      { claim: "Payments service wraps the Stripe client", source: EVIDENCE.payments.id, type: "observed" },
    ],
    unknowns: [{ question: "Should partial refunds be supported?", importance: "critical" }],
    conflicts: [],
  };
}

export const ASSUMPTIONS: Assumption[] = [
  {
    id: "asm_full_refund",
    questionId: "q1",
    statement: "Only full refunds are required",
    basis: "User skipped the question",
    impact: "medium",
    status: "skipped",
  },
];

export const EXISTING_SKILLS: SkillInventoryItem[] = [
  { name: "code-review", description: "Review code changes for style issues", path: ".agents/skills/code-review", scope: "project" },
];

export function makeEvalContext(overrides: Partial<EvalContext> = {}): EvalContext {
  const known = collectKnownReferences(makePacket());
  return {
    task: TASK,
    analysis: makeAnalysis(),
    knownEvidenceIds: known.evidenceIds,
    knownPaths: known.paths,
    assumptionIds: new Set(ASSUMPTIONS.map((a) => a.id)),
    existingSkills: EXISTING_SKILLS,
    repositoryInstructions: [AGENTS_MD],
    policy: {
      targetTokenCount: DEFAULT_CONFIG.generation.targetSkillTokens,
      maximumTokenCount: DEFAULT_CONFIG.generation.maximumSkillTokens,
      requireEvidence: true,
      portability: "agent-skills",
    },
    ...overrides,
  };
}

/** Return a copy of the skill with SKILL.md transformed (hash/tokenCount recomputed). */
export function withSkillMd(skill: GeneratedSkill, transform: (content: string) => string): GeneratedSkill {
  return withFiles(skill, (files) => files.map((f) => (f.path === "SKILL.md" ? { ...f, content: transform(f.content) } : f)));
}

export function withFiles(skill: GeneratedSkill, transform: (files: GeneratedSkill["files"]) => GeneratedSkill["files"]): GeneratedSkill {
  const files = transform(skill.files.map((f) => ({ ...f })));
  const artifactHash = hashSkillFiles(files);
  const md = files.find((f) => f.path === "SKILL.md")?.content ?? "";
  return { ...skill, files, artifactHash, skillId: `${skill.name}@${artifactHash.slice(0, 12)}`, tokenCount: estimateTokens(md) };
}
